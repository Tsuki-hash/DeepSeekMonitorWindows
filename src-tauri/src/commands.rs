//! Tauri 命令薄封装（从 lib.rs 拆出，评审 F-22）。
//!
//! 权限模型：除 `usage_token_captured` 仅限登录窗调用外，其余命令一律
//! `require_main`——命令层是远程登录窗能触达的最后防线（登录窗能力刻意
//! 只授予空权限集，见 `capabilities/login-sync.json`），**新增命令必须先过这一关**。

use tauri::{Emitter, Manager, WebviewWindow};

use crate::config::{
    edit_config, normalize_refresh_interval_seconds, read_stored_config, to_app_config, AppConfig,
};
use crate::deepseek_api::{
    fetch_balance_with_key, fetch_usage_with_token, BalanceResult, UsageResult,
};
use crate::error::CommandError;
use crate::sync_session::{ApiKeySession, SyncSession};
use crate::tray::hide_main_window_inner;
use crate::usage_watcher::{
    capture_usage_token, open_login_window, prescan_cached_token, spawn_title_watcher,
    verify_token_with_probes,
};

/// 敏感命令仅允许主面板窗口调用，防止远程登录页等非主窗口上下文滥用。
fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("非法调用方".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn hide_main_window(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    hide_main_window_inner(&window)
}

/// 复评 F11：前端完成草稿协商后由主窗口确认退出。
///
/// 托盘「退出」只发 quit intent（`tray::request_quit`），真正结束进程走这里 ——
/// 受 `require_main` 限制，只能由主窗口调用；无草稿或用户已保存/放弃时才到达。
#[tauri::command]
pub(crate) fn confirm_quit(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_main(&window)?;
    // 退出前记住主面板位置，下次启动回到原位。
    crate::tray::persist_position_for_exit(&window);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub(crate) fn is_main_window_visible(window: WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    Ok(window.is_visible().unwrap_or(true))
}

/// 面板尺寸模式。
///
/// 评审 P2：主窗口固定 356×600，适合托盘速览；消费与用量历史需要
/// 更宽的阅读区。这里只提供「紧凑 / 展开」两档，默认仍是紧凑，展开由用户显式触发。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PanelMode {
    Compact,
    Expanded,
}

#[tauri::command]
pub(crate) fn set_panel_mode(window: WebviewWindow, mode: PanelMode) -> Result<(), String> {
    require_main(&window)?;
    let (width, height): (f64, f64) = match mode {
        PanelMode::Compact => (356.0, 600.0),
        PanelMode::Expanded => (720.0, 760.0),
    };
    let monitor = window
        .current_monitor()
        .map_err(|_| "无法读取显示器信息")?
        .ok_or("无法读取显示器信息")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    // 复评 N03：最小值不得反向突破可用空间 —— 旧实现先 min(max_height) 再
    // max(480)，高 DPI 小屏幕（逻辑工作区不足 480 高）会把窗口撑出工作区。
    let max_width = (area.size.width as f64 / scale) - 24.0;
    let max_height = (area.size.height as f64 / scale) - 24.0;
    let width = width.min(max_width).max(320.0f64.min(max_width));
    let height = height.min(max_height).max(480.0f64.min(max_height));
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "调整面板尺寸失败")?;
    // 复评 N03：扩大尺寸后把**完整矩形**夹回目标显示器的工作区 ——
    // 右下角展开时只调尺寸会让右/下边界超出屏幕（评审示例：100% 缩放下
    // 最多右超 352px、下超 148px），右侧与底部控件不可见。
    let physical_width = (width * scale).round() as i32;
    let physical_height = (height * scale).round() as i32;
    let position = window.outer_position().map_err(|_| "无法读取窗口位置")?;
    let (x, y) = crate::window_pos::clamp_origin_into_area(
        crate::window_pos::WorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width as i32,
            height: area.size.height as i32,
        },
        physical_width,
        physical_height,
        position.x,
        position.y,
    );
    if x != position.x || y != position.y {
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x, y,
            )))
            .map_err(|_| "调整面板位置失败")?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_app_config(window: WebviewWindow) -> Result<AppConfig, String> {
    require_main(&window)?;
    crate::config::read_app_config()
}

