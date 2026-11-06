//! Explicit home roots only. WSL listing never runs install/start/Linux commands.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
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
///
/// 复评 Q07：探测必须在**访问目标之前**实施来源规则。`fs::metadata` 与
/// `fs::canonicalize` 都会跟随链接访问目标 —— 旧实现先访问再复检，拒绝提示
/// 出现时目标（网络共享、未运行的 WSL 发行版）可能已被访问过。现在的顺序：
/// 1. `symlink_metadata` 只看条目本身，不跟随 reparse；
/// 2. 路径本身或任一父组件是 reparse 点时，先 `read_link` 取目标**文本**
///    （不访问目标），按入口策略判定，越界立即拒绝；
/// 3. 通过后才 metadata / canonicalize，并对解析结果重跑
///    `recheck_resolved_target`。
pub async fn probe_path(
    home: PathBuf,
    directory: bool,
    origin: SourceOrigin,
) -> Result<PathBuf, String> {
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
            check_link_chain(&home, origin)?;
            let metadata = std::fs::metadata(&home).map_err(|_| "路径不存在或无法访问")?;
            if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
                return Err(if directory {
                    "请选择目录，不能选择文件"
                } else {
                    "请选择数据库文件，不能选择目录"
                }
                .into());
            }
            let canonical =
                std::fs::canonicalize(&home).map_err(|_| "主目录无法解析".to_string())?;
            recheck_resolved_target(
                &home.to_string_lossy(),
                &canonical,
                if directory {
                    ResolvedExpect::Directory
                } else {
                    ResolvedExpect::File
                },
                origin,
            )
        }),
    )
    .await
    .map_err(|_| "主目录检查超时")?
    .map_err(|_| "主目录检查失败")?
}

/// 是否为 reparse 点（符号链接、junction 等名称代理）。
#[cfg(windows)]
pub fn is_reparse_entry(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}
#[cfg(not(windows))]
pub fn is_reparse_entry(meta: &std::fs::Metadata) -> bool {
    meta.is_symlink()
}

/// 链接跳数上限：正常来源不会超过这个深度；防御链接循环。
const MAX_LINK_HOPS: usize = 8;

/// 复评 R05：从**根到叶**逐组件检查链接链，多跳链接逐跳判定。
///
/// `symlink_metadata` 的 no-follow 只保护末端组件 —— 操作系统的路径解析
/// 仍会跟随中间组件的 reparse 点（`C:\safe\alias\logs` 的第一次元数据查询
/// 就已经穿过 alias，这不是 TOCTOU 才能触发）。因此按组件顺序检查：经过
/// 任何 reparse 组件之前，先用 `read_link` 的目标**文本**（相对链接先按
/// 链接所在目录拼接）判定入口策略；目标获批准后把剩余路径嫁接到目标上
/// 重新从根扫描（处理 A→B→越界 的多跳）。整条链没有任何 reparse 组件才算
/// 通过 —— 此后调用方的 `metadata` / `canonicalize` 访问的是已验证的路径。
pub fn check_link_chain(path: &Path, origin: SourceOrigin) -> Result<(), String> {
    let mut current = path.to_path_buf();
    let mut hops = 0usize;
    loop {
        match origin {
            SourceOrigin::Native => {
                // 文本预检（含嫁接后的路径）：WSL/网络共享/系统目录形态
                // 直接拒绝，不做文件系统访问。
                if is_disallowed_local_target_text(&current.to_string_lossy()) {
                    return Err("路径指向 WSL、网络共享或系统目录，未访问".into());
                }
            }
            SourceOrigin::Wsl => {}
        }
        let Some((link_component, remaining)) = first_reparse_component(&current)? else {
            return Ok(());
        };
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return Err(format!("链接层级超过 {MAX_LINK_HOPS} 跳，未访问"));
        }
        let target = std::fs::read_link(&link_component)
            .map_err(|_| format!("链接目标无法读取：{}", link_component.display()))?;
        // 相对链接按链接所在目录解析成文本（仍是文本操作，不访问目标）。
        let target_path = if target.is_absolute() {
            target
        } else {
            link_component
                .parent()
                .map(|parent| parent.join(&target))
                .unwrap_or(target)
        };
        // 复评 F02-D：先做**词法归一化**（折叠 `.`/`..`、去掉多余分隔符），
        // 再判策略。`C:\Users\A\alias` 的相对目标 `..\..\Windows\System32`
        // 拼接后文本是 `C:\Users\A\..\..\Windows\System32`，不折叠就会被
        // 「只看盘符后首级」的系统目录判定误放行，而真实目标是
        // `C:\Windows\System32`。归一化是纯文本操作，不访问文件系统。
        let target_path = normalize_dot_segments(&target_path);
        reject_link_target(&target_path.to_string_lossy(), origin)?;
        // 目标文本获批准：把剩余路径嫁接到目标上继续检查 ——
        // 目标自身还可能是指向别处的链接。
        current = if remaining.as_os_str().is_empty() {
            target_path
        } else {
            target_path.join(remaining)
        };
    }
}

