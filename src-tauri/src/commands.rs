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

// All collector locks below protect memory only. Blocking workers own the slot,
// not the async waiter: cancelling an IPC/timeout cannot stop an OS filesystem call.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

const COLLECTION_BUDGET: Duration = Duration::from_secs(60);
const SETTINGS_BUDGET: Duration = Duration::from_secs(10);
const CHECKPOINT_WAIT_BUDGET: Duration = Duration::from_secs(5);
const LOAD_ENABLED: u8 = 1;
const LOAD_BACKGROUND: u8 = 2;
const LOAD_SOURCES: u8 = 4;
type SharedLocalState = Arc<Mutex<crate::local_usage::LocalState>>;

pub(crate) struct CollectionWorkerLease {
    state: SharedLocalState,
    generation: u64,
    cancelled: AtomicBool,
    deadline: tokio::time::Instant,
}
impl CollectionWorkerLease {
    fn active(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && tokio::time::Instant::now() < self.deadline
            && self
                .state
                .lock()
                .is_ok_and(|state| state.generation == self.generation && !state.shutting_down)
    }
    fn current(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire)
            && tokio::time::Instant::now() < self.deadline
            && self.state.lock().is_ok_and(|state| {
                state.generation == self.generation
                    && state.enabled == Some(true)
                    && !state.shutting_down
            })
    }
}
impl Drop for CollectionWorkerLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.busy = false;
            state.cancel = None;
        }
        crate::local_background::changed().notify_one();
    }
}
struct StopCollectionOnDrop(Arc<CollectionWorkerLease>);
impl Drop for StopCollectionOnDrop {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}
tokio::task_local! {
    static COLLECTION_WORKER: Arc<CollectionWorkerLease>;
}
/// Copy into every blocking worker before it starts. The final copy releases busy.
pub(crate) fn collection_worker_lease() -> Option<Arc<CollectionWorkerLease>> {
    COLLECTION_WORKER.try_with(Arc::clone).ok()
}

/// Dropping a wait future requests termination, but does not prove exit. Reap
/// the child in a separate task while retaining its collection/WSL ownership.
pub(crate) struct CollectionChild {
    child: Option<tokio::process::Child>,
    collection: Option<Arc<CollectionWorkerLease>>,
    permit: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}
impl CollectionChild {
    pub(crate) fn new(child: tokio::process::Child) -> Self {
        Self {
            child: Some(child),
            collection: collection_worker_lease(),
            permit: None,
        }
    }
    #[cfg(windows)]
    pub(crate) fn with_permit(mut self, permit: Arc<tokio::sync::OwnedSemaphorePermit>) -> Self {
        self.permit = Some(permit);
        self
    }
}
impl std::ops::Deref for CollectionChild {
    type Target = tokio::process::Child;
    fn deref(&self) -> &Self::Target {
        self.child.as_ref().expect("live child")
    }
}
impl std::ops::DerefMut for CollectionChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.child.as_mut().expect("live child")
    }
}
impl Drop for CollectionChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if child.id().is_none() {
            return;
        }
        let _ = child.start_kill();
        let collection = self.collection.take();
        let permit = self.permit.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _collection = collection;
                let _permit = permit;
                let _ = child.wait().await;
            });
        }
        // During runtime shutdown kill_on_drop still owns termination; there
        // can be no subsequent collection in that shutting-down runtime.
    }
}

#[derive(Clone)]
pub(crate) struct LocalSettings {
    pub generation: u64,
    pub enabled: Option<bool>,
    pub background_enabled: Option<bool>,
    pub sources: Option<crate::local_sources::SourceOptions>,
}
fn settings_view(state: &crate::local_usage::LocalState) -> LocalSettings {
    LocalSettings {
        generation: state.generation,
        enabled: state.enabled,
        background_enabled: state.background_enabled,
        sources: state.sources.clone(),
    }
}
fn settings_read_permit() -> Arc<tokio::sync::Semaphore> {
    static PERMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    PERMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
}
async fn load_local_settings(app: &tauri::AppHandle, fields: u8) -> Result<LocalSettings, String> {
    load_local_settings_shared(
        app.state::<crate::local_usage::LocalCollector>()
            .inner
            .clone(),
        fields,
    )
    .await
}
async fn load_local_settings_shared(
    shared: SharedLocalState,
    fields: u8,
) -> Result<LocalSettings, String> {
    let deadline = tokio::time::Instant::now() + SETTINGS_BUDGET;
    let cached_settings = || -> Result<LocalSettings, String> {
        let state = shared.lock().map_err(|_| "采集状态不可用")?;
        if state.settings_busy {
            return Err("本地设置正在保存或清理，请稍后重试".into());
        }
        Ok(settings_view(&state))
    };
    let missing = |cached: &LocalSettings| {
        (fields & LOAD_ENABLED != 0 && cached.enabled.is_none())
            || (fields & LOAD_BACKGROUND != 0 && cached.background_enabled.is_none())
            || (fields & LOAD_SOURCES != 0 && cached.sources.is_none())
    };
    let cached = cached_settings()?;
    if !missing(&cached) {
        return Ok(cached);
    }
    // Initial panel, sources and background requests arrive together. Wait on
    // the async semaphore rather than treating ordinary overlap as failure.
    let permit = tokio::time::timeout_at(deadline, settings_read_permit().acquire_owned())
        .await
        .map_err(|_| "本地设置读取超时，请稍后重试")?
        .map_err(|_| "本地设置读取不可用")?;
    // A previous reader/mutation may have changed the cache while we waited.
    let cached = cached_settings()?;
    if !missing(&cached) {
        return Ok(cached);
    }
    let collection = collection_worker_lease();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let check_current = || -> Result<(), String> {
            if collection.as_ref().is_some_and(|lease| !lease.active())
                || !shared.lock().is_ok_and(|state| {
                    state.generation == cached.generation && !state.settings_busy
                })
            {
                return Err("本地设置读取已取消或设置已变化".into());
            }
            Ok(())
        };
        let mut loaded = crate::local_usage::LocalState {
            enabled: cached.enabled,
            background_enabled: cached.background_enabled,
            sources: cached.sources,
            ..Default::default()
        };
        if fields & LOAD_ENABLED != 0 {
            #[cfg(test)]
            collection_test_stage("enabled-read");
            check_current()?;
            local_enabled(&mut loaded)?;
        }
        if fields & LOAD_BACKGROUND != 0 {
            #[cfg(test)]
            collection_test_stage("background-read");
            check_current()?;
            crate::local_background::enabled(&mut loaded)?;
        }
        if fields & LOAD_SOURCES != 0 && loaded.sources.is_none() {
            #[cfg(test)]
            collection_test_stage("sources-read");
            check_current()?;
            loaded.sources = Some(crate::local_sources::load()?);
        }
        let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
        if state.generation != cached.generation || state.settings_busy {
            return Err("本地设置已变化，请重读状态".into());
        }
        if fields & LOAD_ENABLED != 0 {
            state.enabled = loaded.enabled;
        }
        if fields & LOAD_BACKGROUND != 0 {
            state.background_enabled = loaded.background_enabled;
        }
        if fields & LOAD_SOURCES != 0 {
            state.sources = loaded.sources;
        }
        Ok(settings_view(&state))
    });
    tokio::time::timeout_at(deadline, task)
        .await
        .map_err(|_| "本地设置读取超时；系统读取尚未返回，请稍后重试".to_string())?
        .map_err(|_| "本地设置读取任务失败".to_string())?
}
pub(crate) async fn background_settings(app: &tauri::AppHandle) -> Result<LocalSettings, String> {
    let settings = load_local_settings(app, LOAD_ENABLED | LOAD_BACKGROUND).await?;
    if settings.enabled == Some(true) && settings.background_enabled == Some(true) {
        load_local_settings(app, LOAD_ENABLED | LOAD_BACKGROUND | LOAD_SOURCES).await
    } else {
        Ok(settings)
    }
}

