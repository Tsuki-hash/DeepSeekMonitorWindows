//! 托盘图标、菜单与主面板显隐定位（从 lib.rs 拆出，评审 F-22）。
//!
//! 面板显隐事件：窗口隐藏不会卸载 WebView，前端的刷新定时器不会自己停；
//! 反过来，从托盘唤出窗口也不会触发 React 重渲染。两端都要靠事件对齐，
//! 否则会出现「打开面板看到旧数据、收进托盘还在后台轮询」。

use std::sync::{Mutex, OnceLock};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, Position, WebviewWindow,
};

use crate::window_pos;

struct TrayOverview {
    balance_item: MenuItem<tauri::Wry>,
    order: Mutex<BalanceOrder>,
}
#[derive(Default)]
struct BalanceOrder {
    session: u64,
    revision: u64,
}
impl BalanceOrder {
    fn begin(&mut self, clear: impl FnOnce() -> Result<(), String>) -> Result<u64, String> {
        let next = self
            .session
            .checked_add(1)
            .ok_or("托盘会话已耗尽，请重启应用")?;
        clear()?;
        self.session = next;
        self.revision = 0;
        Ok(next)
    }
    fn update(
        &mut self,
        session: u64,
        revision: u64,
        apply: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if session == 0 || session != self.session || revision <= self.revision {
            return Ok(());
        }
        apply()?;
        self.revision = revision;
        Ok(())
    }
}
fn set_balance_caption(
    app: &tauri::AppHandle,
    overview: &TrayOverview,
    caption: &str,
) -> Result<(), String> {
    overview
        .balance_item
        .set_text(caption)
        .map_err(|_| "托盘菜单更新失败")?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_tooltip(Some(format!("DeepSeek Monitor\n{caption}")))
            .map_err(|_| "托盘提示更新失败")?;
    }
    Ok(())
}
pub(crate) fn begin_balance_session(app: &tauri::AppHandle) -> Result<u64, String> {
    let overview = app.try_state::<TrayOverview>().ok_or("托盘尚未就绪")?;
    let mut order = overview.order.lock().map_err(|_| "托盘状态不可用")?;
    order.begin(|| set_balance_caption(app, &overview, "余额：尚未取得"))
}
pub fn balance_caption(
    total: Option<&str>,
    currency: Option<&str>,
    stale: bool,
) -> Result<String, String> {
    let Some(total) = total else {
        return Ok("余额：尚未取得".into());
    };
    let value = total.parse::<f64>().map_err(|_| "余额格式不可用")?;
    if !value.is_finite() || value.abs() > 1e15 {
        return Err("余额格式不可用".into());
    }
    let unit = match currency {
        Some("CNY") => "¥",
        Some("USD") => "$",
        _ => return Err("余额币种不可用".into()),
    };
    Ok(format!(
        "余额：{unit}{value:.2} · {}",
        if stale { "旧数据" } else { "最近成功" }
    ))
}
pub(crate) fn update_balance(
    app: &tauri::AppHandle,
    session: u64,
    revision: u64,
    total: Option<&str>,
    currency: Option<&str>,
    stale: bool,
) -> Result<(), String> {
    let caption = balance_caption(total, currency, stale)?;
    let overview = app.try_state::<TrayOverview>().ok_or("托盘尚未就绪")?;
    let mut order = overview.order.lock().map_err(|_| "托盘状态不可用")?;
    order.update(session, revision, || {
        set_balance_caption(app, &overview, &caption)
    })
}

const EVENT_MAIN_WINDOW_SHOWN: &str = "main-window-shown";
const EVENT_MAIN_WINDOW_HIDDEN: &str = "main-window-hidden";

/// 最近一次托盘图标所在矩形（物理坐标）。TrayIconEvent::Click 会带上图标在屏幕上的
/// 真实位置，它比「光标所在显示器的右下角」更可靠：多显示器时光标可能停在另一块屏上，
/// 旧逻辑会把面板放到错误的屏幕角落。
#[derive(Clone, Copy)]
struct TrayRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn tray_rect_store() -> &'static Mutex<Option<TrayRect>> {
    static STORE: OnceLock<Mutex<Option<TrayRect>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

fn remember_tray_rect(rect: TrayRect) {
    if let Ok(mut slot) = tray_rect_store().lock() {
        *slot = Some(rect);
    }
}

fn last_tray_rect() -> Option<TrayRect> {
    tray_rect_store().lock().ok().and_then(|slot| *slot)
}

fn position_near_tray(window: &WebviewWindow) -> tauri::Result<()> {
    // 定位锚点优先取托盘图标中心；托盘事件还没发生过（例如从菜单项「显示主面板」
    // 唤出）时退回光标位置。按锚点最近的工作区边贴靠（几何在 window_pos）。
    let anchor = last_tray_rect()
        .map(|rect| (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0))
        .or_else(|| {
            window
                .cursor_position()
                .ok()
                .map(|point| (point.x, point.y))
        })
        .ok_or(tauri::Error::WindowNotFound)?;

    let monitor = window
        .monitor_from_point(anchor.0, anchor.1)?
        .or(window.current_monitor()?)
        .or(window.primary_monitor()?)
        .ok_or(tauri::Error::WindowNotFound)?;

    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let size = window.outer_size()?;
    let margin = (12.0 * scale_factor).round() as i32;
    let area = window_pos::WorkArea {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width as i32,
        height: work_area.size.height as i32,
    };
    let (x, y) = window_pos::panel_origin(
        area,
        size.width as i32,
        size.height as i32,
        margin,
        anchor.0,
        anchor.1,
    );

    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))
}