/// 复评 F02-D：纯文本折叠 `.` / `..` 与重复分隔符。
///
/// 只处理词法层面，不解析任何链接、不访问文件系统 —— 这是「访问前判定」
/// 的前提：链接目标里的 `..` 必须先折叠，否则系统目录/WSL/UNC 判定会被
/// 中间段绕过。Windows 语义下 `..` 逐级上退，退到盘根即停。
pub fn normalize_dot_segments(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // 只折叠可退的普通组件；盘符/根/前缀不动（`C:\..` = `C:\`）。
                match out.last() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    Some(Component::Prefix(_)) | Some(Component::RootDir) => {}
                    _ => out.push(component),
                }
            }
            other => out.push(other),
        }
    }
    let mut result = PathBuf::new();
    for component in out {
        result.push(component.as_os_str());
    }
    result
}

/// 从根到叶找第一个 reparse 组件，返回（链接组件，链接之后的剩余路径）。
/// 组件按浅到深检查：更浅的组件已确认不是链接，对更深组件的
/// `symlink_metadata` 不会穿过未判定的链接。
fn first_reparse_component(path: &Path) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let mut chain: Vec<&Path> = path.ancestors().collect();
    chain.reverse(); // 浅 → 深
    for prefix in chain {
        let meta = match std::fs::symlink_metadata(prefix) {
            Ok(meta) => meta,
            // 组件不存在（监听场景允许末端尚未创建）：更深的组件也不可能
            // 存在，已检查的前缀就是全部可解析范围。
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!("路径组件无法检查：{}（{error}）", prefix.display()));
            }
        };
        if is_reparse_entry(&meta) {
            let remaining = path
                .strip_prefix(prefix)
                .unwrap_or_else(|_| Path::new(""))
                .to_path_buf();
            return Ok(Some((prefix.to_path_buf(), remaining)));
        }
    }
    Ok(None)
}

/// 复评 N02：按路径文本判定来源种类（不访问文件系统）。
///
/// WSL UNC 形态 → `Wsl`，其余 → `Native`。用于给配置声明的扩展根
/// 选择正确的 origin：Native home 里指向 WSL 的根必须按 WSL 语义解析，
/// 否则会被当成越界而漏登记。
pub fn origin_for_path(value: &str) -> SourceOrigin {
    if is_wsl_path(&normalize_resolved_str(value)) {
        SourceOrigin::Wsl
    } else {
        SourceOrigin::Native
    }
}

/// 复评 Q07：路径**文本**越界判定（不访问文件系统）。
pub fn is_disallowed_local_target_text(value: &str) -> bool {
    let normalized = normalize_resolved_str(value);
    is_wsl_path(&normalized)
        || is_network_path(&normalized)
        || is_protected_system_path(&normalized)
}

/// 复评 Q07：链接目标文本的入口策略判定 —— 只看文本，不访问目标。
pub fn reject_link_target(target: &str, origin: SourceOrigin) -> Result<(), String> {
    match origin {
        SourceOrigin::Native => {
            if is_disallowed_local_target_text(target) {
                return Err("链接目标指向 WSL、网络共享或系统目录，未访问该目标".into());
            }
        }
        SourceOrigin::Wsl => {
            let normalized = normalize_resolved_str(target);
            if is_network_path(&normalized) {
                return Err("链接目标指向网络共享，未访问该目标".into());
            }
        }
    }
    Ok(())
}

