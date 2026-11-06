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

/// 本机数据总览：让用户在一个地方看到「哪些数据存在、多大、怎么清」。
///
/// 评审 P2：清除 Key、清除 Token、忘记登录、停止采集、清空归档各有不同作用，
/// 分散在多处容易让人误以为其中一个动作就删光了本机数据。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataOverview {
    api_key_configured: bool,
    usage_token_configured: bool,
    local_enabled: bool,
    local_collecting: bool,
    /// 归档/留存读取结果：区分「不存在（0）」「存在但读不出（unknown）」。
    /// `None` 表示无法读取 —— 磁盘数据可能仍在，不能显示成 0 条。
    archive_entries: Option<usize>,
    archive_error: Option<String>,
    retention_entries: Option<usize>,
    retention_bytes: Option<u64>,
    retention_error: Option<String>,
    /// `None` 表示读取失败或超出扫描预算 —— 不能显示成 0 KiB。
    engine_cache_bytes: Option<u64>,
    /// 引擎缓存可能包含源会话标题；停止采集不代表缓存被删。
    engine_cache_may_hold_titles: bool,
}

/// 引擎缓存大小的统计结果。
///
/// 复评 F13：缓存实际分布在「来源子目录」里，只看根目录会误报 0 KiB，
/// 让用户以为没有保留任何缓存。同时读取失败不能折算成 0 —— 那是「未知」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheSize {
    Known(u64),
    Unknown,
}

const CACHE_SCAN_MAX_ENTRIES: usize = 4096;
const CACHE_SCAN_MAX_DEPTH: usize = 4;

fn directory_size(path: &std::path::Path) -> CacheSize {
    // 有预算地递归统计：限制条目数与深度，且不跟随符号链接/junction，
    // 避免为了显示大小反而引入卡顿或越界扫描。
    fn walk(dir: &std::path::Path, depth: usize, entries_left: &mut usize) -> Result<u64, ()> {
        // 复评 R10：遍历不完整必须传播 Unknown，不能把「没扫到的子树」当成 0。
        if depth > CACHE_SCAN_MAX_DEPTH || *entries_left == 0 {
            return Err(());
        }
        let reader = std::fs::read_dir(dir).map_err(|_| ())?;
        let mut total = 0u64;
        for entry in reader {
            if *entries_left == 0 {
                return Err(());
            }
            *entries_left -= 1;
            let entry = entry.map_err(|_| ())?;
            let file_type = entry.file_type().map_err(|_| ())?;
            // 不跟随链接：junction/symlink 可能指向任意位置。
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                total = total.saturating_add(walk(&entry.path(), depth + 1, entries_left)?);
            } else if file_type.is_file() {
                let meta = entry.metadata().map_err(|_| ())?;
                total = total.saturating_add(meta.len());
            }
        }
        Ok(total)
    }
    match std::fs::metadata(path) {
        // 目录不存在：确实是 0 字节缓存（不是读取失败）。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CacheSize::Known(0),
        Err(_) => CacheSize::Unknown,
        Ok(meta) if !meta.is_dir() => CacheSize::Unknown,
        Ok(_) => {
            let mut budget = CACHE_SCAN_MAX_ENTRIES;
            walk(path, 0, &mut budget).map_or(CacheSize::Unknown, CacheSize::Known)
        }
    }
}

fn engine_cache_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-engine"))
}