/// 把主面板当前物理位置写入配置（隐藏到托盘与退出时调用），供下次唤出/启动时
/// 恢复到用户拖动后停留的位置。位置记忆是体验优化而非关键数据：任何失败都
/// 静默忽略，不影响显隐主流程。
fn persist_main_window_position(window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let _ = crate::config::edit_config(|config| {
        config.window_position = Some([position.x, position.y]);
        Ok(())
    });
}

/// 恢复主面板上次停留的位置。返回 `false` 表示没有可恢复的记录
/// （首次运行/从未记录）或记录的位置已不在任何显示器上
/// （显示器被拔掉、分辨率变化），调用方应回退到「贴靠托盘」定位。
pub(crate) fn restore_saved_position(window: &WebviewWindow) -> bool {
    let Ok(config) = crate::config::read_stored_config() else {
        return false;
    };
    let Some([x, y]) = config.window_position else {
        return false;
    };
    // 位置的左上角坐标必须仍落在某块显示器内，否则恢复出来的面板可能整个看不见
    let Ok(Some(_)) = window.monitor_from_point(x as f64, y as f64) else {
        return false;
    };
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .is_ok()
}

pub(crate) fn show_main_window(window: &WebviewWindow) {
    // 优先回到用户上次停留的位置；没有记录或记录失效时才按托盘附近定位
    if !restore_saved_position(window) {
        let _ = position_near_tray(window);
    }
    let _ = window.show();
    let _ = window.set_focus();
    // 通知前端：面板被唤出，立刻拉一次最新数据
    let _ = window.emit(EVENT_MAIN_WINDOW_SHOWN, ());
}

pub(crate) fn hide_main_window_inner(window: &WebviewWindow) -> Result<(), String> {
    // 隐藏前记住当前位置，下次唤出回到这里（用户手动拖动过的位置得以保留）
    persist_main_window_position(window);
    window.hide().map_err(|error| error.to_string())?;
    // 通知前端：面板已隐藏，停掉自动刷新定时器
    let _ = window.emit(EVENT_MAIN_WINDOW_HIDDEN, ());
    Ok(())
}

/// 装配托盘图标与菜单（lib.rs 的 setup 调用）。
pub(crate) fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let balance_item = MenuItem::with_id(app, "balance", "余额：尚未取得", false, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&show_item, &balance_item, &quit_item])?;
    app.manage(TrayOverview {
        balance_item,
        order: Mutex::new(BalanceOrder::default()),
    });

    let mut tray_builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("DeepSeek Monitor · 余额尚未取得")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
            }
            "quit" => {
                // 退出前记住主面板位置，下次启动回到原位
                if let Some(window) = app.get_webview_window("main") {
                    persist_main_window_position(&window);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 任何一次托盘点击都带着图标的实际矩形（左右键都有），先无条件记下来。
            // 右键走的是菜单路径「显示主面板」，也需要这个位置。
            let TrayIconEvent::Click {
                rect,
                button,
                button_state,
                ..
            } = event
            else {
                return;
            };

            let origin = rect.position.to_physical::<f64>(1.0);
            let size = rect.size.to_physical::<f64>(1.0);
            remember_tray_rect(TrayRect {
                x: origin.x,
                y: origin.y,
                width: size.width,
                height: size.height,
            });

            // 仅在左键“抬起”时切换；否则按下+抬起各触发一次，窗口会闪现后立即隐藏
            if button != MouseButton::Left || button_state != MouseButtonState::Up {
                return;
            }

            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
                let is_visible = window.is_visible().unwrap_or(false);
                if is_visible {
                    let _ = hide_main_window_inner(&window);
                } else {
                    show_main_window(&window);
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod overview_tests {
    use super::*;
    #[test]
    fn reload_accepts_new_session_clear_and_rejects_old_or_out_of_order_updates() {
        let mut order = BalanceOrder::default();
        let mut caption = String::new();
        let old = order.begin(|| Ok(())).unwrap();
        order
            .update(old, 40, || {
                caption = "old".into();
                Ok(())
            })
            .unwrap();
        let current = order
            .begin(|| {
                caption.clear();
                Ok(())
            })
            .unwrap();
        order
            .update(current, 1, || {
                caption = "new".into();
                Ok(())
            })
            .unwrap();
        order
            .update(current, 2, || {
                caption.clear();
                Ok(())
            })
            .unwrap();
        for (session, revision) in [(old, 100), (current, 1), (0, 100), (current + 1, 100)] {
            order
                .update(session, revision, || panic!("obsolete update applied"))
                .unwrap();
        }
        assert!(caption.is_empty());
        assert!(order
            .update(current, 3, || Err("native failure".into()))
            .is_err());
        order
            .update(current, 3, || {
                caption = "retry".into();
                Ok(())
            })
            .unwrap();
        assert_eq!(caption, "retry");
        assert!(order.begin(|| Err("clear failed".into())).is_err());
        assert_eq!(order.session, current);
    }
    #[test]
    fn 托盘标明最近成功与旧数据_清除不遗留数字() {
        assert_eq!(
            balance_caption(Some("19.62"), Some("CNY"), false).unwrap(),
            "余额：¥19.62 · 最近成功"
        );
        assert!(balance_caption(Some("0"), Some("CNY"), true)
            .unwrap()
            .contains("旧数据"));
        assert_eq!(
            balance_caption(None, None, false).unwrap(),
            "余额：尚未取得"
        );
        assert!(balance_caption(Some("SECRET"), Some("CNY"), false).is_err());
        assert!(balance_caption(Some("NaN"), Some("CNY"), false).is_err());
    }
}