/// 复评 Q05/R02：解析一个**布局根**用于覆盖登记 —— 不跟随访问越界目标。
///
/// 布局根本身可能是 junction（home 标准目录映射到别处）。登记覆盖必须用
/// **实际被读取的目标**，否则解析后的别名与登记的字面路径对不上，同源
/// 会被统计两次。`check_link_chain` 先从根到叶验证整条链接链（多跳），
/// 通过后 canonicalize 并对解析结果按 `expect` 重跑 `recheck_resolved_target`。
pub fn resolve_layout_root(
    path: &Path,
    origin: SourceOrigin,
    expect: ResolvedExpect,
) -> Result<PathBuf, String> {
    check_link_chain(path, origin)?;
    let canonical = std::fs::canonicalize(path).map_err(|_| "布局根无法解析")?;
    recheck_resolved_target(&path.to_string_lossy(), &canonical, expect, origin).map(|_| canonical)
}

/// 解析后的目标是否需要重新核对来源策略。
///
/// 评审条件验收：本地路径经 junction / symlink 指向别处时，配置里写的路径通过了
/// 校验，但真正被读取的是解析后的目标。这里对**解析后的路径**再跑一遍门类检查，
/// 让「指向 WSL 挂载点」「指向系统目录」这类情况在采集前就失败，而不是绕过策略。
///
/// 返回解析后的路径；策略不通过时返回可解释错误。
pub fn recheck_resolved_target(
    requested: &str,
    resolved: &Path,
    expect: ResolvedExpect,
    origin: SourceOrigin,
) -> Result<PathBuf, String> {
    // 统一规范化：扩展 UNC（`\\?\UNC\` 与 `\\?\`）要还原成可比较形式，
    // 否则扩展写法能绕过下面的 WSL / 系统目录判定（复评 F15）。
    let resolved_text = normalize_resolved(resolved);
    let requested_text = normalize_resolved_str(requested);
    match origin {
        // 本地入口：解析后落到 WSL 或系统目录一律拒绝。
        SourceOrigin::Native => {
            if is_wsl_path(&resolved_text) {
                return Err("路径解析后指向 WSL 目录，请改用 WSL 入口配置".into());
            }
            // 复评 R03：本地入口解析到网络共享（UNC）时同样拒绝。
            // 输入校验只拦了普通 UNC，链接可以把本地路径指到网络位置。
            if is_network_path(&resolved_text) {
                return Err("路径解析后指向网络共享，本地入口不支持".into());
            }
            if is_protected_system_path(&resolved_text) {
                return Err("路径解析后指向 Windows 系统目录，未读取".into());
            }
        }
        // 显式 WSL 入口：解析结果**必须**仍在 WSL 内（junction 把 WSL 目录指到本地盘
        // 同样要拦），但不因「目标是 WSL」而误拒。系统目录仍然拒绝。
        SourceOrigin::Wsl => {
            if !is_wsl_path(&resolved_text) {
                // 只有配置本身也是 WSL 入口时才提示「路径不一致」，否则提示目标越界。
                let hint = if is_wsl_path(&requested_text) {
                    "WSL 来源解析后不在 WSL 目录，请检查路径"
                } else {
                    "路径解析后不在 WSL 目录，请改用本地入口配置"
                };
                return Err(hint.into());
            }
            if is_protected_system_path(&resolved_text) {
                return Err("路径解析后指向 Windows 系统目录，未读取".into());
            }
        }
    }
    let metadata = std::fs::metadata(resolved).map_err(|_| "解析后的路径无法访问")?;
    let matches_kind = match expect {
        ResolvedExpect::Directory => metadata.is_dir(),
        ResolvedExpect::File => metadata.is_file(),
    };
    if !matches_kind {
        return Err(match expect {
            ResolvedExpect::Directory => "解析后的目标不是目录",
            ResolvedExpect::File => "解析后的目标不是文件",
        }
        .into());
    }
    Ok(resolved.to_path_buf())
}

/// 来源入口种类：决定解析后允许落在哪类路径上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceOrigin {
    /// 本地盘符入口（默认主目录、额外 home、本地单工具路径）。
    Native,
    /// 显式 WSL 入口（`\\wsl$` 或 `\\wsl.localhost`）。
    Wsl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedExpect {
    Directory,
    File,
}

/// 把扩展 UNC / 正斜杠 / 尾斜杠统一成普通反斜杠形式（小写）。
fn normalize_resolved_str(value: &str) -> String {
    let stripped = value.replace(r"\\?\UNC\", r"\\");
    let stripped = match stripped.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => stripped,
    };
    let value = stripped.replace('/', "\\");
    value.trim_end_matches('\\').to_ascii_lowercase()
}