#[tauri::command]
pub(crate) fn get_diagnostics(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    require_main(&window)?;
    let config = to_app_config(read_stored_config()?)?;
    Ok(serde_json::json!({
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "apiKeyConfigured": config.api_key_configured,
        "usageTokenConfigured": config.usage_token_configured,
        "autoRefreshEnabled": config.auto_refresh_enabled,
        "refreshIntervalSeconds": config.refresh_interval_seconds
    }))
}

#[tauri::command]
pub(crate) fn open_support_page(window: WebviewWindow, page: String) -> Result<(), String> {
    require_main(&window)?;
    let url = match page.as_str() {
        "releases" => "https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases",
        "issues" => "https://github.com/Tsuki-hash/DeepSeekMonitorWindows/issues",
        _ => return Err("未知支持页面".into()),
    };
    let explorer =
        std::path::PathBuf::from(std::env::var_os("WINDIR").ok_or("Windows 目录不可用")?)
            .join("explorer.exe");
    std::process::Command::new(explorer)
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn check_app_release(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::update_check::UpdateResult, String> {
    require_main(&window)?;
    crate::update_check::check(
        &app.package_info().version.to_string(),
        &app.state::<crate::update_check::UpdateCache>(),
    )
    .await
}

#[tauri::command]
pub(crate) fn get_alert_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::alerts::AlertStatus, String> {
    require_main(&window)?;
    crate::alerts::status(&app)
}
#[tauri::command]
pub(crate) fn save_alert_options(
    window: WebviewWindow,
    app: tauri::AppHandle,
    options: crate::alerts::AlertOptions,
) -> Result<crate::alerts::AlertStatus, String> {
    require_main(&window)?;
    crate::alerts::save_options(&app, options)
}
#[tauri::command]
pub(crate) fn test_alert_notification(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    crate::alerts::test_notification(&app)
}
#[tauri::command]
pub(crate) fn get_desktop_options(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::desktop::DesktopOptions, String> {
    require_main(&window)?;
    crate::desktop::get(&app)
}
#[tauri::command]
pub(crate) fn set_desktop_options(
    window: WebviewWindow,
    app: tauri::AppHandle,
    always_on_top: bool,
    shortcut_enabled: bool,
) -> Result<crate::desktop::DesktopOptions, String> {
    require_main(&window)?;
    crate::desktop::set(&app, always_on_top, shortcut_enabled)
}
#[tauri::command]
pub(crate) fn begin_tray_balance_session(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    require_main(&window)?;
    crate::tray::begin_balance_session(&app)
}
#[tauri::command]
pub(crate) fn update_tray_balance(
    window: WebviewWindow,
    app: tauri::AppHandle,
    session: u64,
    revision: u64,
    total: Option<String>,
    currency: Option<String>,
    stale: bool,
) -> Result<(), String> {
    require_main(&window)?;
    crate::tray::update_balance(
        &app,
        session,
        revision,
        total.as_deref(),
        currency.as_deref(),
        stale,
    )
}

#[tauri::command]
pub(crate) async fn save_api_key(
    window: WebviewWindow,
    app: tauri::AppHandle,
    api_key: String,
) -> Result<SavedApiKey, CommandError> {
    require_main(&window)?;
    let value = api_key.trim().to_string();
    if value.is_empty() {
        return Err("API Key 不能为空".into());
    }

    let generation = app.state::<ApiKeySession>().0.begin()?;
    // 错误种类由来源层给出，这里只补上下文文案，不用文案反推分类。
    let balance = fetch_balance_with_key(&value).await.map_err(|e| {
        CommandError::kind(
            format!("验证未通过，原 Key 未更改：{}", e.message),
            e.kind,
            Some("api_key"),
        )
    })?;
    let config = app.state::<ApiKeySession>().0.commit(generation, || {
        to_app_config(crate::config::edit_validated_credential(
            crate::config::ValidatedCredential::ApiKey,
            value,
        )?)
    })?;
    let _ = app.emit("credential-config-changed", &config);
    Ok(SavedApiKey { config, balance })
}

#[derive(serde::Serialize)]
pub(crate) struct SavedApiKey {
    config: AppConfig,
    balance: BalanceResult,
}

#[tauri::command]
pub(crate) fn clear_api_key(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    let config = app.state::<ApiKeySession>().0.cancel(|| {
        to_app_config(edit_config(|config| {
            config.api_key = None;
            Ok(())
        })?)
    })?;
    let _ = app.emit("credential-config-changed", &config);
    Ok(config)
}

#[tauri::command]
pub(crate) fn save_refresh_interval(
    window: WebviewWindow,
    refresh_interval_seconds: u64,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    to_app_config(edit_config(|config| {
        config.refresh_interval_seconds =
            normalize_refresh_interval_seconds(refresh_interval_seconds);
        Ok(())
    })?)
}

#[tauri::command]
pub(crate) fn save_auto_refresh_enabled(
    window: WebviewWindow,
    auto_refresh_enabled: bool,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    to_app_config(edit_config(|config| {
        config.auto_refresh_enabled = auto_refresh_enabled;
        Ok(())
    })?)
}

#[tauri::command]
pub(crate) fn save_autostart(window: WebviewWindow, autostart: bool) -> Result<AppConfig, String> {
    require_main(&window)?;
    let stored = crate::autostart::save_setting(autostart, || {
        edit_config(|config| {
            config.autostart = autostart;
            Ok(())
        })
    })?;
    to_app_config(stored)
}

// 实时查询 DeepSeek 账户余额。DeepSeek 官方仅提供余额接口，无用量接口。
#[tauri::command]
pub(crate) async fn fetch_balance(window: WebviewWindow) -> Result<BalanceResult, CommandError> {
    require_main(&window)?;
    let config = read_stored_config()?;
    let api_key = config
        .api_key
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::new("未配置 API Key".into(), Some("api_key")))?;
    fetch_balance_with_key(&api_key)
        .await
        .map_err(|e| CommandError::kind(e.message, e.kind, Some("api_key")))
}

#[tauri::command]
pub(crate) async fn save_usage_token(
    window: WebviewWindow,
    app: tauri::AppHandle,
    usage_token: String,
    request_id: String,
    superseded_request_ids: Vec<String>,
) -> Result<AppConfig, CommandError> {
    require_main(&window)?;
    let value = usage_token.trim().to_string();
    if value.is_empty() {
        return Err("用量 Token 不能为空".into());
    }
    let status = app.state::<SyncSession>().begin_usage(
        request_id,
        &superseded_request_ids,
        crate::sync_session::UsageSyncKind::Manual,
        || {
            if let Some(login) = app.get_webview_window("login-sync") {
                let _ = login.close();
            }
        },
    )?;
    let _ = app.emit("usage-sync-started", &status);
    let generation = status.generation;
    if let Err(error) = verify_token_with_probes(&value).await {
        crate::usage_watcher::end_sync_session(&app, generation);
        return Err(CommandError::new(
            format!("验证未通过，原 Token 未更改：{error}"),
            Some("usage_token"),
        ));
    }
    let result = capture_usage_token(&app, value, generation).map_err(Into::into);
    if result.is_err() {
        crate::usage_watcher::end_sync_session(&app, generation);
    }
    result
}

#[tauri::command]
pub(crate) fn clear_usage_token(
    window: WebviewWindow,
    app: tauri::AppHandle,
    cancelled_request_ids: Vec<String>,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    let config = app
        .state::<SyncSession>()
        .clear_usage(&cancelled_request_ids, || {
            if let Some(login) = app.get_webview_window("login-sync") {
                let _ = login.close();
            }
            to_app_config(edit_config(|config| {
                config.usage_token = None;
                Ok(())
            })?)
        })?;
    let _ = app.emit("credential-config-changed", &config);
    Ok(config)
}

#[tauri::command]
pub(crate) fn cancel_usage_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    generation: Option<u64>,
) -> Result<Option<crate::sync_session::UsageSyncStatus>, String> {
    require_main(&window)?;
    let ended = app
        .state::<SyncSession>()
        .cancel_usage(&request_id, generation, || {
            if let Some(login) = app.get_webview_window("login-sync") {
                let _ = login.close();
            }
        });
    if let Some(ended) = &ended {
        let _ = app.emit("usage-sync-ended", ended);
    }
    Ok(ended)
}

#[tauri::command]
pub(crate) fn get_usage_sync_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::sync_session::UsageSyncStatus, String> {
    require_main(&window)?;
    Ok(app.state::<SyncSession>().status())
}

#[tauri::command]
pub(crate) async fn forget_usage_session(
    window: WebviewWindow,
    app: tauri::AppHandle,
    cancelled_request_ids: Vec<String>,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    let config = app
        .state::<SyncSession>()
        .start_clear(&cancelled_request_ids, || {
            if let Some(login) = app.get_webview_window("login-sync") {
                login.close().map_err(|e| e.to_string())?;
            }
            to_app_config(edit_config(|stored| {
                stored.usage_token = None;
                Ok(())
            })?)
        })?;
    let _ = app.emit("usage-token-cleared", &config);
    crate::browsing_data::clear(&window).await?;
    Ok(config)
}

// 通过 DeepSeek 平台内部接口拉取用量与费用（需网页登录 token，非官方 API Key）。
#[tauri::command]
pub(crate) async fn fetch_usage(
    window: WebviewWindow,
    month: u32,
    year: u32,
) -> Result<UsageResult, CommandError> {
    require_main(&window)?;
    // 拒绝非法月份，避免把垃圾参数打进平台接口
    if !(1..=12).contains(&month) || !(2020..=2100).contains(&year) {
        return Err("非法的月份或年份".into());
    }
    let config = read_stored_config()?;
    let token = config
        .usage_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::new("未配置用量 Token".into(), Some("usage_token")))?;
    fetch_usage_with_token(&token, month, year)
        .await
        .map_err(|e| CommandError::kind(e.message, e.kind, Some("usage_token")))
}

