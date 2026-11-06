//! 配置持久化。
//!
//! 这里放的是 `StoredConfig` / `AppConfig` 以及它们的读写与规范化。原先这些定义都嵌在
//! `lib.rs` 的 `run()` 内部，`#[cfg(test)]` 模块在文件顶层拿不到它们，导致配置层
//! （缺字段回退、原子写入与损坏配置保全）完全没有回归测试保护。提升到模块顶层后
//! 可以在不启动 Tauri 的前提下直接测。
//!
//! 读写路径由 `dsm_config_dir()` 决定，测试通过 `DSM_CONFIG_DIR` 环境变量重定向到临时目录。

use crate::credentials;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
    thread::ThreadId,
};
use tauri::Emitter;

/// 进程内配置读改写锁。多个 command 并发 save 时 last-write-wins 会丢字段，
/// 用一把全局锁把「读 → 改 → 写」串行化。锁的是本进程；跨进程写同一 config.json
/// 仍可能出现覆盖（单实例插件已保证只有一个进程，故可接受）。
fn config_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 锁的持有线程。std 的 Mutex 不可重入，同线程二次加锁会**永久死锁**，
/// 这里在阻塞前先查持有人，把重入变成立即 panic（评审 F-08）：
/// 「edit_config 回调里误调 read_stored_config」从静默挂死变成启动即崩的明确错误。
fn config_io_owner() -> &'static Mutex<Option<ThreadId>> {
    static OWNER: OnceLock<Mutex<Option<ThreadId>>> = OnceLock::new();
    OWNER.get_or_init(|| Mutex::new(None))
}

/// 配置 IO 锁守卫：Drop 时清空持有人记录。
struct ConfigIoGuard {
    _inner: MutexGuard<'static, ()>,
    owner: ThreadId,
}

impl Drop for ConfigIoGuard {
    fn drop(&mut self) {
        // 中毒也要恢复清理：panic 留下的毒标若让本处静默跳过，
        // 残留的持有人记录会把后续的串行加锁误判成重入
        let mut slot = config_io_owner()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *slot == Some(self.owner) {
            *slot = None;
        }
    }
}

fn lock_config_io() -> ConfigIoGuard {
    let thread = std::thread::current().id();
    // 先对持有人做快照并立刻放开 owner 锁，再比较与 panic——
    // panic 绝不能发生在持有任何锁的点上，否则 Mutex 中毒会破坏后续清理
    let held_by = {
        let slot = config_io_owner()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *slot
    };
    if held_by == Some(thread) {
        panic!(
            "配置 IO 锁重入：edit_config 回调内不得调用 read_stored_config / write_stored_config / edit_config（会死锁）"
        );
    }
    let inner = config_io_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut slot = config_io_owner()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *slot = Some(thread);
    ConfigIoGuard {
        _inner: inner,
        owner: thread,
    }
}

/// 在配置锁内执行「读 → 改 → 写」，避免并发命令互相覆盖。
/// 回调只能改传入的 `StoredConfig`；**禁止**在回调里再调 `read_stored_config`
/// 或 `write_stored_config`（会重入非可重入锁导致死锁）。
pub fn edit_config(
    f: impl FnOnce(&mut StoredConfig) -> Result<(), String>,
) -> Result<StoredConfig, String> {
    let _guard = lock_config_io();
    let mut config = read_stored_config_unlocked()?;
    f(&mut config)?;
    write_stored_config_unlocked(&config)?;
    stamp_snapshot(&mut config);
    Ok(config)
}

/// Record the unresolved privacy operation and remove the Token in ONE atomic
/// config commit. No browser deletion is allowed before this write succeeds.
/// IDs survive process restarts and are never inferred from process-local
/// credential revisions. Ordinary saves/preferences retain this marker.
pub fn begin_usage_cleanup() -> Result<(StoredConfig, u64), String> {
    let config = edit_config(|stored| {
        let next = stored
            .usage_cleanup_sequence
            .max(stored.usage_cleanup_unconfirmed.unwrap_or(0))
            .checked_add(1)
            .ok_or("无法记录账户清理操作，原配置未改动")?;
        stored.usage_cleanup_sequence = next;
        stored.usage_cleanup_unconfirmed = Some(next);
        stored.usage_token = None;
        Ok(())
    })?;
    let operation = config.usage_cleanup_sequence;
    Ok((config, operation))
}

/// Only the matching command's confirmed browser-success receipt can remove
/// the marker. A later retry/login/preference commit is read under the same lock;
/// never rewrite a stale pre-cleanup snapshot over the newer account.
pub fn confirm_usage_cleanup(operation: u64) -> Result<bool, String> {
    let _guard = lock_config_io();
    let mut stored = read_stored_config_unlocked()?;
    if stored.usage_cleanup_unconfirmed != Some(operation) {
        return Ok(false);
    }
    stored.usage_cleanup_unconfirmed = None;
    write_stored_config_unlocked(&stored)?;
    Ok(true)
}

/// 只读配置。与 `edit_config` 互斥，保证读到的是一致快照。
pub fn read_config() -> Result<StoredConfig, String> {
    read_stored_config()
}

/// 配置缺字段时的默认刷新间隔（秒）。必须走 serde 默认值，不能依赖派生的 Default：
/// 旧版本写入的或用户手工编辑过的 config.json 少一个字段，就会让反序列化整体失败，
/// 而 `read_stored_config` 是所有命令的前置步骤，等于全部功能瘫痪。
pub const DEFAULT_REFRESH_INTERVAL_SECONDS: u64 = 60;

/// 配置结构版本号。0 表示未标记的历史格式（v1.2.1 及更早写出的文件）。
///
/// **1 = 凭据字段经 DPAPI 加密**（M-1）。读路径据此判断是否需要迁移：
/// 版本号 < 1 且凭据非空时，回写一次加密后的配置。递增只在真有格式差异时进行，
/// 避免无谓的迁移分支。
pub const CONFIG_SCHEMA_VERSION: u32 = 1;

