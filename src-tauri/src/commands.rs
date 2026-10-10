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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageStatus {
    enabled: bool,
    snapshot: Option<crate::local_usage::LocalSnapshot>,
    busy: bool,
    last_error: Option<String>,
}
#[tauri::command]
pub(crate) fn get_local_sources(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::local_sources::SourceOptions, String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    if state.sources.is_none() {
        state.sources = Some(crate::local_sources::load()?);
    }
    Ok(state.sources.clone().unwrap())
}
#[tauri::command]
pub(crate) fn save_local_sources(
    window: WebviewWindow,
    app: tauri::AppHandle,
    options: crate::local_sources::SourceOptions,
) -> Result<crate::local_sources::SourceOptions, String> {
    require_main(&window)?;
    let options = crate::local_sources::validate_options(options)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    crate::local_sources::save(&options)?;
    state.sources = Some(options.clone());
    state.generation = state.generation.wrapping_add(1);
    state.snapshot = None;
    state.last_error = None;
    state.last_scan_failed = false;
    if let Some(cancel) = state.cancel.take() {
        cancel.notify_one();
    }
    crate::local_background::changed().notify_one();
    Ok(options)
}
#[tauri::command]
pub(crate) async fn list_running_wsl(
    window: WebviewWindow,
) -> Result<crate::local_sources::WslStatus, String> {
    require_main(&window)?;
    crate::local_sources::running_wsl().await
}
#[tauri::command]
pub(crate) fn save_local_archive(
    window: WebviewWindow,
    app: tauri::AppHandle,
    collected_at: u64,
    scope: crate::local_archive::ArchiveScope,
    include_paths: bool,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时钟不可用")?
        .as_millis() as u64;
    let snapshot = crate::local_archive::current_snapshot(&state, collected_at, now)?;
    crate::local_archive::capture(snapshot, &scope, include_paths, state.last_scan_failed, now)
}
#[tauri::command]
pub(crate) fn list_local_archives(
    window: WebviewWindow,
) -> Result<Vec<crate::local_archive::ArchiveSummary>, String> {
    require_main(&window)?;
    crate::local_archive::list()
}
#[tauri::command]
pub(crate) fn read_local_archive(
    window: WebviewWindow,
    id: String,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    crate::local_archive::read(&id)
}
#[tauri::command]
pub(crate) fn delete_local_archive(window: WebviewWindow, id: String) -> Result<(), String> {
    require_main(&window)?;
    crate::local_archive::delete(&id)
}
#[tauri::command]
pub(crate) fn clear_local_archives(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    crate::local_archive::clear()
}
fn local_preference_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-enabled.json"))
}
#[tauri::command]
pub(crate) fn get_local_retention_enabled(window: WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    crate::local_retention::enabled()
}
#[tauri::command]
pub(crate) fn set_local_retention_enabled(
    window: WebviewWindow,
    enabled: bool,
) -> Result<bool, String> {
    require_main(&window)?;
    crate::local_retention::set_enabled(enabled)
}
#[tauri::command]
pub(crate) fn list_local_retention(
    window: WebviewWindow,
) -> Result<Vec<crate::local_archive::ArchiveSummary>, String> {
    require_main(&window)?;
    crate::local_retention::list()
}
#[tauri::command]
pub(crate) fn read_local_retention(
    window: WebviewWindow,
    id: String,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    crate::local_retention::read(&id)
}
#[tauri::command]
pub(crate) fn delete_local_retention(window: WebviewWindow, id: String) -> Result<(), String> {
    require_main(&window)?;
    crate::local_retention::delete(&id)
}
#[tauri::command]
pub(crate) fn clear_local_retention(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    crate::local_retention::clear()
}
pub(crate) fn local_enabled(state: &mut crate::local_usage::LocalState) -> Result<bool, String> {
    if let Some(enabled) = state.enabled {
        return Ok(enabled);
    }
    let path = local_preference_path()?;
    let enabled = match std::fs::read(path) {
        Ok(data) => serde_json::from_slice::<bool>(&data)
            .map_err(|_| "本地用量设置损坏，请修复配置后重试")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("本地用量设置无法读取".into()),
    };
    state.enabled = Some(enabled);
    Ok(enabled)
}
#[tauri::command]
pub(crate) fn get_local_usage(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<LocalUsageStatus, String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    Ok(LocalUsageStatus {
        enabled: local_enabled(&mut state)?,
        snapshot: state.snapshot.clone(),
        busy: state.busy,
        last_error: state.last_error.clone(),
    })
}
#[tauri::command]
pub(crate) fn set_local_usage_enabled(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<LocalUsageStatus, String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    let path = local_preference_path()?;
    let parent = path.parent().ok_or("本地用量目录不可用")?;
    std::fs::create_dir_all(parent).map_err(|_| "本地用量设置无法保存")?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, if enabled { "true" } else { "false" })
        .map_err(|_| "本地用量设置无法保存")?;
    std::fs::rename(&temporary, &path).map_err(|_| "本地用量设置无法保存")?;
    state.generation = state.generation.wrapping_add(1);
    state.enabled = Some(enabled);
    state.snapshot = None;
    if let Some(cancel) = state.cancel.take() {
        cancel.notify_one();
    }
    state.last_error = None;
    crate::local_background::changed().notify_one();
    Ok(LocalUsageStatus {
        enabled,
        snapshot: None,
        busy: state.busy,
        last_error: None,
    })
}
#[tauri::command]
pub(crate) async fn scan_local_usage(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::local_usage::LocalSnapshot, String> {
    require_main(&window)?;
    collect_local_usage(&app, false)
        .await?
        .ok_or("采集未开始".into())
}
pub(crate) async fn collect_local_usage(
    app: &tauri::AppHandle,
    background: bool,
) -> Result<Option<crate::local_usage::LocalSnapshot>, String> {
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let (generation, cancel, sources) = {
        let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
        if background
            && (!local_enabled(&mut state)?
                || !crate::local_background::enabled(&mut state)?
                || state.busy)
        {
            return Ok(None);
        }
        if !local_enabled(&mut state)? {
            return Err("尚未启用本地用量".into());
        }
        if state.busy {
            return Err("正在采集，请稍后重试".into());
        }
        if state.sources.is_none() {
            state.sources = Some(crate::local_sources::load()?);
        }
        let sources = state.sources.clone().unwrap();
        state.busy = true;
        let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
        state.cancel = Some(cancel.clone());
        (state.generation, cancel, sources)
    };
    let resource = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("local-usage/tokscale.exe"));
    let path = if cfg!(debug_assertions) {
        Ok(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/local-usage/tokscale.exe"))
    } else {
        resource
    };
    let mut result = match path {
        Ok(path) => tokio::select! {
            result = crate::local_usage::run_sources(&path, &sources, app) => result,
            _ = cancel.notified() => Err("本地采集已停止".into()),
        },
        Err(_) => Err("采集引擎目录不可用".into()),
    };
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    state.busy = false;
    if generation != state.generation {
        return Err("本地采集设置已变化".into());
    }
    state.cancel = None;
    state.last_scan_failed = result.is_err();
    state.last_error = result.as_ref().err().cloned();
    if let Ok(snapshot) = &mut result {
        snapshot.retention_warning = crate::local_retention::checkpoint(snapshot).err();
        state.snapshot = Some(snapshot.clone());
    }
    result.map(Some)
}

#[tauri::command]
pub(crate) fn get_local_background(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::local_background::Status, String> {
    require_main(&window)?;
    crate::local_background::status(&app)
}
#[tauri::command]
pub(crate) fn set_local_background(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<crate::local_background::Status, String> {
    require_main(&window)?;
    {
        let collector = app.state::<crate::local_usage::LocalCollector>();
        let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
        if enabled && !local_enabled(&mut state)? {
            return Err("请先开启本地统计".into());
        }
        crate::local_background::save(&mut state, enabled)?;
    }
    crate::local_background::status(&app)
}

#[tauri::command]
pub(crate) fn hide_main_window(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    hide_main_window_inner(&window)
}

#[tauri::command]
pub(crate) fn is_main_window_visible(window: WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    Ok(window.is_visible().unwrap_or(true))
}

#[tauri::command]
pub(crate) fn get_app_config(window: WebviewWindow) -> Result<AppConfig, String> {
    require_main(&window)?;
    to_app_config(read_stored_config()?)
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
    let balance = fetch_balance_with_key(&value).await.map_err(|e| {
        CommandError::new(format!("验证未通过，原 Key 未更改：{e}"), Some("api_key"))
    })?;
    let config = app.state::<ApiKeySession>().0.commit(generation, || {
        to_app_config(crate::config::edit_validated_credential(
            crate::config::ValidatedCredential::ApiKey,
            value,
        )?)
    })?;
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
    app.state::<ApiKeySession>().0.cancel(|| {
        to_app_config(edit_config(|config| {
            config.api_key = None;
            Ok(())
        })?)
    })
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
        .map_err(|e| CommandError::new(e, Some("api_key")))
}

#[tauri::command]
pub(crate) async fn save_usage_token(
    window: WebviewWindow,
    app: tauri::AppHandle,
    usage_token: String,
) -> Result<AppConfig, CommandError> {
    require_main(&window)?;
    let value = usage_token.trim().to_string();
    if value.is_empty() {
        return Err("用量 Token 不能为空".into());
    }
    let generation = app.state::<SyncSession>().begin()?;
    if let Some(login) = app.get_webview_window("login-sync") {
        let _ = login.close();
    }
    verify_token_with_probes(&value).await.map_err(|e| {
        CommandError::new(
            format!("验证未通过，原 Token 未更改：{e}"),
            Some("usage_token"),
        )
    })?;
    capture_usage_token(&app, value, generation).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn clear_usage_token(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    app.state::<SyncSession>().cancel(|| {
        if let Some(login) = app.get_webview_window("login-sync") {
            let _ = login.close();
        }
        to_app_config(edit_config(|config| {
            config.usage_token = None;
            Ok(())
        })?)
    })
}

#[tauri::command]
pub(crate) fn cancel_usage_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    app.state::<SyncSession>().cancel(|| {
        if let Some(login) = app.get_webview_window("login-sync") {
            let _ = login.close();
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn forget_usage_session(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<AppConfig, String> {
    require_main(&window)?;
    let config = app.state::<SyncSession>().start_clear(|| {
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
        .map_err(|e| CommandError::new(e, Some("usage_token")))
}

#[tauri::command]
pub(crate) async fn start_usage_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("非法调用方".to_string());
    }
    let session = app.state::<SyncSession>();
    if session.active_generation().is_some() && app.get_webview_window("login-sync").is_some() {
        return Ok(false);
    }
    let generation = session.begin()?;

    // 先扫一次缓存：登录完成后重复点击本命令，缓存落盘后即可命中。
    // 收集在 spawn_blocking（同步 IO 不占 async 工作线程），验证是异步请求，
    // 且候选先收集后验证——单个候选失败不会卡住其余候选（评审 F-25）。
    if let Some(token) = prescan_cached_token(&app, generation).await {
        capture_usage_token(&app, token, generation)?;
        return Ok(true);
    }

    // 建窗和取消也共用会话锁，防止慢预扫描在取消后重新弹窗。
    session.with_current(generation, || open_login_window(&app, generation))?;
    spawn_title_watcher(app.clone(), generation);
    Ok(false)
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