#[tauri::command]
pub(crate) fn get_local_data_overview(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<LocalDataOverview, String> {
    require_main(&window)?;
    let config = to_app_config(read_stored_config()?)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    let local_enabled = local_enabled(&mut state)?;
    let local_collecting = state.busy;
    drop(state);
    // 复评 R11：读取失败不能折算成 0 条 —— 用户会据此误判「没有数据」。
    let (archive_entries, archive_error) = match crate::local_archive::list() {
        Ok(list) => (Some(list.len()), None),
        Err(error) => (None, Some(error)),
    };
    let (retention_entries, retention_bytes, retention_error) =
        match crate::local_retention::capacity() {
            Ok(value) => (Some(value.entries), Some(value.bytes), None),
            Err(error) => (None, None, Some(error)),
        };
    Ok(LocalDataOverview {
        api_key_configured: config.api_key_configured,
        usage_token_configured: config.usage_token_configured,
        local_enabled,
        local_collecting,
        archive_entries,
        archive_error,
        retention_entries,
        retention_bytes,
        retention_error,
        engine_cache_bytes: match engine_cache_path() {
            Ok(path) => match directory_size(&path) {
                CacheSize::Known(bytes) => Some(bytes),
                CacheSize::Unknown => None,
            },
            Err(_) => None,
        },
        engine_cache_may_hold_titles: true,
    })
}

/// 清理采集引擎缓存。
///
/// 只在采集**没有在进行**时允许，避免删掉正在写入的元数据；只删本应用目录，
/// 不触碰原工具日志，也不承诺取证级安全擦除。自动留存开启时，清空后新采集
/// 会重新产生记录，这一点由界面在确认框中说明。
#[tauri::command]
pub(crate) fn clear_local_engine_cache(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    // 复评 R18：路径解析必须在占用 busy **之前**完成。
    // 否则配置路径异常（APPDATA 缺失等）会让 `?` 提前返回，busy 永久残留，
    // 之后每次采集都被误判为「正在采集」。
    let path = engine_cache_path()?;
    {
        // 复评 F14：检查与删除必须共享同一把锁，否则释放后再删除的窗口里，
        // 后台采集可以开始写缓存，形成删除与写入竞态。
        // 这里在锁内把 busy 置位（占用采集槽位），删除完成后再释放。
        let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
        if state.busy {
            return Err("正在采集，请等待本轮结束后再清理引擎缓存".into());
        }
        // 占用采集槽位：后续 collect_local_usage 会因 busy 而拒绝启动。
        state.busy = true;
        state.generation = state.generation.wrapping_add(1);
        if let Some(cancel) = state.cancel.take() {
            cancel.notify_one();
        }
    }
    // 删除在锁外进行（避免跨 IO 持有同步 Mutex），但 busy 已置位，采集无法插队。
    let outcome = match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("引擎缓存无法清理，请稍后重试".into()),
    };
    // 释放槽位：即使上面的删除失败也要执行，保证下一次采集能开始。
    // 用 `map_err` 而不是 `?`：锁中毒时也要尽力清 busy，再返回错误。
    match collector.inner.lock() {
        Ok(mut state) => {
            state.busy = false;
            state.snapshot = None;
            state.last_error = None;
            state.last_scan_failed = false;
        }
        Err(_) => return Err("采集状态不可用，清理已中止；请重启应用".into()),
    }
    outcome
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
pub(crate) fn get_local_retention_capacity(
    window: WebviewWindow,
) -> Result<crate::local_retention::Capacity, String> {
    require_main(&window)?;
    crate::local_retention::capacity()
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
        // 留存是可选功能：失败不阻断统计。逐条策略下「部分写入」也要如实告诉用户，
        // 而不是只在整批失败时才提示。
        snapshot.retention_warning = match crate::local_retention::checkpoint(snapshot) {
            Ok(outcome) if outcome.failed => {
                Some("留存写入失败，已保存的旧记录未改动；当前统计仍可用".into())
            }
            Ok(outcome) if outcome.skipped > 0 => Some(format!(
                "留存已满：{} 条会话继续更新，{} 条新会话未保存；可导出后清理旧留存",
                outcome.written, outcome.skipped
            )),
            Ok(_) => None,
            Err(error) => Some(error),
        };
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

/// 面板尺寸模式。
///
/// 评审 P2：主窗口固定 356×600，适合托盘速览；历史、项目分析这类复杂任务需要
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
        .map_err(|e| CommandError::kind(e.message, e.kind, Some("api_key")))
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
        .map_err(|e| CommandError::kind(e.message, e.kind, Some("usage_token")))
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

    // 上一次同步超时后可能残留同名窗口（旧代际）。先清掉它再继续，
    // 否则建窗会失败或留下两个窗口；旧代际的迟到回传仍会被 commit 拒绝。
    if let Some(stale) = app.get_webview_window("login-sync") {
        log::warn!("发现残留的登录窗口，已在新同步开始前关闭");
        let _ = stale.close();
    }

    // 先扫一次缓存：登录完成后重复点击本命令，缓存落盘后即可命中。
    // 收集在 spawn_blocking（同步 IO 不占 async 工作线程），验证是异步请求，
    // 且候选先收集后验证——单个候选不会卡住其余候选（评审 F-25）。
    if let Some(token) = prescan_cached_token(&app, generation).await {
        capture_usage_token(&app, token, generation)?;
        return Ok(true);
    }

    // 建窗和取消也共用会话锁，防止慢预扫描在取消后重新弹窗。
    // 建窗失败同样要释放会话，否则前端会一直停在「等待网页登录」。
    if let Err(error) = session.with_current(generation, || open_login_window(&app, generation)) {
        crate::usage_watcher::end_sync_session(&app, generation);
        return Err(error);
    }
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