static CONFIG_REVISION: AtomicU64 = AtomicU64::new(0);
// Non-secret, process-local commit versions. They are captured under the IO lock
// together with the data, never sampled later while serializing an old response.
static API_KEY_COMMIT_REVISION: AtomicU64 = AtomicU64::new(0);
static USAGE_TOKEN_COMMIT_REVISION: AtomicU64 = AtomicU64::new(0);
fn stamp_snapshot(config: &mut StoredConfig) {
    config.config_revision = revision();
    config.api_key_revision = API_KEY_COMMIT_REVISION.load(Ordering::SeqCst);
    config.usage_token_revision = USAGE_TOKEN_COMMIT_REVISION.load(Ordering::SeqCst);
}
static API_KEY_VALIDATION_REVISION: AtomicU64 = AtomicU64::new(0);
static USAGE_TOKEN_VALIDATION_REVISION: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy)]
pub enum ValidatedCredential {
    ApiKey,
    UsageToken,
}
fn credential_counter(kind: ValidatedCredential) -> &'static AtomicU64 {
    match kind {
        ValidatedCredential::ApiKey => &API_KEY_VALIDATION_REVISION,
        ValidatedCredential::UsageToken => &USAGE_TOKEN_VALIDATION_REVISION,
    }
}
pub fn credential_validation_revision(kind: ValidatedCredential) -> u64 {
    credential_counter(kind).load(Ordering::SeqCst)
}
/// Call only after verification. Publish the recovery epoch under the config lock,
/// after a successful disk write, including same-value commits. Never reset receipts.
pub fn edit_validated_credential(
    kind: ValidatedCredential,
    value: String,
) -> Result<StoredConfig, String> {
    let _guard = lock_config_io();
    let mut config = read_stored_config_unlocked()?;
    match kind {
        ValidatedCredential::ApiKey => config.api_key = Some(value),
        ValidatedCredential::UsageToken => config.usage_token = Some(value),
    }
    write_stored_config_commit(&config, Some(kind))?;
    stamp_snapshot(&mut config);
    Ok(config)
}
pub fn revision() -> u64 {
    CONFIG_REVISION.load(Ordering::SeqCst)
}
pub fn changed() -> &'static tokio::sync::Notify {
    static CHANGED: OnceLock<tokio::sync::Notify> = OnceLock::new();
    CHANGED.get_or_init(tokio::sync::Notify::new)
}
pub fn read_snapshot() -> Result<(u64, StoredConfig), String> {
    let _guard = lock_config_io();
    let config = read_stored_config_unlocked()?;
    Ok((revision(), config))
}
/// Final background side effects share the config write lock. A clear/change cannot
/// race between the final generation check and submitting a notification.
pub fn with_current<T>(
    expected: u64,
    action: impl FnOnce(&StoredConfig) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let _guard = lock_config_io();
    let config = read_stored_config_unlocked()?;
    if revision() != expected {
        return Ok(None);
    }
    action(&config).map(Some)
}

pub fn default_refresh_interval_seconds() -> u64 {
    DEFAULT_REFRESH_INTERVAL_SECONDS
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize, Serialize)]
pub struct StoredConfig {
    #[serde(skip)]
    pub config_revision: u64,
    #[serde(skip)]
    pub api_key_revision: u64,
    #[serde(skip)]
    pub usage_token_revision: u64,
    #[serde(skip)]
    pub config_warnings: Vec<String>,
    #[serde(skip)]
    pub config_read_error: Option<String>,
    // 放在首位，便于人工查看 config.json 时一眼看到格式版本
    #[serde(default)]
    pub version: u32,
    pub api_key: Option<String>,
    #[serde(default)]
    pub usage_token: Option<String>,
    /// Non-secret durable cleanup identity. The marker is written atomically
    /// with Token removal, before any WebView2 deletion can start. A restart
    /// cannot turn its absence of an in-memory receipt into cleanup success.
    #[serde(default)]
    pub usage_cleanup_sequence: u64,
    #[serde(default)]
    pub usage_cleanup_unconfirmed: Option<u64>,
    #[serde(default = "default_refresh_interval_seconds")]
    pub refresh_interval_seconds: u64,
    #[serde(default)]
    pub auto_refresh_enabled: bool,
    #[serde(default)]
    pub autostart: bool,
    /// 主面板最后一次停留的位置（物理像素，屏幕坐标），隐藏到托盘与退出时写入，
    /// 再次唤出/启动时恢复。带 default 的可选字段：旧配置缺它也能正常解析，
    /// 因此不需要递增 schema 版本。None = 从未记录（首次运行），按托盘附近定位。
    #[serde(default)]
    pub window_position: Option<[i32; 2]>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub shortcut_enabled: bool,
    #[serde(default)]
    pub alerts: crate::alerts::AlertOptions,
}

