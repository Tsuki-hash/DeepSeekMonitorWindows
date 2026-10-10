//! 配置持久化。
//!
//! 这里放的是 `StoredConfig` / `AppConfig` 以及它们的读写与规范化。原先这些定义都嵌在
//! `lib.rs` 的 `run()` 内部，`#[cfg(test)]` 模块在文件顶层拿不到它们，导致配置层
//! （H-1 缺字段回退、H-2 原子写入与损坏自愈）完全没有回归测试保护。提升到模块顶层后
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
    Ok(config)
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
    write_stored_config_unlocked(&config)?;
    credential_counter(kind).fetch_add(1, Ordering::SeqCst);
    changed().notify_one();
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

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct StoredConfig {
    #[serde(skip)]
    pub config_warnings: Vec<String>,
    // 放在首位，便于人工查看 config.json 时一眼看到格式版本
    #[serde(default)]
    pub version: u32,
    pub api_key: Option<String>,
    #[serde(default)]
    pub usage_token: Option<String>,
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
    /// 缺文件 / 配置损坏时的默认配置。
    pub fn with_defaults() -> Self {
        Self {
            refresh_interval_seconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
            ..Self::default()
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub config_warnings: Vec<String>,
    pub api_key_configured: bool,
    pub api_key_preview: Option<String>,
    pub usage_token_configured: bool,
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

/// 读取配置。任何异常都不向上传播：
/// - 文件不存在 → 返回默认值（首次运行）；
/// - 解析失败 → 把损坏文件改名留证，返回默认值（H-2 的自愈路径）。
///
/// 之所以把「解析失败」也降级为 Ok：`read_stored_config` 是所有命令的前置步骤，
/// 一旦它返回 Err，设置页、余额、用量、全部保存动作会一起失效，用户只会看到
/// 一个与真实原因无关的报错。回退默认值 + 留证文件，用户重填一次凭据即可恢复。
///
/// 凭据字段在返回前解密（M-1）。迁移：只要读到的是旧格式（无版本号标记的明文），
/// 就顺手回写一份加密的。回写失败不影响本次读取——用户拿到可用的配置比迁移成功更重要。
pub fn read_stored_config() -> Result<StoredConfig, String> {
    let _guard = lock_config_io();
    read_stored_config_unlocked()
}

fn read_stored_config_unlocked() -> Result<StoredConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(StoredConfig::with_defaults());
    }

    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut config: StoredConfig = match serde_json::from_str(&text) {
        Ok(config) => config,
        Err(error) => {
            let backup = backup_corrupt_config(&path)?;
            log::warn!(
                "配置文件解析失败，已备份到 {} 并重置：{error}",
                backup.display()
            );
            return Ok(StoredConfig::with_defaults());
        }
    };
    config.refresh_interval_seconds =
        normalize_refresh_interval_seconds(config.refresh_interval_seconds);

    let needs_migration = decrypt_credentials(&mut config);
    if needs_migration {
        // 明文凭据已还原到内存，此处回写即完成「读取时自动加密」。
        // 已持有 config_io_lock，必须走 unlocked 写，避免自锁。
        if let Err(error) = write_stored_config_unlocked(&config) {
            log::warn!("凭据加密迁移回写失败（本次读取不受影响）：{error}");
            config
                .config_warnings
                .push("旧配置凭据尚未成功加密，请检查 Windows 加密服务并重新保存".into());
        }
    }

    Ok(config)
}

/// 原地解密配置里的凭据字段。返回是否需要回写迁移。
///
/// 三类输入的区别要分清：
/// - **密文**：正常路径，解出来替换掉字段值；
/// - **明文**（迁移期的旧文件、或用户手工编辑）：原样保留，标记需要迁移；
/// - **密文但解不开**（异机拷贝、DPAPI 密钥丢失）：置空并告警。保留一个解不开的
///   字符串没有意义——后续每次请求都会失败，不如让界面回到「未配置」提示用户重填。
fn decrypt_credentials(config: &mut StoredConfig) -> bool {
    let mut migrated = false;
    for field in [&mut config.api_key, &mut config.usage_token] {
        let Some(stored) = field.as_ref() else {
            continue;
        };
        if stored.is_empty() || !credentials::is_ciphertext(stored) {
            // 非空明文 → 迁移期格式，需要回写加密
            if !stored.is_empty() {
                migrated = true;
            }
            continue;
        }
        match credentials::decrypt(stored) {
            Some(Ok(plain)) => *field = Some(plain),
            Some(Err(error)) => {
                log::warn!("凭据解密失败，已清空该字段等待用户重填：{error}");
                *field = None;
                config
                    .config_warnings
                    .push("本机无法解密旧凭据，请重新填写".into());
            }
            // is_ciphertext 为真时 decrypt 必然返回 Some
            None => *field = None,
        }
    }
    migrated
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

/// 把损坏的配置改名留证。时间戳用「秒 + 进程内自增序号」，
/// 避免同一秒内多次触发时覆盖掉前一次的留证文件。
fn backup_corrupt_config(path: &PathBuf) -> Result<PathBuf, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let backup = path.with_extension(format!("json.corrupt-{stamp}-{seq}"));
    fs::rename(path, &backup).map_err(|error| error.to_string())?;
    Ok(backup)
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
    write_stored_config_unlocked(config)
}

fn write_stored_config_unlocked(config: &StoredConfig) -> Result<(), String> {
    write_stored_config_with(config, encrypt_credentials)
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
    CONFIG_REVISION.fetch_add(1, Ordering::SeqCst);
    changed().notify_one();
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
        config_warnings: config.config_warnings,
        api_key_configured: api_key_preview.is_some(),
        api_key_preview,
        usage_token_configured,
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
    fn 损坏的配置_回退默认值_并留下备份文件() {
        // H-2 的自愈路径：半截 JSON 不能演变成全链路失效，且原文件必须留证。
        let dir = TempConfigDir::new("read_corrupt");
        let path = config_path().unwrap();
        fs::write(&path, r#"{"api_key":"sk-abc","refresh"#).unwrap();

        let config = read_stored_config().unwrap();
        assert_eq!(config.refresh_interval_seconds, 60);
        assert_eq!(config.api_key, None);
        assert!(!path.exists(), "损坏文件应已被改名移走");

        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("config.json.corrupt-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "应恰好留下一个备份文件");
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

    /// 是否具备 DPAPI 能力。非 Windows 或 DPAPI 调用失败时为 false，
    /// 此时加密相关断言自动跳过（回退明文是设计上允许的行为）。
    fn dpapi_available() -> bool {
        credentials::encrypt("probe").is_some()
    }

    #[test]
    fn 落盘的凭据是密文_不是明文() {
        if !dpapi_available() {
            return;
        }
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
        if !dpapi_available() {
            return;
        }
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
        if !dpapi_available() {
            return;
        }
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
    fn 解不开的密文_凭据置空_其余字段保留() {
        if !dpapi_available() {
            return;
        }
        // 模拟「config.json 从另一台机器拷贝过来」：密文格式正确但本机 DPAPI 解不开。
        // 期望：凭据字段清空（让界面回到「未配置」提示重填），
        // 但刷新间隔等非凭据设置必须原样保留。
        let _dir = TempConfigDir::new("m1_foreign");
        let path = config_path().unwrap();
        // 构造一段前缀正确、base64 合法、但不是 DPAPI 密文的内容——
        // 直接模拟异机凭据即可，不必真去另一台机器上加密。
        fs::write(
            &path,
            r#"{"version":1,"api_key":"DSM1:AAAAAAAAAAAAAAAAAAAAAA==","refresh_interval_seconds":1800,"autostart":true}"#,
        )
        .unwrap();

        let config = read_stored_config().unwrap();
        assert_eq!(config.api_key, None, "解不开的凭据应被清空");
        assert_eq!(config.refresh_interval_seconds, 1800, "非凭据设置应保留");
        assert!(config.autostart, "非凭据设置应保留");
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