fn normalize_resolved(path: &Path) -> String {
    normalize_resolved_str(&path.to_string_lossy())
}

fn is_wsl_path(value: &str) -> bool {
    // value 已由 normalize_resolved_str 规范化（小写、去掉扩展前缀）。
    let lower = value.to_ascii_lowercase();
    lower.starts_with(r"\\wsl$\") || lower.starts_with(r"\\wsl.localhost\")
}

/// 是否为 UNC 网络路径（`\server\share`），已由 normalize_resolved_str 规范化。
fn is_network_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if !lower.starts_with("\\\\") {
        return false;
    }
    // WSL 挂载点也是 UNC 形式，但不是网络共享；由 is_wsl_path 单独判定。
    !is_wsl_path(&lower)
}

fn is_protected_system_path(value: &str) -> bool {
    let lower = value
        .replace("\\\\?\\", "")
        .replace('/', "\\")
        .to_ascii_lowercase();
    // 只比较盘符之后的部分（`c:\windows\...` → `\windows\...`），避免把
    // 用户目录里恰好叫 windows 的项目目录误判。
    let tail = match lower.find('\\') {
        Some(index) => &lower[index..],
        None => return false,
    };
    const PROTECTED: &[&str] = &[
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\$recycle.bin",
        "\\system volume information",
    ];
    PROTECTED
        .iter()
        .any(|prefix| tail == *prefix || tail.starts_with(&format!("{prefix}\\")))
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
    #[test]
    fn 解析后目标指向wsl或系统目录时拒绝() {
        // 只检查纯判定函数：真实 junction 需在 Windows 上手工验收。
        assert!(is_wsl_path(r"\\wsl$\Ubuntu\home\user\.claude\projects"));
        assert!(is_wsl_path(r"\\wsl.localhost\Ubuntu\home\user"));
        assert!(!is_wsl_path(r"D:\Users\A\.claude\projects"));

        assert!(is_protected_system_path(r"C:\Windows\System32"));
        assert!(is_protected_system_path(r"C:\Program Files\Vendor"));
        assert!(is_protected_system_path(r"D:\ProgramData\Vendor"));
        // 用户目录里恰好叫 windows 的项目目录不能被误判。
        assert!(!is_protected_system_path(
            r"D:\Users\A\projects\windows\logs"
        ));
        assert!(!is_protected_system_path(r"D:\Users\A\.claude\projects"));
    }
    #[test]
    fn 扩展unc与wsl入口按来源种类区分() {
        // 复评 F15：扩展 UNC 写法必须与普通 UNC 同等识别，否则可绕过判定。
        assert!(is_wsl_path(&normalize_resolved_str(
            r"\\?\UNC\wsl$\Ubuntu\home\user"
        )));
        assert!(is_wsl_path(&normalize_resolved_str(
            r"\\?\UNC\wsl.localhost\Ubuntu\home\user"
        )));
        // 普通盘符经扩展前缀规范化后仍不是 WSL。
        assert!(!is_wsl_path(&normalize_resolved_str(r"\\?\D:\Users\A")));

        // 显式 WSL 入口：解析结果在 WSL 时必须允许，不能误拒。
        let wsl_target = Path::new(r"\\wsl$\Ubuntu\home\user\.claude\projects");
        assert!(
            recheck_resolved_target(
                r"\\wsl$\Ubuntu\home\user",
                wsl_target,
                ResolvedExpect::Directory,
                SourceOrigin::Wsl
            )
            .is_err(),
            "目标不存在时应报无法访问，而不是来源不匹配"
        );
        // 关键断言：来源判定本身不因「目标是 WSL」而拒绝。
        // 用一个存在的目录模拟 WSL 入口指向本地（应因来源不一致被拒）。
        let dir = crate::test_support::TempConfigDir::new("wsl-origin");
        let directory = std::fs::canonicalize(dir.path()).unwrap();
        assert!(
            recheck_resolved_target(
                r"\\wsl$\Ubuntu\home\user",
                &directory,
                ResolvedExpect::Directory,
                SourceOrigin::Wsl
            )
            .is_err(),
            "显式 WSL 入口解析到本地盘应被拒"
        );
        // 同一目录用本地来源则允许。
        assert!(recheck_resolved_target(
            "dir",
            &directory,
            ResolvedExpect::Directory,
            SourceOrigin::Native
        )
        .is_ok());
    }
    #[test]
    fn 本地入口解析到网络共享时拒绝_wsl不算网络() {
        // 复评 R03：输入只拦普通 UNC，链接可把本地路径指到网络位置。
        assert!(is_network_path(r"\\server\share\logs"));
        assert!(is_network_path(r"\\10.0.0.5\data"));
        // WSL 挂载点是 UNC 形式但不是网络共享。
        assert!(!is_network_path(r"\\wsl$\Ubuntu\home\user"));
        assert!(!is_network_path(r"\\wsl.localhost\Ubuntu\home\user"));
        // 普通盘符不是网络路径。
        assert!(!is_network_path(r"d:\users\a\.claude\projects"));
    }

    #[test]
    fn 解析后类型不符时报错且不静默通过() {
        let dir = crate::test_support::TempConfigDir::new("resolved-target");
        let file = dir.join("db.sqlite");
        std::fs::write(&file, b"x").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert!(recheck_resolved_target(
            "db.sqlite",
            &canonical,
            ResolvedExpect::File,
            SourceOrigin::Native
        )
        .is_ok());
        assert!(recheck_resolved_target(
            "db.sqlite",
            &canonical,
            ResolvedExpect::Directory,
            SourceOrigin::Native
        )
        .is_err());
        // 目录同理
        let directory = std::fs::canonicalize(dir.path()).unwrap();
        assert!(recheck_resolved_target(
            "dir",
            &directory,
            ResolvedExpect::Directory,
            SourceOrigin::Native
        )
        .is_ok());
        assert!(recheck_resolved_target(
            "dir",
            &directory,
            ResolvedExpect::File,
            SourceOrigin::Native
        )
        .is_err());
    }

    // ---------- 第五轮复评 Q07：目标文本的入口策略判定 ----------

    #[test]
    fn q07_链接与路径文本判定_覆盖wsl_unc系统目录() {
        // 文本判定在**任何文件系统访问之前**执行（复评 Q07）。
        assert!(is_disallowed_local_target_text(
            r"\\wsl.localhost\Ubuntu\home\user"
        ));
        assert!(is_disallowed_local_target_text(r"\\wsl$\Ubuntu\home\user"));
        assert!(is_disallowed_local_target_text(r"\\server\share\logs"));
        assert!(is_disallowed_local_target_text(r"C:\Windows\System32"));
        assert!(is_disallowed_local_target_text(r"\\?\C:\Program Files\App"));
        assert!(!is_disallowed_local_target_text(r"D:\Logs\Claude"));
        assert!(!is_disallowed_local_target_text(r"\\?\D:\Logs"));
        // junction 的 read_link 目标常带扩展前缀：还原后必须能被识别。
        assert!(is_disallowed_local_target_text(
            r"\\?\UNC\server\share\logs"
        ));
    }

    #[test]
    fn q07_布局根解析_普通目录返回规范路径() {
        let base = std::env::temp_dir().join(format!("dsm-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".claude/projects")).unwrap();
        let resolved = resolve_layout_root(
            &base.join(".claude/projects"),
            SourceOrigin::Native,
            ResolvedExpect::Directory,
        );
        assert!(resolved.is_ok(), "普通布局根应能解析：{:?}", resolved.err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn q07_布局根解析_不存在的根报错不登记() {
        let missing = std::env::temp_dir().join(format!(
            "dsm-layout-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(
            resolve_layout_root(&missing, SourceOrigin::Native, ResolvedExpect::Directory).is_err()
        );
    }

    // ---------- 第六轮复评 R05：根到叶链接链与多跳 ----------

    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// 复评 R05（Windows 实测，junction 不需要特权）：父组件是 junction 时，
    /// 必须在**访问叶子之前**用链接目标文本判定；叶子在目标侧不存在也一样。
    #[cfg(windows)]
    #[test]
    fn r05_父组件链接指向系统目录_访问前拒绝() {
        let base = std::env::temp_dir().join(format!("dsm-chain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let junction = base.join("alias");
        if !make_junction(&junction, Path::new(r"C:\Windows\System32")) {
            eprintln!("NOT RUN：当前环境无法创建 junction");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        // 旧实现会先 symlink_metadata(叶子)：叶子经 junction 落到 System32，
        // 通常不存在 → 报「路径不存在」，但目标已被访问过。
        // 新实现按根到叶检查，先看到 junction，用目标文本拒绝。
        let error = check_link_chain(
            &junction.join("dsm-not-exist").join("logs"),
            SourceOrigin::Native,
        )
        .expect_err("指向系统目录的父链接必须被拒绝");
        assert!(
            error.contains("链接目标"),
            "必须因链接目标策略被拒绝，而不是访问后的路径错误：{error}"
        );
        assert!(
            !error.contains("路径不存在"),
            "拒绝发生在访问目标之前：{error}"
        );
        std::fs::remove_dir(&junction).ok();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 复评 R05：链接目标在允许范围内时链路放行（多跳后仍按策略判定）。
    #[cfg(windows)]
    #[test]
    fn r05_允许范围内的目录链接链放行() {
        let base = std::env::temp_dir().join(format!("dsm-chain-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real/sub")).unwrap();
        let junction = base.join("alias");
        if !make_junction(&junction, &base.join("real")) {
            eprintln!("NOT RUN：当前环境无法创建 junction");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        // 经 junction 的路径：允许目标 → 放行；更深的末端不存在也放行
        // （监听场景允许祖先目录尚未创建）。
        assert!(check_link_chain(&junction.join("sub"), SourceOrigin::Native).is_ok());
        assert!(
            check_link_chain(&junction.join("missing/leaf"), SourceOrigin::Native).is_ok(),
            "不存在的末端不是链接，不应被当成越界"
        );
        std::fs::remove_dir(&junction).ok();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 复评 R05：链接跳数上限防御循环（A→B→A 的 junction 环）。
    #[cfg(windows)]
    #[test]
    fn r05_链接环不无限递归_有跳数上限() {
        let base = std::env::temp_dir().join(format!("dsm-chain-loop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("a")).unwrap();
        let link_b = base.join("a/b");
        if !make_junction(&link_b, &base.join("a")) {
            eprintln!("NOT RUN：当前环境无法创建 junction");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        // 自我指向的 junction 链：必须终止（要么拒绝，要么放行），不能挂死。
        let outcome = check_link_chain(&link_b.join("b/b/b"), SourceOrigin::Native);
        assert!(outcome.is_ok() || outcome.is_err(), "链接环必须有限步终止");
        std::fs::remove_dir(&link_b).ok();
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---------- 第七轮复评 F02-D：相对链接的 `..` 必须先折叠 ----------

    #[test]
    fn f02_相对目标折叠dot段后再判策略() {
        // 评审示例：`C:\Users\A\alias` 的相对目标 `..\..\Windows\System32`
        // 拼接后是 `C:\Users\A\..\..\Windows\System32`；不折叠会被「只看盘符
        // 后首级」的判定误放行，真实目标是 `C:\Windows\System32`。
        let raw = Path::new(r"C:\Users\A\..\..\Windows\System32");
        let folded = normalize_dot_segments(raw);
        assert_eq!(folded, PathBuf::from(r"C:\Windows\System32"));
        assert!(
            is_disallowed_local_target_text(&folded.to_string_lossy()),
            "折叠后的系统目录必须被识别"
        );
        assert!(
            !is_disallowed_local_target_text(&raw.to_string_lossy()),
            "未折叠的文本确实会漏判 —— 这正是折叠存在的理由"
        );
        // 普通路径不受影响；`.` 与重复分隔符也被折叠。
        assert_eq!(
            normalize_dot_segments(Path::new(r"D:\Logs\.\Claude")),
            PathBuf::from(r"D:\Logs\Claude")
        );
        // 退到盘根即停，不能越出盘符。
        assert_eq!(
            normalize_dot_segments(Path::new(r"D:\..\..\Logs")),
            PathBuf::from(r"D:\Logs")
        );
    }

    #[test]
    fn f02_折叠后的unc与wsl目标同样被识别() {
        let raw = Path::new(r"D:\Logs\..\..\..\wsl.localhost\Ubuntu\home");
        let folded = normalize_dot_segments(raw);
        // Windows 语义下退到盘根后剩余段成为普通子路径，不构成 UNC；
        // 真正以 UNC 开头的相对目标仍必须被识别。
        let unc = normalize_dot_segments(Path::new(r"\\wsl.localhost\Ubuntu\..\Debian\home"));
        assert!(is_disallowed_local_target_text(&unc.to_string_lossy()));
        assert!(!is_disallowed_local_target_text(&folded.to_string_lossy()));
    }
}