impl StoredConfig {
    /// 首次运行（缺文件）时的默认配置。
    pub fn with_defaults() -> Self {
        Self {
            refresh_interval_seconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub config_revision: u64,
    pub api_key_revision: u64,
    pub usage_token_revision: u64,
    pub config_warnings: Vec<String>,
    pub config_read_error: Option<String>,
    pub api_key_configured: bool,
    pub api_key_preview: Option<String>,
    pub usage_token_configured: bool,
    /// Decimal identity only: no Token, cookie, account fingerprint or raw error.
    pub usage_cleanup_unconfirmed: Option<String>,
    pub refresh_interval_seconds: u64,
    pub auto_refresh_enabled: bool,
    pub autostart: bool,
    pub config_path: String,
}

/// 配置目录。默认 `%APPDATA%\DeepSeekMonitorWindows`；
/// 测试里用 `DSM_CONFIG_DIR` 指向临时目录，避免污染真实用户配置。
fn config_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("DSM_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not available")?;
    Ok(PathBuf::from(appdata).join("DeepSeekMonitorWindows"))
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

/// 读取配置：文件不存在时返回默认值，读取/解析失败则保留原件并明确失败。
///
/// 损坏文本可能含有跨行、转义或截断的旧明文凭据，无法可靠证明文本脱敏完整。
/// 因此不复制、不改名、不删除损坏文件，也不回退默认值触发后续覆盖。
/// 用户需先安全修复或移走原件后重试；历史版本生成的备份不在此处自动删除。
///
/// 凭据字段在返回前解密。读取到旧明文时尝试加密迁移；迁移失败保留原件并警告。
pub fn read_stored_config() -> Result<StoredConfig, String> {
    let _guard = lock_config_io();
    read_stored_config_unlocked()
}

/// The tracker stores semantic values only in process memory. It is never serialized,
/// logged, or sent to the webview. Ciphertext randomness/schema migration do not
/// represent account changes. Presence and unreadability do represent new snapshots.
struct ObservedConfig {
    path: PathBuf,
    present: bool,
    config: StoredConfig,
}
fn observed_config() -> &'static Mutex<Option<ObservedConfig>> {
    static OBSERVED: OnceLock<Mutex<Option<ObservedConfig>>> = OnceLock::new();
    OBSERVED.get_or_init(|| Mutex::new(None))
}
static CONFIG_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn install_change_listener(app: tauri::AppHandle) {
    let _ = CONFIG_APP.set(app);
}
fn publish_snapshot(config: &StoredConfig) {
    changed().notify_one();
    if let (Some(app), Ok(public)) = (CONFIG_APP.get(), to_app_config(config.clone())) {
        let _ = app.emit("credential-config-changed", public);
    }
}
fn semantic_config(config: &StoredConfig) -> StoredConfig {
    let mut semantic = config.clone();
    semantic.version = 0;
    semantic.config_revision = 0;
    semantic.api_key_revision = 0;
    semantic.usage_token_revision = 0;
    for field in [&mut semantic.api_key, &mut semantic.usage_token] {
        if field.as_deref() == Some("") {
            *field = None;
        }
    }
    semantic
}
/// Called only while config_io_lock is held, for reads and successful writes alike.
fn observe_snapshot(
    config: &mut StoredConfig,
    present: bool,
    force_commit: bool,
    validated: Option<ValidatedCredential>,
) {
    let Ok(path) = config_path() else { return };
    let semantic = semantic_config(config);
    let mut observed = observed_config().lock().unwrap_or_else(|e| e.into_inner());
    let previous = observed.as_ref().filter(|previous| previous.path == path);
    let changed =
        previous.is_some_and(|previous| previous.present != present || previous.config != semantic);
    if changed || force_commit {
        let next = CONFIG_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
        if previous.is_some_and(|previous| previous.config.api_key != semantic.api_key)
            || matches!(validated, Some(ValidatedCredential::ApiKey))
        {
            API_KEY_COMMIT_REVISION.store(next, Ordering::SeqCst);
        }
        if previous.is_some_and(|previous| previous.config.usage_token != semantic.usage_token)
            || matches!(validated, Some(ValidatedCredential::UsageToken))
        {
            USAGE_TOKEN_COMMIT_REVISION.store(next, Ordering::SeqCst);
        }
    }
    if let Some(kind) = validated {
        credential_counter(kind).fetch_add(1, Ordering::SeqCst);
    }
    *observed = Some(ObservedConfig {
        path,
        present,
        config: semantic,
    });
    drop(observed);
    stamp_snapshot(config);
    if changed || force_commit {
        publish_snapshot(config);
    }
}
fn unavailable_snapshot(error: String) -> StoredConfig {
    let mut config = StoredConfig::with_defaults();
    config.config_warnings.push(error.clone());
    config.config_read_error = Some(error);
    observe_snapshot(&mut config, true, false, None);
    config
}
/// UI reads return an explicitly untrusted, versioned snapshot on disk failure.
/// Mutation and account-request reads still return Err and never overwrite recovery material.
pub fn read_app_config() -> Result<AppConfig, String> {
    let _guard = lock_config_io();
    let config = match read_effective_config_unlocked() {
        Ok(config) => config,
        Err(error) => unavailable_snapshot(error),
    };
    to_app_config(config)
}
fn read_stored_config_unlocked() -> Result<StoredConfig, String> {
    match read_effective_config_unlocked() {
        Ok(config) => Ok(config),
        Err(error) => {
            unavailable_snapshot(error.clone());
            Err(error)
        }
    }
}
fn read_effective_config_unlocked() -> Result<StoredConfig, String> {
    let path = config_path()?;
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut config = StoredConfig::with_defaults();
            observe_snapshot(&mut config, false, false, None);
            return Ok(config);
        }
        Err(_) => return Err("无法读取配置文件，原文件未改动".to_string()),
    };
    // Never expose parser diagnostics, raw data, or decrypt diagnostics.
    const INVALID_CONFIG: &str = "配置文件损坏或编码无效，原文件已保留，未生成备份或重置。请安全修复或移走 config.json 后重试；历史备份不会自动清理。";
    let text = std::str::from_utf8(&raw).map_err(|_| INVALID_CONFIG.to_string())?;
    let mut config: StoredConfig =
        serde_json::from_str(text).map_err(|_| INVALID_CONFIG.to_string())?;
    config.refresh_interval_seconds =
        normalize_refresh_interval_seconds(config.refresh_interval_seconds);
    let needs_migration = decrypt_credentials(&mut config)?;
    if needs_migration {
        // Migration changes the disk representation, not semantic identity. Publish
        // exactly once below, including independently changed Key/Token generations.
        if write_stored_config_with(&config, encrypt_credentials).is_err() {
            config
                .config_warnings
                .push("旧配置凭据尚未成功加密，请检查 Windows 加密服务并重新保存".into());
        }
    }
    observe_snapshot(&mut config, true, false, None);
    Ok(config)
}

/// A transient/foreign DPAPI failure must not become a writable empty credential.
/// Fail the whole read before migration so mixed plaintext + unreadable ciphertext
/// also preserves the original file byte for byte.
fn decrypt_credentials(config: &mut StoredConfig) -> Result<bool, String> {
    let mut migrated = false;
    for field in [&mut config.api_key, &mut config.usage_token] {
        let Some(stored) = field.as_ref() else {
            continue;
        };
        if stored.is_empty() || !credentials::is_ciphertext(stored) {
            migrated |= !stored.is_empty();
            continue;
        }
        match credentials::decrypt(stored) {
            Some(Ok(plain)) => *field = Some(plain),
            _ => return Err(
                "本机暂时无法解密配置凭据，已停止使用旧账户数据且保留原文件。请恢复本机加密服务，或安全修复或移走 config.json 后重试。".into(),
            ),
        }
    }
    Ok(migrated)
}

/// 原地加密配置里的凭据字段。已是密文的跳过，避免重复加密。
fn encrypt_credentials(config: &mut StoredConfig) -> Result<(), String> {
    encrypt_credentials_with(config, credentials::encrypt)
}

fn encrypt_credentials_with(
    config: &mut StoredConfig,
    encrypt: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    for field in [&mut config.api_key, &mut config.usage_token] {
        let Some(plain) = field.as_ref() else {
            continue;
        };
        if plain.is_empty() || credentials::is_ciphertext(plain) {
            continue;
        }
        match encrypt(plain) {
            Some(cipher) => *field = Some(cipher),
            None => {
                return Err("无法安全保存凭据：Windows 加密服务不可用，原配置未被覆盖".to_string());
            }
        }
    }
    Ok(())
}

/// 只接受界面上真实提供的那几档间隔，其余一律退回默认值。
/// 防止手工编辑配置文件写入 1 秒之类的值把自动刷新变成打接口。
pub fn normalize_refresh_interval_seconds(value: u64) -> u64 {
    match value {
        60 | 300 | 1800 | 3600 => value,
        _ => DEFAULT_REFRESH_INTERVAL_SECONDS,
    }
}

