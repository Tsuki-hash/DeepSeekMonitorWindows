//! Optional desktop controls; fixed shortcut is registered by Rust only.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOptions {
    pub always_on_top: bool,
    pub shortcut_enabled: bool,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct DesktopState(pub Mutex<Option<String>>);

pub trait DesktopActions {
    fn pin(&self, enabled: bool) -> Result<(), String>;
    fn shortcut(&self, enabled: bool) -> Result<(), String>;
}
struct NativeActions<'a>(&'a AppHandle);
impl DesktopActions for NativeActions<'_> {
    fn pin(&self, enabled: bool) -> Result<(), String> {
        self.0
            .get_webview_window("main")
            .ok_or("主面板不可用")?
            .set_always_on_top(enabled)
            .map_err(|_| "置顶设置失败".into())
    }
    fn shortcut(&self, enabled: bool) -> Result<(), String> {
        let hotkeys = self.0.global_shortcut();
        let active = hotkeys.is_registered(shortcut());
        if active == enabled {
            return Ok(());
        }
        if enabled {
            hotkeys
                .register(shortcut())
                .map_err(|_| "快捷键 Ctrl + Alt + D 已被占用或无法注册".into())
        } else {
            hotkeys
                .unregister(shortcut())
                .map_err(|_| "无法取消快捷键，请重试".into())
        }
    }
}
pub fn transact(
    actions: &impl DesktopActions,
    old: (bool, bool),
    next: (bool, bool),
    save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    actions.pin(next.0)?;
    if let Err(error) = actions.shortcut(next.1) {
        if actions.pin(old.0).is_err() {
            return Err(format!("{error}；置顶恢复失败，请重试"));
        }
        return Err(error);
    }
    if let Err(error) = save() {
        let shortcut_restored = actions.shortcut(old.1).is_ok();
        let pin_restored = actions.pin(old.0).is_ok();
        return Err(if shortcut_restored && pin_restored {
            error
        } else {
            format!("{error}；桌面设置恢复失败，请重试")
        });
    }
    Ok(())
}
pub fn get(app: &AppHandle) -> Result<DesktopOptions, String> {
    let window = app.get_webview_window("main").ok_or("主面板不可用")?;
    Ok(DesktopOptions {
        always_on_top: window.is_always_on_top().map_err(|_| "无法读取置顶状态")?,
        shortcut_enabled: app.global_shortcut().is_registered(shortcut()),
        error: app
            .state::<DesktopState>()
            .0
            .lock()
            .map_err(|_| "桌面设置不可用")?
            .clone(),
    })
}
pub fn set(app: &AppHandle, pin: bool, enabled: bool) -> Result<DesktopOptions, String> {
    // Serialize system mutations and config commit, so rollback cannot undo another save.
    let runtime = app.state::<DesktopState>();
    let mut error = runtime.0.lock().map_err(|_| "桌面设置不可用")?;
    let window = app.get_webview_window("main").ok_or("主面板不可用")?;
    let old = (
        window.is_always_on_top().map_err(|_| "无法读取置顶状态")?,
        app.global_shortcut().is_registered(shortcut()),
    );
    transact(&NativeActions(app), old, (pin, enabled), || {
        crate::config::edit_config(|config| {
            config.always_on_top = pin;
            config.shortcut_enabled = enabled;
            Ok(())
        })
        .map(|_| ())
    })?;
    *error = None;
    drop(error);
    get(app)
}
pub fn restore(app: &AppHandle) {
    let result = crate::config::read_stored_config().and_then(|config| {
        NativeActions(app).pin(config.always_on_top)?;
        NativeActions(app).shortcut(config.shortcut_enabled)
    });
    if let Err(message) = result {
        if let Ok(mut error) = app.state::<DesktopState>().0.lock() {
            *error = Some(message);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Fake {
        pin: Cell<bool>,
        hotkey: Cell<bool>,
        conflict: bool,
    }
    impl DesktopActions for Fake {
        fn pin(&self, value: bool) -> Result<(), String> {
            self.pin.set(value);
            Ok(())
        }
        fn shortcut(&self, value: bool) -> Result<(), String> {
            if value && self.conflict {
                return Err("conflict".into());
            }
            self.hotkey.set(value);
            Ok(())
        }
    }
    #[test]
    fn 快捷键冲突不写配置并恢复置顶() {
        let fake = Fake {
            pin: Cell::new(false),
            hotkey: Cell::new(false),
            conflict: true,
        };
        let saved = Cell::new(false);
        assert!(transact(&fake, (false, false), (true, true), || {
            saved.set(true);
            Ok(())
        })
        .is_err());
        assert!(!fake.pin.get());
        assert!(!saved.get());
    }
    #[test]
    fn 保存失败恢复两个系统状态() {
        let fake = Fake {
            pin: Cell::new(true),
            hotkey: Cell::new(true),
            conflict: false,
        };
        assert!(transact(&fake, (true, true), (false, false), || Err(
            "write failed".into()
        ))
        .is_err());
        assert!(fake.pin.get());
        assert!(fake.hotkey.get());
    }
}