fn invalidate_collection(state: &mut crate::local_usage::LocalState, clear_snapshot: bool) {
    state.generation = state.generation.wrapping_add(1);
    if clear_snapshot {
        state.snapshot = None;
    }
    state.last_error = None;
    state.last_scan_failed = false;
    if let Some(cancel) = state.cancel.as_ref() {
        cancel.notify_one();
    }
}
fn begin_local_shutdown(shared: &SharedLocalState) {
    if let Ok(mut state) = shared.lock() {
        state.shutting_down = true;
        invalidate_collection(&mut state, true);
        state.enabled = Some(false);
        state.background_enabled = Some(false);
    }
}
fn commit_local_enabled(shared: &SharedLocalState, enabled: bool) -> Result<(), String> {
    let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
    // The authorized preference write may finish while exiting, but it must
    // never restart this process's collector during slow window-position I/O.
    if !state.shutting_down {
        state.enabled = Some(enabled);
    }
    state.stop_save_pending = false;
    Ok(())
}
fn commit_background_enabled(shared: &SharedLocalState, enabled: bool) -> Result<(), String> {
    let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
    if !state.shutting_down {
        state.background_enabled = Some(enabled);
    }
    state.background_stop_save_pending = false;
    Ok(())
}
struct SettingsMutation {
    state: SharedLocalState,
    app: Option<tauri::AppHandle>,
}
impl Drop for SettingsMutation {
    fn drop(&mut self) {
        let generation = self.state.lock().ok().map(|mut state| {
            state.settings_busy = false;
            state.generation
        });
        crate::local_background::changed().notify_one();
        if let (Some(app), Some(generation)) = (&self.app, generation) {
            // No paths, snapshots or secrets. Listeners re-read their own state;
            // this also reaches a new page after the originating IPC timed out.
            let _ = app.emit("local-settings-changed", generation);
        }
    }
}
fn begin_local_mutation(
    app: &tauri::AppHandle,
    clear_snapshot: bool,
) -> Result<SettingsMutation, String> {
    let mut mutation = begin_local_mutation_shared(
        app.state::<crate::local_usage::LocalCollector>()
            .inner
            .clone(),
        clear_snapshot,
    )?;
    mutation.app = Some(app.clone());
    Ok(mutation)
}
fn begin_local_mutation_shared(
    shared: SharedLocalState,
    clear_snapshot: bool,
) -> Result<SettingsMutation, String> {
    {
        let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
        if state.shutting_down {
            return Err("应用正在退出，本地设置不再接受新操作".into());
        }
        if state.settings_busy {
            return Err("本地设置仍在保存或清理，请稍后重试".into());
        }
        state.settings_busy = true;
        // Invalidate before waiting on any disk/retention lock. A rename already
        // entered may finish; mutation success waits for its retention barrier.
        invalidate_collection(&mut state, clear_snapshot);
    }
    Ok(SettingsMutation {
        state: shared,
        app: None,
    })
}
async fn local_mutation<T, F>(mutation: SettingsMutation, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&SharedLocalState) -> Result<T, String> + Send + 'static,
{
    local_mutation_with_budget(mutation, SETTINGS_BUDGET, work).await
}
async fn local_mutation_with_budget<T, F>(
    mutation: SettingsMutation,
    budget: Duration,
    work: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&SharedLocalState) -> Result<T, String> + Send + 'static,
{
    let task = tokio::task::spawn_blocking(move || {
        let result = work(&mutation.state);
        if let Err(error) = &result {
            if let Ok(mut state) = mutation.state.lock() {
                state.last_error = Some(error.clone());
            }
        }
        // Keep settings_busy, even if the async caller has already timed out.
        drop(mutation);
        result
    });
    tokio::time::timeout(budget, task)
        .await
        .map_err(|_| {
            "本地保存或清理仍在进行，尚未确认完成；请稍后重读状态，不要重复提交".to_string()
        })?
        .map_err(|_| "本地保存或清理任务失败".to_string())?
}
async fn local_data_io<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    static READS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let deadline = tokio::time::Instant::now() + SETTINGS_BUDGET;
    let semaphore = READS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone();
    let permit = tokio::time::timeout_at(deadline, semaphore.acquire_owned())
        .await
        .map_err(|_| "本地数据读取等待超时，请稍后重试")?
        .map_err(|_| "本地数据读取不可用")?;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    tokio::time::timeout_at(deadline, task)
        .await
        .map_err(|_| "本地数据操作仍在进行，尚未确认完成；请稍后重读状态".to_string())?
        .map_err(|_| "本地数据操作任务失败".to_string())?
}
// Manual archive writes have no collection deadline. Keep their response tied
// to the real commit instead of introducing an uncertain timed-out write into
// the archive UI, while still moving all disk work off the async/IPC thread.
async fn archive_mutation_io<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    static WRITES: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = WRITES
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "手动归档仍在保存或清理，请稍后重试")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| "手动归档任务失败".to_string())?
}
fn local_status(state: &crate::local_usage::LocalState) -> LocalUsageStatus {
    LocalUsageStatus {
        generation: state.generation,
        enabled: state.enabled.unwrap_or(false),
        stop_save_pending: state.stop_save_pending,
        snapshot: state.snapshot.clone(),
        busy: state.busy || state.settings_busy,
        settings_pending: state.settings_busy,
        last_error: state.last_error.clone(),
    }
}

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
    generation: u64,
    enabled: bool,
    stop_save_pending: bool,
    snapshot: Option<crate::local_usage::LocalSnapshot>,
    busy: bool,
    settings_pending: bool,
    last_error: Option<String>,
}
#[tauri::command]
pub(crate) async fn get_local_sources(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::local_sources::SourceOptions, String> {
    require_main(&window)?;
    load_local_settings(&app, LOAD_SOURCES)
        .await?
        .sources
        .ok_or("采集目录设置不可用".into())
}
#[tauri::command]
pub(crate) async fn save_local_sources(
    window: WebviewWindow,
    app: tauri::AppHandle,
    options: crate::local_sources::SourceOptions,
) -> Result<crate::local_sources::SourceOptions, String> {
    require_main(&window)?;
    let options = crate::local_sources::validate_options(options)?;
    let mutation = begin_local_mutation(&app, true)?;
    local_mutation(mutation, move |shared| {
        crate::local_sources::save(&options)?;
        shared.lock().map_err(|_| "采集状态不可用")?.sources = Some(options.clone());
        crate::local_retention::commit_barrier()?;
        Ok(options)
    })
    .await
}
#[tauri::command]
pub(crate) async fn list_running_wsl(
    window: WebviewWindow,
) -> Result<crate::local_sources::WslStatus, String> {
    require_main(&window)?;
    crate::local_sources::running_wsl().await
}
#[tauri::command]
pub(crate) async fn save_local_archive(
    window: WebviewWindow,
    app: tauri::AppHandle,
    collected_at: u64,
    scope: crate::local_archive::ArchiveScope,
    include_paths: bool,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时钟不可用")?
        .as_millis() as u64;
    let (snapshot, last_scan_failed) = {
        let state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
        (
            crate::local_archive::current_snapshot(&state, collected_at, now)?.clone(),
            state.last_scan_failed,
        )
    };
    archive_mutation_io(move || {
        crate::local_archive::capture(&snapshot, &scope, include_paths, last_scan_failed, now)
    })
    .await
}
#[tauri::command]
pub(crate) async fn list_local_archives(
    window: WebviewWindow,
) -> Result<Vec<crate::local_archive::ArchiveSummary>, String> {
    require_main(&window)?;
    local_data_io(crate::local_archive::list).await
}
#[tauri::command]
pub(crate) async fn read_local_archive(
    window: WebviewWindow,
    id: String,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    local_data_io(move || crate::local_archive::read(&id)).await
}
#[tauri::command]
pub(crate) async fn delete_local_archive(window: WebviewWindow, id: String) -> Result<(), String> {
    require_main(&window)?;
    archive_mutation_io(move || crate::local_archive::delete(&id)).await
}
#[tauri::command]
pub(crate) async fn clear_local_archives(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    archive_mutation_io(crate::local_archive::clear).await
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
pub(crate) async fn get_local_data_overview(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<LocalDataOverview, String> {
    require_main(&window)?;
    let settings = load_local_settings(&app, LOAD_ENABLED).await?;
    let local_enabled = settings.enabled.unwrap_or(false);
    let local_collecting = app
        .state::<crate::local_usage::LocalCollector>()
        .inner
        .lock()
        .map_err(|_| "采集状态不可用")?
        .busy;
    local_data_io(move || {
        let config = to_app_config(read_stored_config()?)?;
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
    })
    .await
}

/// 清理采集引擎缓存。
///
/// 只在采集**没有在进行**时允许，避免删掉正在写入的元数据；只删本应用目录，
/// 不触碰原工具日志，也不承诺取证级安全擦除。自动留存开启时，清空后新采集
/// 会重新产生记录，这一点由界面在确认框中说明。
#[tauri::command]
pub(crate) async fn clear_local_engine_cache(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    let path = engine_cache_path()?;
    let shared = app
        .state::<crate::local_usage::LocalCollector>()
        .inner
        .clone();
    {
        let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
        if state.shutting_down {
            return Err("应用正在退出，本地数据不再接受清理".into());
        }
        if state.busy || state.settings_busy {
            return Err("采集或本地设置操作尚未结束，请等待后再清理引擎缓存".into());
        }
        state.settings_busy = true;
        invalidate_collection(&mut state, true);
    }
    local_mutation(
        SettingsMutation {
            state: shared,
            app: Some(app),
        },
        move |_| match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("引擎缓存无法完全清理，请稍后重试".into()),
        },
    )
    .await
}

fn local_preference_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-enabled.json"))
}
#[tauri::command]
pub(crate) async fn get_local_retention_enabled(window: WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    local_data_io(crate::local_retention::enabled).await
}
#[tauri::command]
pub(crate) async fn set_local_retention_enabled(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    require_main(&window)?;
    let mutation = begin_local_mutation(&app, false)?;
    local_mutation(mutation, move |_| {
        crate::local_retention::set_enabled(enabled)
    })
    .await
}
#[tauri::command]
pub(crate) async fn get_local_retention_capacity(
    window: WebviewWindow,
) -> Result<crate::local_retention::Capacity, String> {
    require_main(&window)?;
    local_data_io(crate::local_retention::capacity).await
}
#[tauri::command]
pub(crate) async fn list_local_retention(
    window: WebviewWindow,
) -> Result<Vec<crate::local_archive::ArchiveSummary>, String> {
    require_main(&window)?;
    local_data_io(crate::local_retention::list).await
}
#[tauri::command]
pub(crate) async fn read_local_retention(
    window: WebviewWindow,
    id: String,
) -> Result<crate::local_archive::ArchiveEntry, String> {
    require_main(&window)?;
    local_data_io(move || crate::local_retention::read(&id)).await
}
#[tauri::command]
pub(crate) async fn delete_local_retention(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    require_main(&window)?;
    let mutation = begin_local_mutation(&app, false)?;
    local_mutation(mutation, move |_| crate::local_retention::delete(&id)).await
}
#[tauri::command]
pub(crate) async fn clear_local_retention(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    let mutation = begin_local_mutation(&app, false)?;
    local_mutation(mutation, |_| crate::local_retention::clear()).await
}
fn local_enabled(state: &mut crate::local_usage::LocalState) -> Result<bool, String> {
    if let Some(enabled) = state.enabled {
        return Ok(enabled);
    }
    let path = local_preference_path()?;
    use std::io::Read;
    let enabled = match std::fs::File::open(path) {
        Ok(file) => {
            let mut data = Vec::new();
            file.take(17)
                .read_to_end(&mut data)
                .map_err(|_| "本地用量设置无法读取")?;
            if data.len() > 16 {
                return Err("本地用量设置损坏，请修复配置后重试".into());
            }
            serde_json::from_slice::<bool>(&data)
                .map_err(|_| "本地用量设置损坏，请修复配置后重试")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("本地用量设置无法读取".into()),
    };
    state.enabled = Some(enabled);
    Ok(enabled)
}
#[tauri::command]
pub(crate) async fn get_local_usage(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<LocalUsageStatus, String> {
    require_main(&window)?;
    // Once cached, status IPC never waits for filesystem work, including a late worker.
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let cached = {
        let state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
        state.enabled.map(|_| local_status(&state))
    };
    if let Some(status) = cached {
        return Ok(status);
    }
    load_local_settings(&app, LOAD_ENABLED).await?;
    let state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    Ok(local_status(&state))
}
#[tauri::command]
pub(crate) async fn set_local_usage_enabled(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<LocalUsageStatus, String> {
    require_main(&window)?;
    let mutation = begin_local_mutation(&app, true)?;
    // Stopping is immediate in this process even if the preferences disk is slow.
    // Never revive collection after a failed attempt to persist a stop.
    if !enabled {
        let mut state = mutation.state.lock().map_err(|_| "采集状态不可用")?;
        state.enabled = Some(false);
        state.stop_save_pending = true;
    }
    let shared = mutation.state.clone();
    local_mutation(mutation, move |state| {
        let path = local_preference_path()?;
        let parent = path.parent().ok_or("本地用量目录不可用")?;
        let save_error = if enabled {
            "本地用量设置无法保存，尚未开启"
        } else {
            "本地用量停止设置无法保存；本次停止仍生效，重启前请重试保存"
        };
        std::fs::create_dir_all(parent).map_err(|_| save_error)?;
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, if enabled { "true" } else { "false" })
            .map_err(|_| save_error)?;
        std::fs::rename(&temporary, &path).map_err(|_| save_error)?;
        commit_local_enabled(state, enabled)?;
        crate::local_retention::commit_barrier()
    })
    .await?;
    let state = shared.lock().map_err(|_| "采集状态不可用")?;
    Ok(local_status(&state))
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
    let shared = app
        .state::<crate::local_usage::LocalCollector>()
        .inner
        .clone();
    collect_local_usage_with(
        shared,
        background,
        COLLECTION_BUDGET,
        |sources| async move {
            let path = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources/local-usage/tokscale.exe")
            } else {
                app.path()
                    .resource_dir()
                    .map_err(|_| "采集引擎目录不可用")?
                    .join("local-usage/tokscale.exe")
            };
            crate::local_usage::run_sources(&path, &sources, app).await
        },
    )
    .await
}
async fn collect_local_usage_with<F, Fut>(
    shared: SharedLocalState,
    background: bool,
    budget: Duration,
    scan: F,
) -> Result<Option<crate::local_usage::LocalSnapshot>, String>
where
    F: FnOnce(crate::local_sources::SourceOptions) -> Fut,
    Fut: std::future::Future<Output = Result<crate::local_usage::LocalSnapshot, String>>,
{
    collect_local_usage_with_wait_budget(shared, background, budget, CHECKPOINT_WAIT_BUDGET, scan)
        .await
}
async fn collect_local_usage_with_wait_budget<F, Fut>(
    shared: SharedLocalState,
    background: bool,
    budget: Duration,
    checkpoint_budget: Duration,
    scan: F,
) -> Result<Option<crate::local_usage::LocalSnapshot>, String>
where
    F: FnOnce(crate::local_sources::SourceOptions) -> Fut,
    Fut: std::future::Future<Output = Result<crate::local_usage::LocalSnapshot, String>>,
{
    // The budget starts before the first configuration read, not inside run_sources.
    let deadline = tokio::time::Instant::now() + budget;
    let (lease, cancel) = {
        let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
        if state.shutting_down {
            return if background {
                Ok(None)
            } else {
                Err("应用正在退出，采集已停止".into())
            };
        }
        if state.busy || state.settings_busy {
            return if background {
                Ok(None)
            } else {
                Err("采集或本地设置操作尚未结束，请稍后重试".into())
            };
        }
        if state.enabled == Some(false) || (background && state.background_enabled == Some(false)) {
            return if background {
                Ok(None)
            } else {
                Err("尚未启用本地用量".into())
            };
        }
        state.busy = true;
        let cancel = Arc::new(tokio::sync::Notify::new());
        state.cancel = Some(cancel.clone());
        let lease = Arc::new(CollectionWorkerLease {
            state: shared.clone(),
            generation: state.generation,
            cancelled: AtomicBool::new(false),
            deadline,
        });
        (lease, cancel)
    };
    let _stop_on_drop = StopCollectionOnDrop(lease.clone());
    let work = COLLECTION_WORKER.scope(lease.clone(), async {
        let fields = LOAD_ENABLED | LOAD_SOURCES | if background { LOAD_BACKGROUND } else { 0 };
        let settings = load_local_settings_shared(shared.clone(), fields).await?;
        if settings.enabled != Some(true)
            || (background && settings.background_enabled != Some(true))
        {
            return if background {
                Ok(None)
            } else {
                Err("尚未启用本地用量".into())
            };
        }
        if !lease.current() {
            return Err("本地采集设置已变化".into());
        }
        let sources = settings.sources.ok_or("采集目录设置不可用")?;
        let mut snapshot = scan(sources).await?;
        if !lease.current() {
            return Err("本地采集已停止或设置已变化".into());
        }
        let checkpoint_snapshot = snapshot.clone();
        let checkpoint_lease = lease.clone();
        let checkpoint_task = tokio::task::spawn_blocking(move || {
            crate::local_retention::checkpoint_guarded(&checkpoint_snapshot, || {
                checkpoint_lease.current()
            })
        });
        // Retention is optional: don't hide otherwise usable statistics behind
        // a slow disk. A timed-out worker still owns busy and rechecks its lease
        // before rename. An already-entered atomic commit may still complete.
        let checkpoint = match tokio::time::timeout(checkpoint_budget, checkpoint_task).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("留存任务失败，当前统计仍可用".into()),
            Err(_) => {
                Err("留存等待超时，已请求停止；已开始的原子提交仍可能完成，当前统计可用".into())
            }
        };
        snapshot.retention_warning = match checkpoint {
            Ok(outcome) if outcome.failed => Some(
                "留存写入失败，已保存的旧记录未改动；本次质量证据未保存，当前统计仍可用".into(),
            ),
            Ok(outcome)
                if outcome.skipped > 0
                    || outcome.skipped_bytes > 0
                    || outcome.skipped_new_bytes > 0 =>
            {
                // 复评 R09/F03：三类跳过分别报告，旧会话更新不再被整批拖累，
                // 且「保留旧值」与「新会话未留存」的语义不同，不能混为一谈。
                let mut parts = Vec::new();
                if outcome.skipped > 0 {
                    parts.push(format!("{} 条新会话因条数已满未保存", outcome.skipped));
                }
                if outcome.skipped_new_bytes > 0 {
                    parts.push(format!(
                        "{} 条新会话因超出字节上限未保存",
                        outcome.skipped_new_bytes
                    ));
                }
                if outcome.skipped_bytes > 0 {
                    parts.push(format!(
                        "{} 条既有会话更新因超出字节上限保留旧值，本次质量证据可能未保存",
                        outcome.skipped_bytes
                    ));
                }
                Some(format!(
                    "留存容量受限：{} 条会话已更新，{}；可导出后清理旧留存",
                    outcome.written,
                    parts.join("，")
                ))
            }
            Ok(_) => None,
            Err(error) => Some(error),
        };
        Ok(Some(snapshot))
    });
    let result = tokio::select! {
        biased;
        _ = cancel.notified() => Err("本地采集已停止等待；已进入系统调用的工作结束前仍占用采集槽位".into()),
        _ = tokio::time::sleep_until(deadline) => Err("本地采集达到60秒总期限，已停止等待；正在进行的系统调用或原子提交可能稍后结束".into()),
        result = work => result,
    };
    let mut state = shared.lock().map_err(|_| "采集状态不可用")?;
    if state.generation != lease.generation {
        return Err("本地采集设置已变化，旧结果未发布".into());
    }
    state.last_scan_failed = result.is_err();
    state.last_error = result.as_ref().err().cloned();
    if let Ok(Some(snapshot)) = &result {
        if state.shutting_down
            || state.enabled != Some(true)
            || tokio::time::Instant::now() >= deadline
        {
            return Err("本地采集已停止或达到期限，旧结果未发布".into());
        }
        state.snapshot = Some(snapshot.clone());
    }
    // Drop the collector mutex before lease destructors (which also take it).
    drop(state);
    result
}

#[tauri::command]
pub(crate) async fn get_local_background(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<crate::local_background::Status, String> {
    require_main(&window)?;
    load_local_settings(&app, LOAD_ENABLED | LOAD_BACKGROUND).await?;
    crate::local_background::status(&app)
}
#[tauri::command]
pub(crate) async fn set_local_background(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<crate::local_background::Status, String> {
    require_main(&window)?;
    if enabled && load_local_settings(&app, LOAD_ENABLED).await?.enabled != Some(true) {
        return Err("请先开启本地统计".into());
    }
    let mutation = begin_local_mutation(&app, false)?;
    if !enabled {
        let mut state = mutation.state.lock().map_err(|_| "采集状态不可用")?;
        state.background_enabled = Some(false);
        state.background_stop_save_pending = true;
    }
    local_mutation(mutation, move |state| {
        crate::local_background::save_preference(enabled)?;
        commit_background_enabled(state, enabled)?;
        crate::local_retention::commit_barrier()
    })
    .await?;
    load_local_settings(&app, LOAD_ENABLED | LOAD_BACKGROUND).await?;
    crate::local_background::status(&app)
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
    {
        let collector = app.state::<crate::local_usage::LocalCollector>();
        begin_local_shutdown(&collector.inner);
    }
    // Do not delay process exit for uninterruptible filesystem work. A rename
    // already inside its atomic commit may finish; incomplete tmp copies remain
    // covered by the existing clear operation on the next launch.
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
    let config = app.state::<SyncSession>().cancel(|| {
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

#[cfg(test)]
type CollectionTestHook = Arc<dyn Fn(&str) + Send + Sync>;
#[cfg(test)]
fn collection_test_hook() -> &'static Mutex<Option<CollectionTestHook>> {
    static HOOK: OnceLock<Mutex<Option<CollectionTestHook>>> = OnceLock::new();
    HOOK.get_or_init(|| Mutex::new(None))
}
#[cfg(test)]
pub(crate) fn collection_test_stage(stage: &str) {
    let hook = collection_test_hook().lock().unwrap().clone();
    if let Some(hook) = hook {
        hook(stage);
    }
}

#[cfg(test)]
mod collection_lifecycle_tests {
    use super::*;
    use crate::test_support::TempConfigDir;

    struct PauseStage {
        started: Option<tokio::sync::oneshot::Receiver<()>>,
        release: Option<std::sync::mpsc::SyncSender<()>>,
    }
    impl PauseStage {
        fn at(target: &'static str) -> Self {
            let (started_tx, started) = tokio::sync::oneshot::channel();
            let started_tx = Mutex::new(Some(started_tx));
            let (release, receiver) = std::sync::mpsc::sync_channel(1);
            let receiver = Mutex::new(receiver);
            *collection_test_hook().lock().unwrap() = Some(Arc::new(move |stage| {
                if stage == target {
                    let sender = started_tx.lock().unwrap().take();
                    if let Some(sender) = sender {
                        let _ = sender.send(());
                        receiver
                            .lock()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .expect("test must release paused OS stage");
                    }
                }
            }));
            Self {
                started: Some(started),
                release: Some(release),
            }
        }
        async fn entered(&mut self) {
            tokio::time::timeout(Duration::from_secs(2), self.started.take().unwrap())
                .await
                .unwrap()
                .unwrap();
        }
        fn resume(&mut self) {
            if let Some(sender) = self.release.take() {
                let _ = sender.send(());
            }
        }
    }
    impl Drop for PauseStage {
        fn drop(&mut self) {
            self.resume();
            *collection_test_hook().lock().unwrap() = None;
        }
    }
    fn state(cached: bool) -> SharedLocalState {
        Arc::new(Mutex::new(crate::local_usage::LocalState {
            enabled: cached.then_some(true),
            background_enabled: cached.then_some(true),
            sources: cached.then(crate::local_sources::SourceOptions::default),
            ..Default::default()
        }))
    }
    async fn scan(
        _: crate::local_sources::SourceOptions,
    ) -> Result<crate::local_usage::LocalSnapshot, String> {
        crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[{
                "client":"opencode", "sessionId":"n04", "model":"deepseek",
                "input":20,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0
            }]}),
            1000,
        )
    }
    async fn wait_idle(shared: &SharedLocalState) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !shared.lock().unwrap().busy {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn concurrent_first_panel_reads_share_worker_without_false_disabled_status() {
        let _dir = TempConfigDir::new("n04-concurrent-initial-read");
        std::fs::write(local_preference_path().unwrap(), b"true").unwrap();
        crate::local_background::save_preference(true).unwrap();
        let shared = state(false);
        let mut pause = PauseStage::at("sources-read");
        let sources = tokio::spawn(load_local_settings_shared(shared.clone(), LOAD_SOURCES));
        pause.entered().await;
        let status = tokio::spawn(load_local_settings_shared(shared.clone(), LOAD_ENABLED));
        let background = tokio::spawn(load_local_settings_shared(
            shared.clone(),
            LOAD_ENABLED | LOAD_BACKGROUND,
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!status.is_finished());
        assert!(!background.is_finished());
        pause.resume();
        assert!(sources.await.unwrap().unwrap().sources.is_some());
        assert_eq!(status.await.unwrap().unwrap().enabled, Some(true));
        let background = background.await.unwrap().unwrap();
        assert_eq!(background.enabled, Some(true));
        assert_eq!(background.background_enabled, Some(true));
    }

    #[tokio::test]
    async fn ordinary_data_reads_queue_instead_of_failing_at_two_requests() {
        let _dir = TempConfigDir::new("n04-data-read-queue");
        let (entered_one, entered_one_rx) = tokio::sync::oneshot::channel();
        let (entered_two, entered_two_rx) = tokio::sync::oneshot::channel();
        let (release_one, wait_one) = std::sync::mpsc::sync_channel(1);
        let (release_two, wait_two) = std::sync::mpsc::sync_channel(1);
        let one = tokio::spawn(local_data_io(move || {
            let _ = entered_one.send(());
            wait_one.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(1)
        }));
        let two = tokio::spawn(local_data_io(move || {
            let _ = entered_two.send(());
            wait_two.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(2)
        }));
        entered_one_rx.await.unwrap();
        entered_two_rx.await.unwrap();
        let three = tokio::spawn(local_data_io(|| Ok(3)));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!three.is_finished());
        release_one.send(()).unwrap();
        release_two.send(()).unwrap();
        assert_eq!(one.await.unwrap().unwrap(), 1);
        assert_eq!(two.await.unwrap().unwrap(), 2);
        assert_eq!(three.await.unwrap().unwrap(), 3);
    }

    #[tokio::test]
    async fn timed_out_mutation_keeps_ownership_until_actual_worker_exit() {
        let _dir = TempConfigDir::new("n04-mutation-owner");
        let shared = state(true);
        let mutation = begin_local_mutation_shared(shared.clone(), true).unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let attempt = tokio::spawn(local_mutation_with_budget(
            mutation,
            Duration::from_millis(100),
            move |shared| {
                let _ = entered.send(());
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                shared.lock().unwrap().enabled = Some(false);
                Ok(())
            },
        ));
        entered_rx.await.unwrap();
        assert!(attempt.await.unwrap().is_err());
        assert!(shared.try_lock().unwrap().settings_busy);
        assert!(begin_local_mutation_shared(shared.clone(), true).is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while shared.lock().unwrap().settings_busy {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(shared.lock().unwrap().enabled, Some(false));
    }

    #[tokio::test]
    async fn retention_lock_contention_does_not_block_timer_or_release_collection_early() {
        let _dir = TempConfigDir::new("n04-retention-lock-contention");
        crate::local_retention::set_enabled(true).unwrap();
        let shared = state(true);
        let (locked, locked_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::sync_channel(1);
        let holder = tokio::task::spawn_blocking(move || {
            let _retention_lock = crate::local_retention::hold_commit_lock_for_test();
            let _ = locked.send(());
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        locked_rx.await.unwrap();
        let mut pause = PauseStage::at("retention-lock-wait");
        let attempt = tokio::spawn(collect_local_usage_with(
            shared.clone(),
            false,
            Duration::from_millis(500),
            scan,
        ));
        pause.entered().await;
        pause.resume();
        assert!(attempt.await.unwrap().is_err());
        assert!(shared.try_lock().unwrap().busy);
        release.send(()).unwrap();
        holder.await.unwrap();
        wait_idle(&shared).await;
        assert!(crate::local_retention::list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn optional_checkpoint_wait_publishes_warning_but_keeps_worker_slot() {
        let _dir = TempConfigDir::new("n04-optional-checkpoint");
        crate::local_retention::set_enabled(true).unwrap();
        let shared = state(true);
        let mut pause = PauseStage::at("retention-temp-written");
        let attempt = tokio::spawn(collect_local_usage_with_wait_budget(
            shared.clone(),
            false,
            COLLECTION_BUDGET,
            Duration::from_millis(100),
            scan,
        ));
        pause.entered().await;
        let snapshot = attempt.await.unwrap().unwrap().unwrap();
        assert!(snapshot
            .retention_warning
            .as_deref()
            .unwrap()
            .contains("留存等待超时"));
        assert!(shared.try_lock().unwrap().busy);
        assert!(shared.lock().unwrap().snapshot.is_some());
        pause.resume();
        wait_idle(&shared).await;
        assert!(crate::local_retention::list().unwrap().is_empty());
    }

    #[test]
    fn collection_child_process_fixture() {
        if std::env::var_os("DSM_N04_TEST_CHILD").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    #[tokio::test]
    async fn cancelled_child_keeps_slot_until_reaper_wait_completes() {
        let _dir = TempConfigDir::new("n04-child-owner");
        let shared = state(true);
        shared.lock().unwrap().busy = true;
        let lease = Arc::new(CollectionWorkerLease {
            state: shared.clone(),
            generation: 0,
            cancelled: AtomicBool::new(false),
            deadline: tokio::time::Instant::now() + COLLECTION_BUDGET,
        });
        let child = COLLECTION_WORKER
            .scope(lease.clone(), async {
                let child = tokio::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "commands::collection_lifecycle_tests::collection_child_process_fixture",
                    ])
                    .env("DSM_N04_TEST_CHILD", "1")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                CollectionChild::new(child)
            })
            .await;
        drop(lease);
        drop(child);
        // On the current-thread test runtime the reaper has not polled yet.
        assert!(shared.lock().unwrap().busy);
        wait_idle(&shared).await;
    }

    // Exercises the same entry lifecycle as the command, including first reads,
    // publication and checkpoint. No real engine/private user logs are used.
    #[tokio::test]
    async fn lifecycle_deadline_covers_first_settings_reads_and_keeps_slot() {
        let _dir = TempConfigDir::new("n04-settings-budget");
        std::fs::write(local_preference_path().unwrap(), b"true").unwrap();
        crate::local_background::save_preference(true).unwrap();
        for stage in ["enabled-read", "background-read", "sources-read"] {
            let shared = state(false);
            let mut pause = PauseStage::at(stage);
            let attempt = tokio::spawn(collect_local_usage_with(
                shared.clone(),
                true,
                Duration::from_millis(500),
                scan,
            ));
            pause.entered().await;
            let result = tokio::time::timeout(Duration::from_secs(2), attempt)
                .await
                .unwrap()
                .unwrap();
            assert!(result.is_err());
            assert!(
                shared.try_lock().unwrap().busy,
                "OS reader still owns the collection"
            );
            assert!(
                collect_local_usage_with(shared.clone(), false, COLLECTION_BUDGET, scan)
                    .await
                    .is_err()
            );
            pause.resume();
            wait_idle(&shared).await;
            assert!(shared.lock().unwrap().snapshot.is_none());
        }
    }

    #[tokio::test]
    async fn stop_cancels_slow_initial_read_without_waiting_for_collector_mutex() {
        let _dir = TempConfigDir::new("n04-stop-read");
        std::fs::write(local_preference_path().unwrap(), b"true").unwrap();
        let shared = state(false);
        let mut pause = PauseStage::at("enabled-read");
        let attempt = tokio::spawn(collect_local_usage_with(
            shared.clone(),
            false,
            COLLECTION_BUDGET,
            scan,
        ));
        pause.entered().await;
        let mutation = begin_local_mutation_shared(shared.clone(), true).unwrap();
        shared.lock().unwrap().enabled = Some(false);
        tokio::time::timeout(
            Duration::from_secs(2),
            local_mutation(mutation, |_| {
                std::fs::write(local_preference_path()?, b"false")
                    .map_err(|error| error.to_string())?;
                crate::local_retention::commit_barrier()
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), attempt)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(shared.try_lock().unwrap().busy);
        pause.resume();
        wait_idle(&shared).await;
        let current = shared.lock().unwrap();
        assert_eq!(
            current.enabled,
            Some(false),
            "late initial read must not restore true"
        );
        assert!(current.snapshot.is_none());
    }

    #[tokio::test]
    async fn lifecycle_deadline_covers_retention_wait_read_temp_and_commit() {
        let _dir = TempConfigDir::new("n04-retention-budget");
        crate::local_retention::set_enabled(true).unwrap();
        for stage in [
            "retention-lock-wait",
            "retention-read",
            "retention-temp-written",
            "retention-commit-entered",
        ] {
            crate::local_retention::clear().unwrap();
            let shared = state(true);
            let mut pause = PauseStage::at(stage);
            let attempt = tokio::spawn(collect_local_usage_with(
                shared.clone(),
                false,
                Duration::from_millis(500),
                scan,
            ));
            pause.entered().await;
            assert!(tokio::time::timeout(Duration::from_secs(2), attempt)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(shared.try_lock().unwrap().busy);
            assert!(shared.lock().unwrap().snapshot.is_none());
            pause.resume();
            wait_idle(&shared).await;
            if stage != "retention-commit-entered" {
                assert!(crate::local_retention::list().unwrap().is_empty());
            }
            // A rename already inside its commit boundary may finish. Timeout
            // means stopped waiting, not rolled back; clearing serializes below.
        }
    }

    #[tokio::test]
    async fn clear_after_entered_commit_waits_then_prevents_old_checkpoint_revival() {
        let dir = TempConfigDir::new("n04-clear-commit");
        crate::local_retention::set_enabled(true).unwrap();
        let shared = state(true);
        let mut pause = PauseStage::at("retention-commit-entered");
        let attempt = tokio::spawn(collect_local_usage_with(
            shared.clone(),
            false,
            COLLECTION_BUDGET,
            scan,
        ));
        pause.entered().await;
        let mutation = begin_local_mutation_shared(shared.clone(), false).unwrap();
        let clear = tokio::spawn(local_mutation(mutation, |_| {
            crate::local_retention::clear()
        }));
        assert!(tokio::time::timeout(Duration::from_secs(2), attempt)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !clear.is_finished(),
            "must not acknowledge clear ahead of an entered rename"
        );
        assert!(shared.try_lock().unwrap().settings_busy);
        pause.resume();
        clear.await.unwrap().unwrap();
        wait_idle(&shared).await;
        assert!(crate::local_retention::list().unwrap().is_empty());
        assert!(!dir.path().join("local-usage-retention.tmp").exists());
        assert!(shared.lock().unwrap().snapshot.is_none());
        assert!(!shared.lock().unwrap().settings_busy);
    }

    #[tokio::test]
    async fn quit_gate_prevents_late_enable_worker_from_reopening_collection() {
        let _dir = TempConfigDir::new("n04-quit-enable-race");
        let shared = state(true);
        let mutation = begin_local_mutation_shared(shared.clone(), true).unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::sync_channel(1);
        let enable = tokio::spawn(local_mutation(mutation, move |state| {
            let _ = entered.send(());
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            std::fs::write(local_preference_path()?, b"true").map_err(|error| error.to_string())?;
            commit_local_enabled(state, true)?;
            commit_background_enabled(state, true)
        }));
        entered_rx.await.unwrap();
        // Simulates confirm_quit before slow persist_position_for_exit returns.
        begin_local_shutdown(&shared);
        release.send(()).unwrap();
        enable.await.unwrap().unwrap();
        {
            let state = shared.lock().unwrap();
            assert!(state.shutting_down);
            assert_eq!(state.enabled, Some(false));
            assert_eq!(state.background_enabled, Some(false));
            assert!(!state.settings_busy);
            assert!(state.snapshot.is_none());
        }
        // The earlier authorized preference may persist for the next launch,
        // but neither a new background scan nor a new mutation can start now.
        assert_eq!(
            std::fs::read(local_preference_path().unwrap()).unwrap(),
            b"true"
        );
        assert!(
            collect_local_usage_with(shared.clone(), true, COLLECTION_BUDGET, scan)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            collect_local_usage_with(shared.clone(), false, COLLECTION_BUDGET, scan)
                .await
                .is_err()
        );
        assert!(begin_local_mutation_shared(shared, true).is_err());
    }

    #[tokio::test]
    async fn failed_stop_persistence_keeps_retry_flag_until_actual_success() {
        let _dir = TempConfigDir::new("n04-stop-persistence-retry");
        let shared = state(true);
        let mutation = begin_local_mutation_shared(shared.clone(), true).unwrap();
        {
            let mut state = shared.lock().unwrap();
            state.enabled = Some(false);
            state.stop_save_pending = true;
        }
        assert!(
            local_mutation(mutation, |_| Err::<(), _>("injected disk failure".into()))
                .await
                .is_err()
        );
        assert!(local_status(&shared.lock().unwrap()).stop_save_pending);
        assert!(!local_status(&shared.lock().unwrap()).enabled);
        let retry = begin_local_mutation_shared(shared.clone(), true).unwrap();
        local_mutation(retry, |state| commit_local_enabled(state, false))
            .await
            .unwrap();
        assert!(!local_status(&shared.lock().unwrap()).stop_save_pending);

        let mutation = begin_local_mutation_shared(shared.clone(), false).unwrap();
        {
            let mut state = shared.lock().unwrap();
            state.background_enabled = Some(false);
            state.background_stop_save_pending = true;
        }
        assert!(local_mutation(mutation, |_| Err::<(), _>(
            "injected background save failure".into()
        ))
        .await
        .is_err());
        assert!(shared.lock().unwrap().background_stop_save_pending);
        let retry = begin_local_mutation_shared(shared.clone(), false).unwrap();
        local_mutation(retry, |state| commit_background_enabled(state, false))
            .await
            .unwrap();
        assert!(!shared.lock().unwrap().background_stop_save_pending);
    }

    #[tokio::test]
    async fn disabling_background_invalidates_scan_but_preserves_published_snapshot() {
        let _dir = TempConfigDir::new("n04-background-cancel");
        let shared = state(true);
        let snapshot = scan(crate::local_sources::SourceOptions::default())
            .await
            .unwrap();
        let cancel = Arc::new(tokio::sync::Notify::new());
        {
            let mut state = shared.lock().unwrap();
            state.generation = 7;
            state.busy = true;
            state.snapshot = Some(snapshot);
            state.cancel = Some(cancel.clone());
        }
        let mutation = begin_local_mutation_shared(shared.clone(), false).unwrap();
        shared.lock().unwrap().background_enabled = Some(false);
        local_mutation(mutation, |_| {
            crate::local_background::save_preference(false)?;
            crate::local_retention::commit_barrier()
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), cancel.notified())
            .await
            .unwrap();
        let state = shared.lock().unwrap();
        assert_eq!(state.generation, 8);
        assert!(state.busy);
        assert!(state.snapshot.is_some());
        assert_eq!(state.background_enabled, Some(false));
    }

    #[tokio::test]
    async fn changed_sources_reject_late_scan_and_leave_new_configuration_intact() {
        let _dir = TempConfigDir::new("n04-source-generation");
        let shared = state(true);
        let (entered, receiver) = tokio::sync::oneshot::channel();
        let attempt = tokio::spawn(collect_local_usage_with(
            shared.clone(),
            false,
            COLLECTION_BUDGET,
            move |_| async move {
                let _ = entered.send(());
                std::future::pending::<()>().await;
                unreachable!()
            },
        ));
        receiver.await.unwrap();
        let mutation = begin_local_mutation_shared(shared.clone(), true).unwrap();
        let options = crate::local_sources::SourceOptions {
            include_default: false,
            homes: vec!["D:\\OtherHome".into()],
            tool_paths: vec![],
        };
        let expected = options.clone();
        local_mutation(mutation, move |state| {
            crate::local_sources::save(&options)?;
            state.lock().unwrap().sources = Some(options);
            crate::local_retention::commit_barrier()
        })
        .await
        .unwrap();
        assert!(attempt.await.unwrap().is_err());
        wait_idle(&shared).await;
        assert_eq!(shared.lock().unwrap().sources.as_ref(), Some(&expected));
        assert!(shared.lock().unwrap().snapshot.is_none());
    }
}