#[tauri::command]
pub(crate) async fn start_usage_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    superseded_request_ids: Vec<String>,
) -> Result<UsageSyncStarted, String> {
    if window.label() != "main" {
        return Err("非法调用方".to_string());
    }
    let session = app.state::<SyncSession>();
    let mut status = session.begin_usage(
        request_id,
        &superseded_request_ids,
        crate::sync_session::UsageSyncKind::Web,
        || {
            if let Some(stale) = app.get_webview_window("login-sync") {
                let _ = stale.close();
            }
        },
    )?;
    let generation = status.generation;
    let _ = app.emit("usage-sync-started", &status);

    // 先扫一次缓存：登录完成后重复点击本命令，缓存落盘后即可命中。
    // 收集在 spawn_blocking（同步 IO 不占 async 工作线程），验证是异步请求，
    // 且候选先收集后验证——单个候选不会卡住其余候选（评审 F-25）。
    if let Some(token) = prescan_cached_token(&app, generation).await {
        if let Err(error) = capture_usage_token(&app, token, generation) {
            crate::usage_watcher::end_sync_session(&app, generation);
            return Err(error);
        }
        status.active = false;
        return Ok(UsageSyncStarted {
            status,
            synced: true,
        });
    }

    // 建窗和取消也共用会话锁，防止慢预扫描在取消后重新弹窗。
    // 建窗失败同样要释放会话，否则前端会一直停在「等待网页登录」。
    if let Err(error) = session.with_current(generation, || open_login_window(&app, generation)) {
        crate::usage_watcher::end_sync_session(&app, generation);
        return Err(error);
    }
    spawn_title_watcher(app.clone(), generation);
    Ok(UsageSyncStarted {
        status,
        synced: false,
    })
}

#[derive(serde::Serialize)]
pub(crate) struct UsageSyncStarted {
    #[serde(flatten)]
    status: crate::sync_session::UsageSyncStatus,
    synced: bool,
}

#[tauri::command]
pub(crate) async fn usage_token_captured(
    window: WebviewWindow,
    app: tauri::AppHandle,
    token: String,
    generation: u64,
) -> Result<AppConfig, String> {
    // 仅登录窗口可回传 token，防止主窗口以外的上下文滥用
    if window.label() != "login-sync" {
        return Err("非法调用方".to_string());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("platform.deepseek.com") {
        return Err("非法登录来源".into());
    }
    if !app.state::<SyncSession>().is_current(generation) {
        return Err("同步已取消".into());
    }
    let value = token.trim().to_string();
    if value.is_empty() {
        return Err("用量 Token 为空".to_string());
    }
    // 先验证再保存：拦截到的 token 可能是登录中途的临时 token。
    // 校验统一走东八区探针月（与预扫描/后台 watcher 一致），不再依赖
    // 登录窗口本地时区给出的月份
    verify_token_with_probes(&value).await?;
    capture_usage_token(&app, value, generation)
}