/// 原子写入：先写同目录临时文件再 rename。`fs::write` 会直接截断目标文件，
/// 若在写入中途被强杀（Windows 更新、任务管理器结束进程）或断电，会留下半截 JSON，
/// 下次启动即解析失败。rename 覆盖已存在目标在 Windows 上等效
/// `MoveFileEx(REPLACE_EXISTING)`，同卷内是原子操作。
///
/// 落盘前加密凭据字段（M-1），并统一盖上当前 schema 版本号。所有写入都经过本函数，
/// 调用方无需各自维护，也就不会出现「某个命令写出的文件是明文没加密」这种不一致。
pub fn write_stored_config(config: &StoredConfig) -> Result<(), String> {
    let _guard = lock_config_io();
    // Even a direct writer must not replace unreadable recovery material.
    read_stored_config_unlocked()?;
    write_stored_config_unlocked(config)
}

fn write_stored_config_unlocked(config: &StoredConfig) -> Result<(), String> {
    write_stored_config_commit(config, None)
}
fn write_stored_config_commit(
    config: &StoredConfig,
    validated: Option<ValidatedCredential>,
) -> Result<(), String> {
    write_stored_config_with(config, encrypt_credentials)?;
    let mut committed = config.clone();
    committed.config_read_error = None;
    observe_snapshot(&mut committed, true, true, validated);
    Ok(())
}

fn write_stored_config_with(
    config: &StoredConfig,
    encrypt: impl FnOnce(&mut StoredConfig) -> Result<(), String>,
) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut to_write = config.clone();
    encrypt(&mut to_write)?;
    to_write.version = CONFIG_SCHEMA_VERSION;

    let text = serde_json::to_string_pretty(&to_write).map_err(|error| error.to_string())?;

    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, text).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, &path).map_err(|error| {
        // rename 失败时清理临时文件，避免在配置目录留下垃圾
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })?;
    Ok(())
}

/// API Key 预览：仅展示前 7 后 4 字符，中间省略。过短的 key 不展示任何片段。
pub fn api_key_preview(api_key: &str) -> String {
    let chars: Vec<char> = api_key.chars().collect();
    if chars.len() <= 12 {
        return "已保存".to_string();
    }

    let start: String = chars.iter().take(7).collect();
    let end: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}...{end}")
}

