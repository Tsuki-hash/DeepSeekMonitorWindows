//! Explicit home roots only. WSL listing never runs install/start/Linux commands.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceOptions {
    pub include_default: bool,
    pub homes: Vec<String>,
    pub tool_paths: Vec<ToolPath>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolPath {
    pub tool: String,
    pub path: String,
}
impl Default for SourceOptions {
    fn default() -> Self {
        Self {
            include_default: true,
            homes: vec![],
            tool_paths: vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum HomeKind {
    Native,
    Wsl { distro: String },
}
pub fn clean_home(value: &str) -> Result<(String, HomeKind), String> {
    clean_path(value, true)
}
pub fn clean_tool_path(value: &str) -> Result<(String, HomeKind), String> {
    clean_path(value, false)
}
fn clean_path(value: &str, home_only: bool) -> Result<(String, HomeKind), String> {
    let value = value.trim().replace('/', "\\");
    if value.is_empty()
        || value.len() > 1024
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '*' | '?'))
    {
        return Err("目录格式不可用，请填写本地或WSL的绝对主目录".into());
    }
    let value = value.trim_end_matches('\\').to_string();
    if value
        .split('\\')
        .any(|p| matches!(p, "." | "..") || p.ends_with('.') || p.ends_with(' '))
    {
        return Err("目录不能包含相对层级、尾随点或空格".into());
    }
    if let Some(rest) = value.strip_prefix("\\\\") {
        let parts: Vec<_> = rest.split('\\').collect();
        if parts.len() < 3
            || !matches!(
                parts[0].to_ascii_lowercase().as_str(),
                "wsl$" | "wsl.localhost"
            )
            || parts.iter().any(|p| p.is_empty() || p.contains(':'))
        {
            return Err("仅支持本地盘或WSL目录，不支持其他网络共享".into());
        }
        if home_only
            && !((parts.len() == 4 && parts[2] == "home")
                || (parts.len() == 3 && parts[2] == "root"))
        {
            return Err("WSL请填写用户主目录，例如\\\\wsl.localhost\\Ubuntu\\home\\user".into());
        }
        return Ok((
            format!("\\\\wsl.localhost\\{}", parts[1..].join("\\")),
            HomeKind::Wsl {
                distro: parts[1].into(),
            },
        ));
    }
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || value[2..].contains(':')
        || value[3..].split('\\').any(|p| p.is_empty())
    {
        return Err("请填写本地绝对主目录，不能使用盘符根目录、相对路径或环境变量".into());
    }
    Ok((value, HomeKind::Native))
}
pub fn home_key(value: &str) -> String {
    let value = value
        .replace("\\\\?\\UNC\\", "\\\\")
        .trim_start_matches("\\\\?\\")
        .replace('/', "\\");
    if let Ok((clean, HomeKind::Wsl { distro })) = clean_tool_path(&value) {
        let tail = clean.split('\\').skip(4).collect::<Vec<_>>().join("/");
        format!("wsl:{}:{tail}", distro.to_lowercase())
    } else {
        value.trim_end_matches('\\').to_lowercase()
    }
}
pub fn source_id(home: &str) -> String {
    format!("home-{:x}", Sha256::digest(home_key(home).as_bytes()))
}
pub fn validate_options(options: SourceOptions) -> Result<SourceOptions, String> {
    if options.homes.len() > 3 {
        return Err("最多添加3个额外主目录".into());
    }
    if !options.include_default && options.homes.is_empty() && options.tool_paths.is_empty() {
        return Err("请保留默认目录或至少添加一个主目录".into());
    }
    let mut seen = BTreeSet::new();
    let mut homes = Vec::new();
    for value in options.homes {
        let (clean, _) = clean_home(&value)?;
        if !seen.insert(home_key(&clean)) {
            return Err("主目录重复，请保留一项".into());
        }
        homes.push(clean);
    }
    if options.tool_paths.len() > 3 {
        return Err("最多添加3个单工具路径".into());
    }
    let mut tool_paths = Vec::new();
    let mut tools = BTreeSet::new();
    for entry in options.tool_paths {
        if !matches!(
            entry.tool.as_str(),
            "opencode" | "zcode" | "claude" | "hermes" | "openclaw" | "dsh"
        ) {
            return Err("此工具不支持单路径，请使用用户主目录入口".into());
        }
        if !tools.insert(entry.tool.clone()) {
            return Err("每款工具只能设置一个额外路径".into());
        }
        let (path, _) = clean_tool_path(&entry.path)?;
        if entry.tool == "zcode"
            && (path.starts_with("\\\\")
                || ![".db", ".sqlite", ".sqlite3"]
                    .iter()
                    .any(|suffix| path.to_ascii_lowercase().ends_with(suffix)))
        {
            return Err("ZCode请填写本地SQLite数据库文件，不支持WSL或WAL/SHM文件".into());
        }
        if entry.tool == "opencode" {
            let name = path.rsplit('\\').next().unwrap_or("");
            let stem = name
                .strip_suffix(".db")
                .ok_or("OpenCode请填写opencode.db或opencode-渠道.db文件")?;
            if stem != "opencode"
                && !stem.strip_prefix("opencode-").is_some_and(|s| {
                    !s.is_empty()
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                })
            {
                return Err("OpenCode数据库名称不可用，不能选择WAL/SHM文件".into());
            }
        }
        tool_paths.push(ToolPath {
            tool: entry.tool,
            path,
        });
    }
    Ok(SourceOptions {
        include_default: options.include_default,
        homes,
        tool_paths,
    })
}
fn preference_path() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-sources.json"))
}
pub fn load() -> Result<SourceOptions, String> {
    let path = preference_path()?;
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Ok(m) if m.len() <= 16384 => {}
        _ => return Err("采集目录设置无法读取".into()),
    }
    let options = serde_json::from_slice(&std::fs::read(path).map_err(|_| "采集目录设置无法读取")?)
        .map_err(|_| "采集目录设置损坏，请重新保存")?;
    validate_options(options)
}
pub fn save(options: &SourceOptions) -> Result<(), String> {
    let path = preference_path()?;
    std::fs::create_dir_all(path.parent().ok_or("采集目录不可用")?)
        .map_err(|_| "采集目录设置无法保存")?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(options).map_err(|_| "采集目录格式不可用")?,
    )
    .map_err(|_| "采集目录设置无法保存")?;
    std::fs::rename(temp, path).map_err(|_| "采集目录设置无法保存".into())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub state: String,
    pub distros: Vec<String>,
}
pub fn decode_distros(data: &[u8]) -> Result<Vec<String>, String> {
    if data.len() > 65536 {
        return Err("WSL列表过大".into());
    }
    let text = if data.starts_with(&[0xff, 0xfe]) || data.iter().skip(1).step_by(2).any(|b| *b == 0)
    {
        if !data.len().is_multiple_of(2) {
            return Err("WSL列表编码不可用".into());
        }
        String::from_utf16(
            &data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "WSL列表编码不可用")?
    } else {
        String::from_utf8(data.to_vec()).map_err(|_| "WSL列表编码不可用")?
    };
    let mut distros = BTreeSet::new();
    for name in text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if name.len() > 128
            || name.chars().any(|c| {
                c.is_control() || matches!(c, '\\' | '/' | ':' | '"' | '<' | '>' | '|' | '?' | '*')
            })
            || name.ends_with('.')
            || matches!(name, "." | "..")
        {
            return Err("WSL发行版名称格式不可用".into());
        }
        distros.insert(name.to_string());
    }
    if distros.len() > 32 {
        return Err("WSL发行版过多".into());
    }
    Ok(distros.into_iter().collect())
}
#[cfg(windows)]
pub async fn running_wsl() -> Result<WslStatus, String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ},
        RegKey,
    };
    let registered = {
        let registry = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
            KEY_READ,
        ) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WslStatus {
                    state: "not-installed".into(),
                    distros: vec![],
                })
            }
            Err(_) => return Err("WSL安装信息无法读取".into()),
            Ok(key) => key,
        };
        let mut names = Vec::new();
        for key in registry.enum_keys().take(33) {
            let key = key.map_err(|_| "WSL注册信息无法读取")?;
            let distro = registry
                .open_subkey_with_flags(key, KEY_READ)
                .map_err(|_| "WSL注册信息无法读取")?;
            let name: String = distro
                .get_value("DistributionName")
                .map_err(|_| "WSL注册信息无法读取")?;
            names.push(name);
        }
        if names.is_empty() {
            return Ok(WslStatus {
                state: "not-installed".into(),
                distros: vec![],
            });
        }
        if names.len() > 32 {
            return Err("WSL发行版过多".into());
        }
        names
    };
    let executable = PathBuf::from(std::env::var_os("SystemRoot").ok_or("系统目录不可用")?)
        .join("System32/wsl.exe");
    let mut command = tokio::process::Command::new(executable);
    command
        .args(["--list", "--quiet", "--running"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "WSL列表无法读取")?;
    let mut data = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        child
            .stdout
            .take()
            .ok_or("WSL输出不可用")?
            .take(65537)
            .read_to_end(&mut data)
            .await
            .map_err(|_| "WSL列表无法读取")?;
        if data.len() > 65536 || !child.wait().await.map_err(|_| "WSL状态不可用")?.success() {
            return Err("WSL列表无法读取");
        }
        Ok(())
    })
    .await
    .map_err(|_| "WSL列表读取超时")??;
    let distros = decode_distros(&data)?;
    if distros.iter().any(|name| {
        !registered
            .iter()
            .any(|known| known.eq_ignore_ascii_case(name))
    }) {
        return Err("WSL列表包含未注册的发行版，未访问目录".into());
    }
    Ok(WslStatus {
        state: if distros.is_empty() {
            "not-running"
        } else {
            "ok"
        }
        .into(),
        distros,
    })
}
#[cfg(not(windows))]
pub async fn running_wsl() -> Result<WslStatus, String> {
    Ok(WslStatus {
        state: "not-supported".into(),
        distros: vec![],
    })
}