/// 内部结构 → 前端可见结构。凭据本身不出这个函数（只出预览与布尔标记）。
pub fn to_app_config(config: StoredConfig) -> Result<AppConfig, String> {
    let path = config_path()?;
    let api_key_preview = config
        .api_key
        .as_ref()
        .filter(|value| !value.is_empty())
        .map(|value| api_key_preview(value));

    let usage_token_configured = config
        .usage_token
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false);

    Ok(AppConfig {
        config_revision: config.config_revision,
        api_key_revision: config.api_key_revision,
        usage_token_revision: config.usage_token_revision,
        config_warnings: config.config_warnings,
        config_read_error: config.config_read_error,
        api_key_configured: api_key_preview.is_some(),
        api_key_preview,
        usage_token_configured,
        usage_cleanup_unconfirmed: config.usage_cleanup_unconfirmed.map(|id| id.to_string()),
        refresh_interval_seconds: config.refresh_interval_seconds,
        auto_refresh_enabled: config.auto_refresh_enabled,
        autostart: config.autostart,
        config_path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempConfigDir;

    #[test]
    fn r19_cleanup_marker_and_token_removal_are_one_restart_readable_commit() {
        let dir = TempConfigDir::new("cleanup-restart-marker");
        let path = config_path().unwrap();
        fs::write(
            &path,
            r#"{"usage_token":"SYNTHETIC_OLD_TOKEN","refresh_interval_seconds":300}"#,
        )
        .unwrap();
        let (cleared, operation) = begin_usage_cleanup().unwrap();
        assert_eq!(cleared.usage_token, None);
        assert_eq!(cleared.usage_cleanup_unconfirmed, Some(operation));
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("SYNTHETIC_OLD_TOKEN"));
        // Deserialize fresh disk bytes rather than depending on process-local
        // Atomic revisions: this is the record available after a restart.
        let reopened: StoredConfig = serde_json::from_str(&persisted).unwrap();
        assert_eq!(reopened.usage_token, None);
        assert_eq!(reopened.usage_cleanup_unconfirmed, Some(operation));
        assert_eq!(reopened.refresh_interval_seconds, 300);
        let public = to_app_config(reopened).unwrap();
        assert_eq!(
            public.usage_cleanup_unconfirmed,
            Some(operation.to_string())
        );
        assert!(!public.usage_token_configured);
        assert!(!dir.path().join("config.json.tmp").exists());
        // A timeout or failure does not call confirm: unrelated writes/readback
        // must continue to preserve the incomplete marker.
        edit_config(|stored| {
            stored.auto_refresh_enabled = true;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            read_stored_config().unwrap().usage_cleanup_unconfirmed,
            Some(operation)
        );
    }

    #[test]
    fn r19_marker_write_failure_cannot_remove_token_or_overwrite_recovery_material() {
        let dir = TempConfigDir::new("cleanup-marker-write-failure");
        let path = config_path().unwrap();
        let original = br#"{"usage_token":"SYNTHETIC_UNCHANGED_TOKEN"}"#;
        fs::write(&path, original).unwrap();
        // Force the existing atomic writer to fail before rename. Migration,
        // if attempted, must fail closed too and preserve the original bytes.
        fs::create_dir(dir.path().join("config.json.tmp")).unwrap();
        assert!(begin_usage_cleanup().is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn r19_only_matching_success_removes_marker_and_ids_survive_reopen() {
        let _dir = TempConfigDir::new("cleanup-marker-ownership");
        let (_, old) = begin_usage_cleanup().unwrap();
        let (_, current) = begin_usage_cleanup().unwrap();
        assert!(current > old);
        let before = fs::read(config_path().unwrap()).unwrap();
        assert!(!confirm_usage_cleanup(old).unwrap());
        assert_eq!(fs::read(config_path().unwrap()).unwrap(), before);
        assert_eq!(
            read_stored_config().unwrap().usage_cleanup_unconfirmed,
            Some(current)
        );
        assert!(confirm_usage_cleanup(current).unwrap());
        let reopened = read_stored_config().unwrap();
        assert_eq!(reopened.usage_cleanup_unconfirmed, None);
        assert_eq!(reopened.usage_cleanup_sequence, current);
        assert!(!confirm_usage_cleanup(current).unwrap());
        let (_, retry) = begin_usage_cleanup().unwrap();
        assert!(retry > current);
    }

    #[test]
    fn r19_failed_confirmation_keeps_durable_warning_and_preserves_original_file() {
        let dir = TempConfigDir::new("cleanup-confirm-write-failure");
        let (_, operation) = begin_usage_cleanup().unwrap();
        let before = fs::read(config_path().unwrap()).unwrap();
        fs::create_dir(dir.path().join("config.json.tmp")).unwrap();
        assert!(confirm_usage_cleanup(operation).is_err());
        assert_eq!(fs::read(config_path().unwrap()).unwrap(), before);
        assert_eq!(
            read_stored_config().unwrap().usage_cleanup_unconfirmed,
            Some(operation)
        );
    }

    #[test]
    fn r19_cleanup_counter_overflow_fails_before_mutation() {
        let _dir = TempConfigDir::new("cleanup-sequence-overflow");
        let path = config_path().unwrap();
        let original = format!("{{\"usage_cleanup_sequence\":{}}}", u64::MAX);
        fs::write(&path, &original).unwrap();
        assert!(begin_usage_cleanup().is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[cfg(windows)]
    #[test]
    fn r19_late_cleanup_confirmation_preserves_new_account_and_preferences() {
        let _dir = TempConfigDir::new("cleanup-confirm-new-account");
        let (_, operation) = begin_usage_cleanup().unwrap();
        let replacement = edit_validated_credential(
            ValidatedCredential::UsageToken,
            "SYNTHETIC_REPLACEMENT_TOKEN".into(),
        )
        .unwrap();
        assert_eq!(replacement.usage_cleanup_unconfirmed, Some(operation));
        edit_config(|stored| {
            stored.refresh_interval_seconds = 1800;
            Ok(())
        })
        .unwrap();
        assert!(confirm_usage_cleanup(operation).unwrap());
        let current = read_stored_config().unwrap();
        assert_eq!(
            current.usage_token.as_deref(),
            Some("SYNTHETIC_REPLACEMENT_TOKEN")
        );
        assert_eq!(
            current.usage_token_revision,
            replacement.usage_token_revision
        );
        assert_eq!(current.refresh_interval_seconds, 1800);
        assert_eq!(current.usage_cleanup_unconfirmed, None);
    }

    #[test]
    fn 加密失败拒绝序列化_不改变旧配置文件() {
        let dir = TempConfigDir::new("encryption-failure");
        let path = dir.path().join("config.json");
        fs::write(&path, "old-ciphertext-file").unwrap();
        let mut config = StoredConfig::with_defaults();
        config.api_key = Some("synthetic-secret".into());
        assert!(
            write_stored_config_with(&config, |c| encrypt_credentials_with(c, |_| None)).is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "old-ciphertext-file");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn 缺字段的旧配置_反序列化_走默认值() {
        // H-1 的回归测试：v1.0/v1.1 写出的文件只有 api_key 与 usage_token 两个字段。
        // 修复前这里会解析失败，进而让全部命令失效。
        let config: StoredConfig =
            serde_json::from_str(r#"{"api_key":"sk-abc","usage_token":"tok"}"#).unwrap();
        assert_eq!(config.refresh_interval_seconds, 60);
        assert!(!config.auto_refresh_enabled);
        assert!(!config.autostart);
        assert!(!config.alerts.enabled);
        assert_eq!(config.alerts.low_balance_cny, 10.0);
        assert_eq!(config.version, 0);
        assert_eq!(config.api_key.as_deref(), Some("sk-abc"));
    }

    #[test]
    fn 空对象_反序列化_全部落默认值() {
        let config: StoredConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.refresh_interval_seconds, 60);
        assert_eq!(config.api_key, None);
        assert_eq!(config.usage_token, None);
    }

    #[test]
    fn 显式字段_覆盖默认值() {
        let config: StoredConfig = serde_json::from_str(
            r#"{"version":1,"refresh_interval_seconds":300,"auto_refresh_enabled":true,"autostart":true}"#,
        )
        .unwrap();
        assert_eq!(config.version, 1);
        assert_eq!(config.refresh_interval_seconds, 300);
        assert!(config.auto_refresh_enabled);
        assert!(config.autostart);
    }

    #[test]
    fn 文件不存在_返回默认配置() {
        let _dir = TempConfigDir::new("read_missing");
        let config = read_stored_config().unwrap();
        assert_eq!(config.refresh_interval_seconds, 60);
        assert_eq!(config.api_key, None);
    }

    #[test]
    fn 损坏配置_真实读取入口保留原字节_不生成秘密副本() {
        let cases: &[&[u8]] = &[
            br#"{"api_key":"synthetic-secret","usage_token":"synthetic-token",!}"#,
            br#"{"apiKey":"synthetic-secret","usageToken":"synthetic-token",!}"#,
            b"{\"api_key\":\n\"synthetic-secret\",!}",
            br#"{"api\u005fkey":"synthetic-secret",!}"#,
            br#"{"api_key":"synthetic-\u0073ecret",!}"#,
            br#"{"api_key":"synthetic-secret"#,
            br#"{"api_key":{"nested":"synthetic-secret"}}"#,
            br#"{"api_key":"synthetic-secret","api_key":"synthetic-token"}"#,
            br#"{"refresh_interval_seconds":"synthetic-secret"}"#,
            b"{\"api_key\":\"synthetic-secret\",\xff}",
            b"{\"unknown\":\"synthetic-secret\xff\"}",
        ];
        for raw in cases {
            let dir = TempConfigDir::new("corrupt-preserved");
            let path = config_path().unwrap();
            fs::write(&path, raw).unwrap();
            let error = read_stored_config().unwrap_err();
            assert!(error.contains("原文件已保留"));
            assert!(!error.contains("synthetic"), "错误不能泄漏输入值");
            assert_eq!(fs::read(&path).unwrap(), *raw, "原件必须逐字节保留");
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
            // edit_config 不得把读取失败当默认值再覆盖唯一恢复材料。
            assert!(edit_config(|_| panic!("损坏配置不得进入写入回调")).is_err());
            assert_eq!(fs::read(&path).unwrap(), *raw);
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn 损坏配置_不删除或修改历史备份() {
        let dir = TempConfigDir::new("corrupt-history-preserved");
        let path = config_path().unwrap();
        let original = b"{\"api_key\":\"synthetic-secret";
        let previous = dir.path().join("config.json.corrupt-existing");
        fs::write(&path, original).unwrap();
        fs::write(&previous, b"previous-recovery-material").unwrap();
        let error = read_stored_config().unwrap_err();
        assert!(error.contains("历史备份不会自动清理"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read(&previous).unwrap(), b"previous-recovery-material");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn 正常无凭据配置_读取不创建副本() {
        let dir = TempConfigDir::new("valid-no-backups");
        let path = config_path().unwrap();
        let original = br#"{"refresh_interval_seconds":300,"api_key":null}"#;
        fs::write(&path, original).unwrap();
        assert_eq!(read_stored_config().unwrap().refresh_interval_seconds, 300);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn 读取时规范化非法的刷新间隔() {
        let _dir = TempConfigDir::new("read_normalize");
        let path = config_path().unwrap();
        fs::write(&path, r#"{"refresh_interval_seconds":7}"#).unwrap();
        assert_eq!(read_stored_config().unwrap().refresh_interval_seconds, 60);
    }

    #[test]
    fn 写入_盖上_schema_版本号_且不留临时文件() {
        let dir = TempConfigDir::new("write_stamp");
        let config = StoredConfig {
            version: 0,
            config_warnings: vec![],
            api_key: Some("sk-test".to_string()),
            usage_token: None,
            refresh_interval_seconds: 300,
            auto_refresh_enabled: true,
            autostart: false,
            window_position: None,
            always_on_top: false,
            shortcut_enabled: false,
            alerts: Default::default(),
            ..StoredConfig::with_defaults()
        };
        write_stored_config(&config).unwrap();

        let text = fs::read_to_string(config_path().unwrap()).unwrap();
        let reread: StoredConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(reread.version, CONFIG_SCHEMA_VERSION);
        assert_eq!(reread.refresh_interval_seconds, 300);
        assert!(reread.auto_refresh_enabled);

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "原子写入不应残留临时文件");
    }

    #[test]
    fn 写入后读取_往返一致() {
        let _dir = TempConfigDir::new("write_roundtrip");
        let config = StoredConfig {
            version: CONFIG_SCHEMA_VERSION,
            config_warnings: vec![],
            api_key: Some("sk-roundtrip-key-value".to_string()),
            usage_token: Some("usage-token-value".to_string()),
            refresh_interval_seconds: 3600,
            auto_refresh_enabled: true,
            autostart: true,
            window_position: Some([-1920, 240]),
            always_on_top: true,
            shortcut_enabled: true,
            alerts: crate::alerts::AlertOptions {
                enabled: true,
                monthly_budget_enabled: true,
                monthly_budget_cny: 123.45,
                ..Default::default()
            },
            ..StoredConfig::with_defaults()
        };
        write_stored_config(&config).unwrap();
        let reread = read_stored_config().unwrap();
        assert_eq!(reread.api_key, config.api_key);
        assert_eq!(reread.usage_token, config.usage_token);
        assert_eq!(reread.refresh_interval_seconds, 3600);
        assert_eq!(reread.window_position, Some([-1920, 240]));
        assert!(reread.always_on_top && reread.shortcut_enabled);
        assert_eq!(reread.alerts, config.alerts);
        assert!(reread.auto_refresh_enabled && reread.autostart);
    }

    /// 非 Windows 时明确跳过加密相关断言（复评 F16：不能把「加密失败」当成跳过）。
    fn require_windows_encryption() -> bool {
        cfg!(windows)
    }

    #[test]
    fn 落盘的凭据是密文_不是明文() {
        if !require_windows_encryption() {
            eprintln!("NOT RUN: DPAPI 仅在 Windows 可用，本测试未验证真实加密");
            return;
        }
        // Windows 上加密必须真的可用：失败即失败，不静默跳过。
        assert!(
            credentials::encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用，落盘加密无法工作"
        );
        // M-1 的核心断言：文件内容里不能出现明文凭据。
        let _dir = TempConfigDir::new("m1_ciphertext_on_disk");
        let secret = "sk-verysecretvalue123456";
        let config = StoredConfig {
            api_key: Some(secret.to_string()),
            usage_token: Some("usage-secret-token".to_string()),
            ..StoredConfig::with_defaults()
        };
        write_stored_config(&config).unwrap();

        let raw = fs::read_to_string(config_path().unwrap()).unwrap();
        assert!(!raw.contains(secret), "config.json 不应出现明文 API Key");
        assert!(
            !raw.contains("usage-secret-token"),
            "config.json 不应出现明文用量 Token"
        );
        assert!(raw.contains("DSM1:"), "凭据字段应带密文前缀");
    }

    #[test]
    fn 明文旧配置_读取后自动迁移为密文() {
        if !require_windows_encryption() {
            eprintln!("NOT RUN: DPAPI 仅在 Windows 可用，本测试未验证真实加密");
            return;
        }
        // Windows 上加密必须真的可用：失败即失败，不静默跳过。
        assert!(
            credentials::encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用，落盘加密无法工作"
        );
        // 迁移路径：v1.2.1 写出的文件是明文且 version 为 0。
        // 读取时既要能正常用，也要顺手把落盘内容换成密文。
        let _dir = TempConfigDir::new("m1_migration");
        let path = config_path().unwrap();
        let secret = "sk-legacyplaintext12345";
        fs::write(
            &path,
            format!(r#"{{"api_key":"{secret}","usage_token":"legacy-token"}}"#),
        )
        .unwrap();

        // 第一次读：拿到明文凭据，并触发迁移回写
        let first = read_stored_config().unwrap();
        assert_eq!(first.api_key.as_deref(), Some(secret));
        assert_eq!(first.usage_token.as_deref(), Some("legacy-token"));

        // 文件已被改写为密文
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(secret), "迁移后不应残留明文");
        assert!(raw.contains("DSM1:"));

        // 第二次读：从密文解回同样的凭据
        let second = read_stored_config().unwrap();
        assert_eq!(second.api_key.as_deref(), Some(secret));
        assert_eq!(second.usage_token.as_deref(), Some("legacy-token"));
    }

    #[test]
    fn 已加密配置_重复读取不改变内容() {
        if !require_windows_encryption() {
            eprintln!("NOT RUN: DPAPI 仅在 Windows 可用，本测试未验证真实加密");
            return;
        }
        // Windows 上加密必须真的可用：失败即失败，不静默跳过。
        assert!(
            credentials::encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用，落盘加密无法工作"
        );
        // 迁移必须是幂等的：第二次读取不应再次回写（否则每次启动都写一次盘）。
        let _dir = TempConfigDir::new("m1_idempotent");
        let config = StoredConfig {
            api_key: Some("sk-idempotent-key-value".to_string()),
            usage_token: None,
            refresh_interval_seconds: 300,
            auto_refresh_enabled: true,
            autostart: false,
            ..StoredConfig::with_defaults()
        };
        write_stored_config(&config).unwrap();
        let before = fs::read_to_string(config_path().unwrap()).unwrap();

        let _ = read_stored_config().unwrap();
        let after = fs::read_to_string(config_path().unwrap()).unwrap();
        assert_eq!(before, after, "已加密配置重复读取不应改动文件");
    }

    #[test]
    fn 解不开的密文_撤销信任并保全原件_禁止偏好写覆盖() {
        let _dir = TempConfigDir::new("m1_foreign");
        let path = config_path().unwrap();
        let original = br#"{"version":1,"api_key":"DSM1:AAAAAAAAAAAAAAAAAAAAAA==","usage_token":"SYNTHETIC_LEGACY_TOKEN","refresh_interval_seconds":1800,"autostart":true}"#;
        fs::write(&path, original).unwrap();
        assert!(read_stored_config().is_err());
        let public = read_app_config().unwrap();
        assert!(!public.api_key_configured && !public.usage_token_configured);
        assert!(public.config_read_error.is_some());
        assert!(!serde_json::to_string(&public)
            .unwrap()
            .contains("SYNTHETIC"));
        assert!(edit_config(|_| panic!("unreadable credentials must block writes")).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    fn write_synthetic_plaintext(key: &str, token: &str, interval: u64) {
        fs::write(
            config_path().unwrap(),
            serde_json::to_vec(&serde_json::json!({
                "api_key": key,
                "usage_token": token,
                "refresh_interval_seconds": interval,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn n09_first_read_initializes_then_disk_removal_revokes_both_credentials() {
        let _dir = TempConfigDir::new("n09_missing");
        write_synthetic_plaintext("SYNTHETIC_KEY_A", "SYNTHETIC_TOKEN_A", 300);
        let before = revision();
        let first = read_stored_config().unwrap();
        assert_eq!(
            first.config_revision, before,
            "initial migration is not a new identity"
        );
        fs::remove_file(config_path().unwrap()).unwrap();
        let missing = read_stored_config().unwrap();
        assert!(missing.config_revision > first.config_revision);
        assert!(missing.api_key_revision > first.api_key_revision);
        assert!(missing.usage_token_revision > first.usage_token_revision);
        assert!(missing.api_key.is_none() && missing.usage_token.is_none());
        assert_eq!(
            read_stored_config().unwrap().config_revision,
            missing.config_revision
        );
    }

    #[test]
    fn n09_same_preview_different_key_and_preference_write_preserve_independent_versions() {
        let _dir = TempConfigDir::new("n09_identity");
        write_synthetic_plaintext("sk-sameAAAA-tail", "SYNTHETIC_TOKEN", 60);
        let first = read_stored_config().unwrap();
        write_synthetic_plaintext("sk-sameBBBB-tail", "SYNTHETIC_TOKEN", 60);
        // edit_config must observe the external account change before the preference write.
        let changed = edit_config(|config| {
            config.refresh_interval_seconds = 300;
            Ok(())
        });
        // Non-Windows cannot securely write these synthetic credentials. The read
        // observation must nevertheless have advanced, without overwriting the file.
        if cfg!(windows) {
            assert!(changed.is_ok());
        } else {
            assert!(changed.is_err());
        }
        let second = read_stored_config().unwrap();
        assert_eq!(
            api_key_preview(first.api_key.as_deref().unwrap()),
            api_key_preview(second.api_key.as_deref().unwrap())
        );
        assert!(second.api_key_revision > first.api_key_revision);
        assert_eq!(second.usage_token_revision, first.usage_token_revision);
        assert!(second.config_revision > first.config_revision);
        assert_eq!(
            to_app_config(first.clone()).unwrap().config_revision,
            first.config_revision
        );
    }

    #[test]
    fn n09_invalid_disk_revokes_then_recovery_gets_fresh_credential_versions() {
        let _dir = TempConfigDir::new("n09_recovery");
        write_synthetic_plaintext("SYNTHETIC_KEY", "SYNTHETIC_TOKEN", 60);
        let first = read_stored_config().unwrap();
        let corrupt = br#"{"api_key":"SYNTHETIC_RECOVERY_SECRET",!}"#;
        fs::write(config_path().unwrap(), corrupt).unwrap();
        let revoked = read_app_config().unwrap();
        assert!(revoked.config_read_error.is_some());
        assert!(!revoked.api_key_configured && !revoked.usage_token_configured);
        assert!(revoked.api_key_revision > first.api_key_revision);
        assert!(revoked.usage_token_revision > first.usage_token_revision);
        assert_eq!(
            read_app_config().unwrap().config_revision,
            revoked.config_revision
        );
        assert!(edit_config(|_| panic!("corrupt source must not be overwritten")).is_err());
        assert_eq!(fs::read(config_path().unwrap()).unwrap(), corrupt);
        write_synthetic_plaintext("SYNTHETIC_KEY", "SYNTHETIC_TOKEN", 60);
        let recovered = read_app_config().unwrap();
        assert!(recovered.config_read_error.is_none());
        assert!(recovered.api_key_revision > revoked.api_key_revision);
        assert!(recovered.usage_token_revision > revoked.usage_token_revision);
        assert!(!serde_json::to_string(&revoked)
            .unwrap()
            .contains("SYNTHETIC"));
    }

    #[cfg(windows)]
    #[test]
    fn n09_same_secret_reencrypted_ciphertext_is_not_an_account_change() {
        let _dir = TempConfigDir::new("n09_dpapi_identity");
        let secret = "SYNTHETIC_SAME_SECRET";
        let write_cipher = || {
            let encrypted = credentials::encrypt(secret).expect("Windows DPAPI must be available");
            fs::write(
                config_path().unwrap(),
                serde_json::to_vec(&serde_json::json!({
                    "version": 1, "api_key": encrypted,
                }))
                .unwrap(),
            )
            .unwrap();
        };
        write_cipher();
        let first = read_stored_config().unwrap();
        write_cipher();
        let second = read_stored_config().unwrap();
        assert_eq!(second.config_revision, first.config_revision);
        assert_eq!(second.api_key_revision, first.api_key_revision);
        assert_eq!(second.usage_token_revision, first.usage_token_revision);
    }

    #[test]
    fn 空凭据_不加密也视为未配置() {
        let _dir = TempConfigDir::new("m1_empty");
        let config = StoredConfig {
            api_key: Some(String::new()),
            usage_token: None,
            ..StoredConfig::with_defaults()
        };
        write_stored_config(&config).unwrap();
        let raw = fs::read_to_string(config_path().unwrap()).unwrap();
        assert!(!raw.contains("DSM1:"), "空字符串不应被加密成密文");
    }

    #[test]
    fn 刷新间隔_规范化() {
        for allowed in [60, 300, 1800, 3600] {
            assert_eq!(normalize_refresh_interval_seconds(allowed), allowed);
        }
        for rejected in [0, 1, 59, 61, 299, 9999, u64::MAX] {
            assert_eq!(normalize_refresh_interval_seconds(rejected), 60);
        }
    }

    #[test]
    fn edit_config_回调内重入_fail_fast_而非死锁() {
        // F-08 的回归测试：回调内误调 read_stored_config 曾经会永久死锁，
        // 现在应在加锁前检测到同线程持锁并立即 panic（catch_unwind 验证）。
        let _dir = TempConfigDir::new("reentrant_fail_fast");
        let result = std::panic::catch_unwind(|| {
            let _ = edit_config(|_config| {
                let _ = read_stored_config();
                Ok(())
            });
        });
        assert!(result.is_err(), "同线程重入应触发 fail-fast panic");
    }

    #[test]
    fn edit_config_串行正常使用_不死锁不误报() {
        // 防护不能误伤：串行地先 edit 再 read（非重入）必须照常工作
        let _dir = TempConfigDir::new("reentrant_ok");
        let stored = edit_config(|config| {
            config.refresh_interval_seconds = 300;
            Ok(())
        })
        .unwrap();
        assert_eq!(stored.refresh_interval_seconds, 300);
        assert_eq!(read_stored_config().unwrap().refresh_interval_seconds, 300);
    }

    #[test]
    fn n05_snapshot_versions_are_frozen_and_not_persisted() {
        let dir = TempConfigDir::new("n05_snapshot_versions");
        let first = edit_config(|config| {
            config.refresh_interval_seconds = 300;
            Ok(())
        })
        .unwrap();
        let old_revision = first.config_revision;
        let second = edit_config(|config| {
            config.auto_refresh_enabled = true;
            Ok(())
        })
        .unwrap();
        assert!(second.config_revision > old_revision);
        assert_eq!(second.api_key_revision, first.api_key_revision);
        assert_eq!(second.usage_token_revision, first.usage_token_revision);
        // Conversion occurs after another commit, but must retain the old stamp.
        assert_eq!(to_app_config(first).unwrap().config_revision, old_revision);
        let read = read_stored_config().unwrap();
        assert_eq!(read.config_revision, second.config_revision);
        let disk = fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(!disk.contains("config_revision"));
        assert!(!disk.contains("api_key_revision"));
        assert!(!disk.contains("usage_token_revision"));
        let before_failure = revision();
        assert!(edit_config(|_| Err("synthetic failure".into())).is_err());
        assert_eq!(revision(), before_failure);
    }

    #[cfg(windows)]
    #[test]
    fn n05_key_and_token_versions_change_only_after_their_successful_commits() {
        let _dir = TempConfigDir::new("n05_credential_versions");
        let key =
            edit_validated_credential(ValidatedCredential::ApiKey, "SYNTHETIC_KEY".into()).unwrap();
        let token =
            edit_validated_credential(ValidatedCredential::UsageToken, "SYNTHETIC_TOKEN".into())
                .unwrap();
        assert_eq!(token.api_key_revision, key.api_key_revision);
        assert!(token.usage_token_revision > key.usage_token_revision);
        let same_key =
            edit_validated_credential(ValidatedCredential::ApiKey, "SYNTHETIC_KEY".into()).unwrap();
        assert!(same_key.api_key_revision > key.api_key_revision);
        assert_eq!(same_key.usage_token_revision, token.usage_token_revision);
        let cleared = edit_config(|stored| {
            stored.api_key = None;
            Ok(())
        })
        .unwrap();
        assert!(cleared.api_key_revision > same_key.api_key_revision);
        assert_eq!(cleared.usage_token_revision, token.usage_token_revision);
        let public = to_app_config(cleared).unwrap();
        assert!(!public.api_key_configured);
        assert!(public.usage_token_configured);
    }

    #[test]
    fn api_key_预览_过短不展示片段() {
        assert_eq!(api_key_preview(""), "已保存");
        assert_eq!(api_key_preview("sk-123456789"), "已保存");
        // 恰好 12 字符：按 <= 12 处理
        assert_eq!(api_key_preview("123456789012"), "已保存");
    }

    #[test]
    fn api_key_预览_前七后四() {
        assert_eq!(api_key_preview("sk-abcdefghijklmnop"), "sk-abcd...mnop");
    }

    #[test]
    fn api_key_预览_按字符而非字节切分() {
        // 中文/多字节字符不能被截断成半个字符（chars() 而非字节切片的理由）
        let preview = api_key_preview("密钥一二三四五六七八九十甲乙丙丁");
        assert_eq!(preview, "密钥一二三四五...甲乙丙丁");
    }

    #[test]
    fn 转前端结构_空字符串凭据视为未配置() {
        let _dir = TempConfigDir::new("to_app_config_empty");
        let config = StoredConfig {
            api_key: Some(String::new()),
            usage_token: Some(String::new()),
            ..StoredConfig::with_defaults()
        };
        let app_config = to_app_config(config).unwrap();
        assert!(!app_config.api_key_configured);
        assert_eq!(app_config.api_key_preview, None);
        assert!(!app_config.usage_token_configured);
    }

    #[test]
    fn 转前端结构_凭据只出预览不出原文() {
        let _dir = TempConfigDir::new("to_app_config_preview");
        let secret = "sk-verysecretvalue123456";
        let config = StoredConfig {
            api_key: Some(secret.to_string()),
            usage_token: Some("usage-secret-token".to_string()),
            ..StoredConfig::with_defaults()
        };
        let app_config = to_app_config(config).unwrap();
        let serialized = serde_json::to_string(&app_config).unwrap();
        assert!(app_config.api_key_configured);
        assert!(app_config.usage_token_configured);
        assert!(
            !serialized.contains(secret),
            "序列化结果里不应出现完整 API Key"
        );
        assert!(
            !serialized.contains("usage-secret-token"),
            "序列化结果里不应出现完整用量 Token"
        );
    }
}