/// A timed-out filesystem call can continue inside Windows. One permit bounds all
/// outstanding probes, so repeated refreshes cannot accumulate blocked threads.
pub async fn probe_home(home: PathBuf) -> Result<PathBuf, String> {
    probe_path(home, true).await
}
pub async fn probe_path(home: PathBuf, directory: bool) -> Result<PathBuf, String> {
    static PROBE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = PROBE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "目录检查尚未结束，请稍后重试")?;
    tokio::time::timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let metadata = std::fs::metadata(&home).map_err(|_| "路径不存在或无法访问")?;
            if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
                return Err(if directory {
                    "请选择目录，不能选择文件"
                } else {
                    "请选择数据库文件，不能选择目录"
                }
                .into());
            }
            std::fs::canonicalize(home).map_err(|_| "主目录无法解析".into())
        }),
    )
    .await
    .map_err(|_| "主目录检查超时")?
    .map_err(|_| "主目录检查失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 单工具路径类型容量重复与旧配置兼容() {
        let options: SourceOptions =
            serde_json::from_str(r#"{"includeDefault":true,"homes":[]}"#).unwrap();
        assert!(options.tool_paths.is_empty());
        let build = |tool: &str, path: &str| SourceOptions {
            include_default: false,
            homes: vec![],
            tool_paths: vec![ToolPath {
                tool: tool.into(),
                path: path.into(),
            }],
        };
        assert!(validate_options(build("opencode", r"D:\Logs\opencode-stable.1.db")).is_ok());
        for (tool, path) in [
            ("opencode", r"D:\Logs\opencode.db-wal"),
            ("opencode", r"D:\Logs\custom.db"),
            ("zcode", r"D:\Logs\db.sqlite-wal"),
            ("claude", r"\\server\share\user"),
            ("hermes", ""),
        ] {
            assert!(validate_options(build(tool, path)).is_err());
        }
        let mut repeated = build("claude", r"D:\Logs\projects");
        repeated.tool_paths.push(repeated.tool_paths[0].clone());
        assert!(validate_options(repeated).is_err());
        let mut oversized = build("claude", r"D:\Logs\projects");
        oversized
            .tool_paths
            .resize(4, oversized.tool_paths[0].clone());
        assert!(validate_options(oversized).is_err());
    }
    #[test]
    fn zcode仅接受本地数据库_拒绝wsl与旁文件() {
        let build = |path: &str| SourceOptions {
            include_default: false,
            homes: vec![],
            tool_paths: vec![ToolPath {
                tool: "zcode".into(),
                path: path.into(),
            }],
        };
        for path in [
            r"D:\Logs\db.sqlite",
            r"D:\Logs\usage.DB",
            r"D:\Logs\data.sqlite3",
        ] {
            assert!(validate_options(build(path)).is_ok());
        }
        for path in [
            r"D:\Logs\db.sqlite-wal",
            r"D:\Logs\db.sqlite-shm",
            r"D:\Logs",
            r"\\wsl$\Ubuntu\home\User\db.sqlite",
        ] {
            assert!(validate_options(build(path)).is_err());
        }
    }
    #[test]
    fn wsl单工具深层路径门类与大小写_主目录入口仍受限() {
        for (tool, tail) in [
            ("opencode", r".local\share\opencode\opencode.db"),
            ("claude", r".claude\projects"),
            ("hermes", r".hermes"),
            ("openclaw", r".openclaw\agents"),
            ("dsh", r".dsh\sessions"),
        ] {
            let path = format!(r"\\wsl$\Ubuntu\home\User\{tail}");
            let options = validate_options(SourceOptions {
                include_default: false,
                homes: vec![],
                tool_paths: vec![ToolPath {
                    tool: tool.into(),
                    path: path.clone(),
                }],
            })
            .unwrap();
            assert!(options.tool_paths[0]
                .path
                .starts_with(r"\\wsl.localhost\Ubuntu\home\User\"));
            assert!(clean_home(&path).is_err());
        }
        assert_eq!(
            home_key(r"\\wsl$\Ubuntu\home\User\.claude\projects"),
            home_key(r"\\wsl.localhost\ubuntu\home\User\.claude\projects")
        );
        assert_ne!(
            home_key(r"\\wsl$\Ubuntu\home\User\.claude\projects"),
            home_key(r"\\wsl$\Ubuntu\home\user\.claude\projects")
        );
        assert!(clean_tool_path(r"\\wsl$\Ubuntu").is_err());
    }
    #[test]
    fn 路径类型和相对根目录网络设备路径拒绝() {
        assert!(matches!(
            clean_home("D:/Users/Aaron").unwrap().1,
            HomeKind::Native
        ));
        assert!(matches!(
            clean_home(r"\\wsl$\Ubuntu\home\user").unwrap().1,
            HomeKind::Wsl { .. }
        ));
        for value in [
            r"C:\",
            r"C:Users",
            r"\Users\a",
            "/home/a",
            r"\\server\share\user",
            r"\\?\C:\Users\a",
            r"D:\A\..\B",
            r"D:\A:stream",
            r"D:\A\B.",
            r"\\wsl$\Ubuntu\home",
        ] {
            assert!(clean_home(value).is_err(), "{value}");
        }
    }
    #[test]
    fn 默认与容量重复校验_wsl别名去重并保留_linux大小写() {
        assert!(SourceOptions::default().include_default);
        assert!(validate_options(SourceOptions {
            include_default: false,
            homes: vec![],
            ..Default::default()
        })
        .is_err());
        assert!(validate_options(SourceOptions {
            include_default: true,
            homes: vec![r"C:\Users\A".into(), r"c:\users\a".into()],
            ..Default::default()
        })
        .is_err());
        assert_eq!(
            home_key(r"\\wsl$\Ubuntu\home\User"),
            home_key(r"\\wsl.localhost\ubuntu\home\User")
        );
        assert_ne!(
            home_key(r"\\wsl$\Ubuntu\home\User"),
            home_key(r"\\wsl$\Ubuntu\home\user")
        );
        assert_ne!(source_id(r"D:\Users\A"), source_id(r"D:\Users\B"));
    }
    #[test]
    fn wsl列表解码拒绝混入命令和畸形结果() {
        let bytes = "Ubuntu\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_distros(&bytes).unwrap(), vec!["Debian", "Ubuntu"]);
        assert!(decode_distros(b"Ubuntu\\cmd").is_err());
        assert_eq!(decode_distros(b"Ubuntu Test").unwrap(), vec!["Ubuntu Test"]);
        assert_eq!(decode_distros(b"").unwrap(), Vec::<String>::new());
        assert!(decode_distros(&[0xff, 0xfe, 0x01]).is_err());
    }
    #[test]
    fn 设置独立持久化_失败保持原文件() {
        let dir = crate::test_support::TempConfigDir::new("local-sources");
        let options = validate_options(SourceOptions {
            include_default: true,
            homes: vec![r"D:\Users\Extra".into()],
            ..Default::default()
        })
        .unwrap();
        save(&options).unwrap();
        assert_eq!(load().unwrap(), options);
        std::fs::create_dir(dir.join("local-usage-sources.tmp")).unwrap();
        assert!(save(&Default::default()).is_err());
        assert_eq!(load().unwrap(), options);
    }
}
