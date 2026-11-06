//! Token Monitor's pinned Tokscale collector, adapted to Tauri. Only usage metadata crosses IPC.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::io::AsyncReadExt;

const CLIENTS: &[&str] = &["opencode", "claude", "zcode", "hermes", "openclaw", "dsh"];
const MAX_OUTPUT: u64 = 16 * 1024 * 1024;
const ENGINE_MANIFEST: &str = include_str!("../../scripts/local-usage-engine.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRow {
    pub id: String,
    pub tool: String,
    pub session_id: String,
    pub project_key: Option<String>,
    pub project_path: Option<String>,
    pub model: String,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub reasoning: Option<u64>,
    pub total_tokens: Option<u64>,
    pub message_count: Option<u64>,
    pub timed_output_tokens: Option<u64>,
    pub timed_duration_ms: Option<u64>,
    pub first_active_ms: Option<u64>,
    pub last_active_ms: Option<u64>,
    #[serde(default = "native_source")]
    pub source_id: String,
    #[serde(default = "native_label")]
    pub source_label: String,
    #[serde(default = "unclassified_accuracy")]
    pub token_accuracy: String,
    #[serde(default)]
    pub timing_coverage: TimingCoverage,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TimingCoverage {
    Matched,
    Partial,
    Unavailable,
    #[default]
    Unverified,
}
fn unclassified_accuracy() -> String {
    "unclassified".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSnapshot {
    #[serde(default)]
    pub retention_warning: Option<String>,
    pub collected_at: u64,
    pub engine_version: String,
    pub period: String,
    #[serde(default)]
    pub period_key: String,
    /// Capture-time local accounting offset; never reconstructed at export time.
    #[serde(default)]
    pub accounting_utc_offset_seconds: Option<i32>,
    pub rows: Vec<LocalRow>,
    #[serde(default)]
    pub sources: Vec<SourceHealth>,
    #[serde(default = "complete_default")]
    pub complete: bool,
}
fn native_source() -> String {
    "native".into()
}
fn native_label() -> String {
    "本机".into()
}
fn complete_default() -> bool {
    true
}
pub fn local_period(at: u64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(i64::try_from(at).ok()?).map(|date| {
        date.with_timezone(&chrono::Local)
            .format("%Y-%m")
            .to_string()
    })
}
fn local_offset(at: u64) -> Option<i32> {
    chrono::DateTime::from_timestamp_millis(i64::try_from(at).ok()?).map(|date| {
        date.with_timezone(&chrono::Local)
            .offset()
            .local_minus_utc()
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub id: String,
    pub label: String,
    pub state: String,
    pub message: Option<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 2048 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
fn number(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)?
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
}
pub fn normalize_report(value: &Value, collected_at: u64) -> Result<LocalSnapshot, String> {
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("采集结果结构不兼容")?;
    if entries.len() > 50000 {
        return Err("会话记录过多，请缩小采集范围".into());
    }
    let workspaces: BTreeMap<_, _> = value
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| Some((text(w, "workspaceKey")?, text(w, "path")?)))
        .collect();
    let sessions: BTreeMap<_, _> = value
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some((
                format!("{}\0{}", text(s, "client")?, text(s, "sessionId")?),
                s,
            ))
        })
        .collect();
    let mut rows = BTreeMap::new();
    for entry in entries {
        let Some(tool) = text(entry, "client").filter(|tool| CLIENTS.contains(&tool.as_str()))
        else {
            continue;
        };
        let Some(session_id) = text(entry, "sessionId") else {
            continue;
        };
        let Some(model) = text(entry, "model") else {
            continue;
        };
        let project_path =
            text(entry, "workspaceKey").and_then(|key| workspaces.get(&key).cloned());
        // Do not turn an opaque workspace slug into a guessed filesystem identity.
        let project_key = project_path.as_ref().map(|path| {
            let path = path.replace('\\', "/").trim_end_matches('/').to_string();
            if path.starts_with('/') && !path.starts_with("//") {
                path
            } else {
                path.to_lowercase()
            }
        });
        let input = number(entry, "input");
        let cache_read = number(entry, "cacheRead");
        let cache_write = number(entry, "cacheWrite");
        let reasoning = number(entry, "reasoning");
        // These pinned parsers emit reasoning as a disjoint bucket; the public output includes it.
        let output = if matches!(tool.as_str(), "opencode" | "zcode" | "dsh") {
            number(entry, "output")
                .zip(reasoning)
                .and_then(|(a, b)| a.checked_add(b))
                .filter(|n| *n <= 9_007_199_254_740_991)
        } else {
            number(entry, "output")
        };
        let total_tokens = input
            .zip(output)
            .zip(cache_read)
            .zip(cache_write)
            .and_then(|(((a, b), c), d)| a.checked_add(b)?.checked_add(c)?.checked_add(d))
            .filter(|n| *n <= 9_007_199_254_740_991);
        let performance = &entry["performance"];
        let duration = number(performance, "totalDurationMs").filter(|n| *n > 0);
        // The engine does not expose per-message timed output. A partly timed aggregate
        // cannot safely divide ALL output by only the timed subset's duration.
        let timed = duration.is_some()
            && total_tokens.is_some_and(|total| number(performance, "timedTokens") == Some(total));
        let timing_coverage = match (duration, total_tokens, number(performance, "timedTokens")) {
            (None, _, _) => TimingCoverage::Unavailable,
            (Some(_), Some(total), Some(covered)) if covered == total => TimingCoverage::Matched,
            (Some(_), Some(total), Some(covered)) if covered < total => TimingCoverage::Partial,
            _ => TimingCoverage::Unverified,
        };
        let meta = sessions.get(&format!("{tool}\0{session_id}"));
        let id = format!(
            "{tool}\0{}\0{session_id}\0{model}",
            project_key.as_deref().unwrap_or("")
        );
        rows.insert(
            id.clone(),
            LocalRow {
                id,
                tool,
                session_id,
                project_key,
                project_path,
                model,
                input,
                output,
                cache_read,
                cache_write,
                reasoning,
                total_tokens,
                message_count: number(entry, "messageCount"),
                timed_output_tokens: if timed { output } else { None },
                timed_duration_ms: if timed { duration } else { None },
                first_active_ms: meta
                    .and_then(|s| number(s, "firstActiveMs"))
                    .filter(|n| *n > 0),
                last_active_ms: meta
                    .and_then(|s| number(s, "lastActiveMs"))
                    .filter(|n| *n > 0),
                source_id: native_source(),
                source_label: native_label(),
                // The fixed report contract has no per-row estimation provenance.
                token_accuracy: unclassified_accuracy(),
                timing_coverage,
            },
        );
    }
    Ok(LocalSnapshot {
        retention_warning: None,
        collected_at,
        engine_version: "d5e8ad9b".into(),
        period: "month".into(),
        period_key: local_period(collected_at).ok_or("采集时间不可用")?,
        accounting_utc_offset_seconds: local_offset(collected_at),
        rows: rows.into_values().collect(),
        sources: vec![],
        complete: true,
    })
}

pub fn verify_engine(path: &Path) -> Result<(), String> {
    let manifest: Value = serde_json::from_str(ENGINE_MANIFEST).map_err(|_| "采集引擎配置损坏")?;
    let file = std::fs::File::open(path).map_err(|_| "采集引擎未就绪，请重新安装完整程序")?;
    if file.metadata().map_err(|_| "无法读取采集引擎")?.len() > 50 * 1024 * 1024 {
        return Err("采集引擎大小异常".into());
    }
    let mut hash = Sha256::new();
    let mut reader = std::io::BufReader::new(file);
    std::io::copy(&mut reader, &mut hash).map_err(|_| "采集引擎校验失败")?;
    if format!("{:x}", hash.finalize()) != manifest["sha256"].as_str().unwrap_or("") {
        return Err("采集引擎校验失败，请重新安装完整程序".into());
    }
    Ok(())
}

pub async fn run_engine(path: &Path, home: Option<&Path>) -> Result<LocalSnapshot, String> {
    let profile = if let Some(home) = home {
        home.join(".dsm-engine-cache")
    } else {
        crate::config::config_path()?.with_file_name("local-usage-engine")
    };
    run_engine_profile(path, home, &profile).await
}
pub fn scope_snapshot(mut snapshot: LocalSnapshot, id: &str, label: &str) -> LocalSnapshot {
    for row in &mut snapshot.rows {
        row.source_id = id.into();
        row.source_label = label.into();
        row.id = format!("{id}\0{}", row.id);
        if id != "native" {
            row.project_key = row.project_key.take().map(|key| format!("{id}\0{key}"));
        }
    }
    snapshot
}
pub async fn run_sources(
    path: &Path,
    options: &crate::local_sources::SourceOptions,
    app: &tauri::AppHandle,
) -> Result<LocalSnapshot, String> {
    let default_home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| app.path().home_dir().ok());
    let profile = crate::config::config_path()?.with_file_name("local-usage-engine");
    collect_sources(path, options, default_home, profile).await
}
pub async fn collect_sources(
    path: &Path,
    options: &crate::local_sources::SourceOptions,
    default_home: Option<std::path::PathBuf>,
    profile: std::path::PathBuf,
) -> Result<LocalSnapshot, String> {
    use crate::local_sources::{clean_home, home_key, source_id, HomeKind};
    let options = crate::local_sources::validate_options(options.clone())?;
    let requested_period = chrono::Local::now().format("%Y-%m").to_string();
    let requested_offset = chrono::Local::now().offset().local_minus_utc();
    let mut candidates = Vec::new();
    let mut sources = Vec::new();
    if options.include_default {
        match default_home.and_then(|home| {
            clean_home(&home.to_string_lossy())
                .ok()
                .map(|(_, kind)| (home, kind))
        }) {
            Some((home, kind)) => {
                candidates.push(("native".to_string(), "本机".to_string(), home, kind, true))
            }
            None => sources.push(SourceHealth {
                id: "native".into(),
                label: "本机".into(),
                state: "unavailable".into(),
                message: Some("默认主目录不可用，请设置额外主目录".into()),
            }),
        }
    }
    for (index, value) in options.homes.iter().enumerate() {
        let (_, kind) = clean_home(value)?;
        let label = match &kind {
            HomeKind::Native => format!("目录 {}", index + 1),
            HomeKind::Wsl { distro } => format!("WSL · {distro}"),
        };
        candidates.push((source_id(value), label, value.into(), kind, false));
    }
    for entry in &options.tool_paths {
        let id = tool_source_id(entry);
        let kind = crate::local_sources::clean_tool_path(&entry.path)?.1;
        let label = match &kind {
            HomeKind::Wsl { distro } => format!("WSL · {distro} · {}", entry.tool),
            HomeKind::Native => format!("{} · 指定路径", entry.tool),
        };
        candidates.push((id, label, entry.path.clone().into(), kind, false));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    // 复评 R02：删除「采集前先算 overlaps、循环无条件跳过」的先验判重 ——
    // covering home 本轮失败/被拒时，用户单独配置的单工具来源必须照常采集
    // （它是可用的退路）。判重只承认**本轮成功读取的实际入口**：home 成功
    // 后才登记其标准布局覆盖根（见下方 layout_roots），后续工具来源据此判重。
    // 候选顺序保证 home 先于单工具路径处理，登记一定发生在判定之前。
    let wsl = if candidates
        .iter()
        .any(|(_, _, _, kind, _)| matches!(kind, HomeKind::Wsl { .. }))
    {
        Some(crate::local_sources::running_wsl().await)
    } else {
        None
    };
    // 第五轮复评 Q06：引擎 settings.json 的扩展根可能指向 WSL —— 状态按需
    // 读取并记住，避免逐来源重复 spawn wsl.exe。
    let mut wsl_memo = wsl.clone();
    let mut rows = Vec::new();
    // 复评 T04：记录「哪个来源已占用该物理路径」，提示能说清是谁覆盖了谁。
    // 复评 Q05：键按**解析器作用域**划分 —— home 解析器覆盖全部工具，
    // 单工具路径用自己的解析器；两个不同工具指向同一目录不代表语义相同，
    // 不得互相去重。
    let mut seen: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    // 复评 Q05：home 来源成功后登记它的**标准布局覆盖根**（逐个解析后的实际
    // 目标）。junction 把工具标准目录映射到别处时，原始字符串判重不命中，
    // canonical 后与 home 根也不相等 —— 只有把 home 展开成每个工具的
    // 标准布局根并解析实际目标，才能证明「这个工具来源已被 home 覆盖」。
    // 第五轮复评 Q05：外层键是**工具** —— 一种工具的布局覆盖不得推成
    // 另一个解析器也已覆盖。
    let layout_roots: std::sync::Arc<
        std::sync::Mutex<
            std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
        >,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
    // 复评 Q05：home 根本身也是覆盖根（工具路径指向 home 根时同样重复）。
    let home_roots_canonical: std::sync::Arc<
        std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
    let duplicate_source: std::sync::Arc<
        std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
    // 复评 T13：主目录内发现引擎 settings.json 时的提示（来源健康信息可见）。
    let engine_settings_notice: std::sync::Arc<
        std::sync::Mutex<std::collections::BTreeMap<String, &'static str>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
    let mut succeeded = 0;
    let mut zcode_adapter_used = false;
    for (id, label, home, kind, _is_default) in candidates {
        let mut state = "ok";
        let mut message = None;
        let gate = source_gate(&kind, &wsl);
        if let Err(error) = gate {
            state = "unavailable";
            message = Some(error);
        } else if deadline <= tokio::time::Instant::now() {
            state = "unavailable";
            message = Some("本轮采集达到60秒预算".into());
        } else {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let tool_path = options
                .tool_paths
                .iter()
                .find(|entry| tool_source_id(entry) == id);
            let result = tokio::time::timeout(remaining, async {
                let directory = tool_path
                    .is_none_or(|entry| !matches!(entry.tool.as_str(), "opencode" | "zcode"));
                // 复评 Q07：来源种类先于任何访问确定。探测在**访问目标之前**
                // 按入口策略检查链接链 —— 路径本身或父组件是 reparse 点时，
                // 先用目标文本判定（不访问目标），越界直接拒绝。
                let origin = if matches!(kind, crate::local_sources::HomeKind::Wsl { .. }) {
                    crate::local_sources::SourceOrigin::Wsl
                } else {
                    crate::local_sources::SourceOrigin::Native
                };
                let canonical =
                    crate::local_sources::probe_path(home.clone(), directory, origin).await?;
                // 复评 T04/Q05：判重键按解析器作用域划分。
                // - home 来源：`home:{canonical}`（该解析器覆盖全部工具）；
                // - 单工具来源：`tool:{tool}:{canonical}`（同工具同路径才互斥，
                //   两个不同工具指向同一目录不代表语义相同，不得误跳过）。
                let key = match &tool_path {
                    Some(entry) => format!(
                        "tool:{}:{}",
                        entry.tool,
                        home_key(&canonical.to_string_lossy())
                    ),
                    None => format!("home:{}", home_key(&canonical.to_string_lossy())),
                };
                if let Some(covering) = seen.get(&key) {
                    // 复评 T04：把「被谁覆盖」带出去，提示不再是含糊的「相同主目录」。
                    duplicate_source
                        .lock()
                        .map_err(|_| "采集状态不可用")?
                        .insert(id.clone(), covering.clone());
                    return Ok(None);
                }
                // 复评 Q05：工具来源被某个 home 的标准布局（已解析的实际根）覆盖时判重。
                // 只在**同一工具**的登记里查找 —— 一种工具的覆盖不得推成另一解析器。
                // junction 别名使原始字符串不命中、canonical 又与 home 根不等，
                // 只有用 home 逐个解析后的布局根才能证明同源。
                if let Some(entry) = tool_path {
                    let candidate_key = home_key(&canonical.to_string_lossy());
                    let roots = layout_roots.lock().map_err(|_| "采集状态不可用")?;
                    let hit = roots.get(&entry.tool).and_then(|per_tool| {
                        per_tool
                            .iter()
                            .find(|(root, _)| {
                                crate::local_overlap::key_within(root, &candidate_key)
                            })
                            .map(|(_, label)| label.clone())
                    });
                    drop(roots);
                    if let Some(covering) = hit {
                        duplicate_source
                            .lock()
                            .map_err(|_| "采集状态不可用")?
                            .insert(id.clone(), covering);
                        return Ok(None);
                    }
                    // 工具路径**恰好等于**某个已采 home 的根时同样重复。
                    // 第五轮复评 Q05：只做相等判定 —— home 的默认扫描只覆盖
                    // 标准布局，home 下的非标准自定义目录不在覆盖范围内，必须
                    // 照常采集（上一版按「home 的任意后代」判重，造成漏采回归）。
                    let homes = home_roots_canonical.lock().map_err(|_| "采集状态不可用")?;
                    let hit = homes.get(&candidate_key).cloned();
                    drop(homes);
                    if let Some(covering) = hit {
                        duplicate_source
                            .lock()
                            .map_err(|_| "采集状态不可用")?
                            .insert(id.clone(), covering);
                        return Ok(None);
                    }
                }
                // 复评 Q07/R04：启动引擎前审计**实际扫描根**内的文件符号链接 ——
                // 固定引擎的文件发现会跟随它们读取目标（is_symlink() && is_file()），
                // 应用无法在引擎内部拦截。home 来源只审计六款工具的标准布局根
                //（复评 R04：不再递归整个 home —— 无关目录里的链接不应拒绝
                // 全部工具的采集）；单工具目录来源审计它自己。目录链接不进入
                // 也不拒绝（R04：以链接类型区分，不再误拒目录链接）。
                // 预审不完整（目录过大/不可读，复评 R06）按未验证状态处理：
                // 继续采集但把结论写进来源健康信息，不冒充已校验。
                let mut audit_note: Option<&'static str> = None;
                if directory {
                    let audit = if tool_path.is_none() {
                        audit_home_layout_roots(&canonical, origin)?
                    } else {
                        audit_root_for_reparse(&canonical)?
                    };
                    match audit {
                        ReparseAudit::Clean => {}
                        ReparseAudit::Incomplete(reason) => audit_note = Some(reason),
                    }
                }
                // 复评 Q06/R03：引擎 settings.json 的 extraScanPaths 与
                // opencodeDbPaths（含备用配置文件）在采集时直接生效，事后提示
                // 修不回已发生的读取。启动引擎前对每个扩展根执行与应用入口
                // 一致的校验，任一不合规立即拒绝该来源（失败关闭）。
                let validated_roots =
                    validate_engine_extra_roots(&canonical, &mut wsl_memo).await?;
                let snapshot = if let Some(entry) = tool_path {
                    // 复评 R03：传校验通过的解析目标，而不是配置里的原路径。
                    run_tool_source(path, entry, &canonical, &profile.join(&id)).await?
                } else {
                    // 复评 T13：默认来源也必须传 `--home`。不带 `--home` 时引擎会
                    // 启用环境来源（实测 TOKSCALE_EXTRA_DIRS / 内建默认根都会进入
                    // 扫描），其边界不受本应用校验约束；传了 `--home` 之后环境
                    // 扩展来源被禁用（已实测），扫描根就是校验过的主目录本身。
                    run_engine_profile(path, Some(&canonical), &profile.join(&id)).await?
                };
                seen.insert(key, label.clone());
                // 复评 Q05/R02：home 来源**本轮成功**后登记它的覆盖根，供后续
                // 工具来源判重 —— 失败的 home 不登记，单工具来源可以照常采集。
                if tool_path.is_none() {
                    let home_key_value = home_key(&canonical.to_string_lossy());
                    if let Ok(mut roots) = home_roots_canonical.lock() {
                        roots.insert(home_key_value, label.clone());
                    }
                    if let Ok(mut roots) = layout_roots.lock() {
                        for tool in ["opencode", "claude", "zcode", "hermes", "openclaw", "dsh"] {
                            for layout in crate::local_overlap::standard_layouts(tool) {
                                let layout_path =
                                    canonical.join(layout.relative.replace('/', "\\"));
                                // 第五轮复评 Q05：逐个布局根按来源策略解析后再登记 ——
                                // 布局根本身可能是 junction，必须登记**实际被读取**的
                                // 目标；解析失败或目标越界时不登记（宁可漏判重，
                                // 不可误抑制真实来源）。文件根（ZCode 精确数据库）
                                // 按文件语义解析与登记。
                                let resolved = match layout.kind {
                                    crate::local_overlap::LayoutKind::Directory => {
                                        crate::local_sources::resolve_layout_root(
                                            &layout_path,
                                            origin,
                                            crate::local_sources::ResolvedExpect::Directory,
                                        )
                                    }
                                    crate::local_overlap::LayoutKind::File => {
                                        crate::local_sources::resolve_layout_root(
                                            &layout_path,
                                            origin,
                                            crate::local_sources::ResolvedExpect::File,
                                        )
                                    }
                                };
                                if let Ok(resolved) = resolved {
                                    roots.entry(tool.to_string()).or_default().insert(
                                        home_key(&resolved.to_string_lossy()),
                                        label.clone(),
                                    );
                                }
                            }
                        }
                    }
                }
                // 复评 T13/Q06/R06：settings 扩展根校验结论与链接预审结论都
                // 写进来源健康信息（采集成功后可见），不只在日志里。
                if let Ok(mut map) = engine_settings_notice.lock() {
                    if let Some(reason) = audit_note {
                        map.insert(
                            id.clone(),
                            reason, // 形如「…链接预审未完整」，按未验证状态披露
                        );
                    } else if tool_path.is_none() {
                        if let Some(count) = validated_roots {
                            map.insert(
                                id.clone(),
                                if count > 0 {
                                    "该主目录的引擎扩展根已按应用来源策略校验，不合规会拒绝采集"
                                } else {
                                    "该主目录包含引擎 settings.json，未配置扩展根"
                                },
                            );
                        }
                    }
                }
                Ok::<_, String>(Some(scope_snapshot(snapshot, &id, &label)))
            })
            .await;
            match result {
                Ok(Ok(Some(snapshot))) => {
                    zcode_adapter_used |=
                        snapshot.engine_version == crate::zcode_usage::ADAPTER_VERSION;
                    if let Ok(map) = engine_settings_notice.lock() {
                        if let Some(notice) = map.get(&id) {
                            message = Some(match message.take() {
                                Some(existing) => format!("{existing}；{notice}"),
                                None => (*notice).to_string(),
                            });
                        }
                    }
                    if rows.len() + snapshot.rows.len() > 50000 {
                        return Err("合并记录过多，请缩小采集目录范围".into());
                    }
                    succeeded += 1;
                    rows.extend(snapshot.rows);
                }
                Ok(Ok(None)) => {
                    state = "duplicate";
                    // 复评 T04：说明是哪个来源覆盖了它，用户才能判断该删哪个配置。
                    let covering = duplicate_source
                        .lock()
                        .map(|map| map.get(&id).cloned())
                        .unwrap_or_else(|_| Some("相同来源".into()))
                        .unwrap_or_else(|| "相同来源".into());
                    message = Some(format!("已由来源「{covering}」覆盖，未重复采集"));
                }
                Ok(Err(error)) => {
                    state = "unavailable";
                    message = Some(error);
                }
                Err(_) => {
                    state = "unavailable";
                    message = Some("本轮采集达到60秒预算，已停止子进程".into());
                }
            }
        }
        sources.push(SourceHealth {
            id,
            label,
            state: state.into(),
            message,
        });
    }
    if succeeded == 0 {
        let reason = sources
            .iter()
            .find_map(|source| source.message.as_ref())
            .map(|message| message.chars().take(200).collect::<String>())
            .unwrap_or_else(|| "请检查路径、权限和WSL运行状态".into());
        return Err(format!("所有采集来源均未取得：{reason}"));
    }
    if rows.len() > 50000 {
        return Err("合并记录过多，请缩小采集目录范围".into());
    }
    let complete = sources.iter().all(|s| s.state != "unavailable");
    let collected_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟异常")?
        .as_millis() as u64;
    let period_key = local_period(collected_at).ok_or("采集时间不可用")?;
    let accounting_utc_offset_seconds = local_offset(collected_at);
    if period_key != requested_period || accounting_utc_offset_seconds != Some(requested_offset) {
        return Err("采集跨越本地月份或时区发生变化，请重新采集；未接收混合结果".into());
    }
    Ok(LocalSnapshot {
        retention_warning: None,
        collected_at,
        engine_version: if zcode_adapter_used {
            crate::zcode_usage::ADAPTER_VERSION
        } else {
            "d5e8ad9b"
        }
        .into(),
        period: "month".into(),
        period_key,
        accounting_utc_offset_seconds,
        rows,
        sources,
        complete,
    })
}
fn tool_source_id(entry: &crate::local_sources::ToolPath) -> String {
    format!(
        "tool-{:x}",
        Sha256::digest(
            format!(
                "{}\0{}",
                entry.tool,
                crate::local_sources::home_key(&entry.path)
            )
            .as_bytes()
        )
    )
}
/// 复评 Q07：来源根内**文件符号链接**预审的结果。
pub(crate) enum ReparseAudit {
    /// 未发现文件符号链接。
    Clean,
    /// 预审不完整（目录过大/不可读）：降级为提示，不拒绝真实数据。
    Incomplete(&'static str),
}

/// 目录条目审计上限：元数据遍历，不含文件内容读取。超过按「预审不完整」
/// 处理而不是拒绝 —— 引擎本身会枚举同一棵树，不能因预审上限造成漏采。
const REPARSE_AUDIT_MAX_ENTRIES: usize = 200_000;

/// 复评 R04：Rust 的 `FileType::is_symlink` / `is_dir` / `is_file` **互斥** ——
/// 目录符号链接 `is_symlink()` 为 true 时 `is_dir()` 必为 false，不能再用
/// `is_dir()` 区分目录链接（上一版因此把目录链接当文件链接误拒整个来源）。
///
/// 判定必须覆盖 Windows 上两种目录名称代理：
/// - 目录符号链接（`IO_REPARSE_TAG_SYMLINK` + 目录标志）；
/// - **junction**（`IO_REPARSE_TAG_MOUNT_POINT`）—— `FileTypeExt::is_symlink_dir()`
///   只认 symlink 标签，对 junction 返回 false，会把常见的 junction 误判成
///   文件链接并拒绝整个来源。
///
/// 用 `symlink_metadata` 的目录属性位（不跟随）同时覆盖两者。
#[cfg(windows)]
fn is_dir_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
}
/// 非 Windows 平台上没有不跟随的类型位可区分目录链接：保守按文件链接处理
/// （拒绝），不为判定而访问链接目标。产品路径仅 Windows。
#[cfg(not(windows))]
fn is_dir_link(_meta: &std::fs::Metadata) -> bool {
    false
}

/// 复评 Q07：审计来源根内的**文件符号链接**。
///
/// 固定引擎的文件发现接受 `is_symlink() && path.is_file()` 并读取目标 ——
/// 根内一个指向外部的日志文件链接就能把读取范围带出已确认的来源边界，
/// 且应用无法在引擎内部拦截。这里在启动引擎前用**不跟随**的目录遍历检查；
/// 发现文件链接（含断链）即拒绝该来源。目录链接不进入：引擎的通用遍历
/// 不跟随目录链接，标准布局根上的目录链接由布局解析按策略单独解析登记。
fn audit_root_for_reparse(root: &Path) -> Result<ReparseAudit, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(ReparseAudit::Incomplete("子目录无法读取，链接预审未完整")),
        };
        for entry in entries {
            visited += 1;
            if visited > REPARSE_AUDIT_MAX_ENTRIES {
                return Ok(ReparseAudit::Incomplete("目录过大，链接预审未完整"));
            }
            let Ok(entry) = entry else {
                return Ok(ReparseAudit::Incomplete("目录项无法读取，链接预审未完整"));
            };
            let Ok(file_type) = entry.file_type() else {
                return Ok(ReparseAudit::Incomplete(
                    "目录项类型无法读取，链接预审未完整",
                ));
            };
            if file_type.is_symlink() {
                // `file_type` 不含目录属性位，重新取不跟随的元数据判定目录链接。
                let is_directory_link = std::fs::symlink_metadata(entry.path())
                    .map(|meta| is_dir_link(&meta))
                    .unwrap_or(false);
                if is_directory_link {
                    // 目录链接 / junction：不进入、不拒绝（见函数注释）。
                    continue;
                }
                return Err(format!(
                    "来源目录内包含文件符号链接（{}），引擎会跟随读取目标，已拒绝该来源",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Ok(ReparseAudit::Clean)
}

/// 复评 R04：home 来源的链接预审只覆盖**实际扫描根** —— 六款工具的标准
/// 布局根（R02 窄化后的多根）。无关目录里的链接不再拒绝整个 home。
/// 布局根本身是目录链接时按策略解析（junction 到允许目标是既有语义），
/// 解析后审计其内容；布局根的链接目标越界 = 引擎会读到越界数据，直接拒绝。
fn audit_home_layout_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<ReparseAudit, String> {
    let mut incomplete: Option<&'static str> = None;
    for tool in ["opencode", "claude", "zcode", "hermes", "openclaw", "dsh"] {
        for layout in crate::local_overlap::standard_layouts(tool) {
            if layout.kind != crate::local_overlap::LayoutKind::Directory {
                // 精确文件根（ZCode 精确数据库）没有目录内容可审计；
                // 文件本身由探测与解析后复核检查。
                continue;
            }
            let path = home.join(layout.relative.replace('/', "\\"));
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    incomplete = Some(incomplete.unwrap_or("布局根状态不可读取，链接预审未完整"));
                    continue;
                }
            };
            let resolved = if crate::local_sources::is_reparse_entry(&meta) {
                let target = match std::fs::read_link(&path) {
                    Ok(target) => target,
                    Err(_) => {
                        incomplete =
                            Some(incomplete.unwrap_or("布局根链接无法读取，链接预审未完整"));
                        continue;
                    }
                };
                // 目标文本先判策略（不访问目标）；越界 = 引擎会读到越界数据。
                let absolute = if target.is_absolute() {
                    target
                } else {
                    path.parent()
                        .map(|parent| parent.join(&target))
                        .unwrap_or(target)
                };
                if let Err(error) =
                    crate::local_sources::reject_link_target(&absolute.to_string_lossy(), origin)
                {
                    return Err(format!(
                        "标准布局根（{}）链接目标越界：{error}",
                        path.display()
                    ));
                }
                match std::fs::canonicalize(&path) {
                    Ok(resolved) => resolved,
                    Err(_) => {
                        incomplete = Some(incomplete.unwrap_or("布局根无法解析，链接预审未完整"));
                        continue;
                    }
                }
            } else {
                match std::fs::canonicalize(&path) {
                    Ok(resolved) => resolved,
                    Err(_) => {
                        incomplete = Some(incomplete.unwrap_or("布局根无法解析，链接预审未完整"));
                        continue;
                    }
                }
            };
            let resolved = crate::local_sources::recheck_resolved_target(
                &path.to_string_lossy(),
                &resolved,
                crate::local_sources::ResolvedExpect::Directory,
                origin,
            )
            .map_err(|error| format!("标准布局根（{}）解析后越界：{error}", path.display()))?;
            match audit_root_for_reparse(&resolved) {
                Ok(ReparseAudit::Clean) => {}
                Ok(ReparseAudit::Incomplete(reason)) => {
                    incomplete = Some(incomplete.unwrap_or(reason));
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(match incomplete {
        Some(reason) => ReparseAudit::Incomplete(reason),
        None => ReparseAudit::Clean,
    })
}

/// 复评 Q06/R03：引擎 settings 的 extraScanPaths 与 opencodeDbPaths（含
/// 备用配置文件）在采集时**直接生效**，事后的提示修不回已经发生的读取。
/// 启动引擎前解析所有配置文件，对每个扩展根执行与应用入口一致的校验：
/// 文本种类 → WSL 发行版运行状态 → 链接链（不访问越界目标）→ 解析后目标
/// → 目录根内文件链接审计。任一不合规立即拒绝该来源 —— 失败关闭。
///
/// 返回 `None` 表示主/备配置都不存在；`Some(n)` 表示 n 个扩展根全部校验通过。
async fn validate_engine_extra_roots(
    home: &Path,
    wsl: &mut Option<Result<crate::local_sources::WslStatus, String>>,
) -> Result<Option<usize>, String> {
    // 复评 R03：上游 load_for_home_override 在主配置读取失败时**无条件**回退
    // 到 Library/Application Support 路径（无平台条件）。两处都校验：
    // 只存在备用文件时，它就是引擎实际读取的配置，不能漏。
    let mut configs: Vec<std::path::PathBuf> = Vec::new();
    for relative in [
        ["AppData", "Roaming", "tokscale", "settings.json"].as_slice(),
        [
            "Library",
            "Application Support",
            "tokscale",
            "settings.json",
        ]
        .as_slice(),
    ] {
        let path = relative
            .iter()
            .fold(home.to_path_buf(), |base, part| base.join(part));
        if path.is_file() {
            configs.push(path);
        }
    }
    if configs.is_empty() {
        return Ok(None);
    }
    let mut validated = 0usize;
    for config in configs {
        let text = std::fs::read(&config).map_err(|_| "无法读取采集引擎 settings.json")?;
        if text.len() > 256 * 1024 {
            return Err("采集引擎 settings.json 超过 256KiB，拒绝采集".into());
        }
        let value: serde_json::Value = serde_json::from_slice(&text)
            .map_err(|_| "采集引擎 settings.json 无法解析".to_string())?;
        // 复评 R03：两个来源字段统一解析；形态非法时失败关闭。
        for (tool, raw, directory) in engine_config_roots(&value)? {
            validate_engine_root(&tool, &raw, directory, wsl).await?;
            validated += 1;
        }
    }
    Ok(Some(validated))
}

/// 复评 R03：从引擎 settings.json 提取**全部**实际来源声明。
///
/// 返回 `(tool, path, 是否目录)`：
/// - `scanner.extraScanPaths`：按工具分桶的目录根列表；
/// - `scanner.opencodeDbPaths`：OpenCode 的数据库文件列表（上游会
///   `is_file`/`canonicalize` 后并入解析列表，应用的 --client 固定包含
///   opencode，因此该字段可达）。
///
/// 字段存在但形态非法（不是数组、含非字符串项）时返回错误 —— 宁可拒绝
/// 采集，也不能留下未经校验的来源。
fn engine_config_roots(value: &serde_json::Value) -> Result<Vec<(String, String, bool)>, String> {
    let mut roots = Vec::new();
    let scanner = value.get("scanner");
    if let Some(extra) = scanner.and_then(|scanner| scanner.get("extraScanPaths")) {
        let Some(map) = extra.as_object() else {
            return Err("引擎 settings.json 的 extraScanPaths 无法解析，拒绝采集".into());
        };
        for (tool, list) in map {
            let Some(list) = list.as_array() else {
                return Err(format!(
                    "引擎 settings.json 的 extraScanPaths[{tool}] 无法解析，拒绝采集"
                ));
            };
            for entry in list {
                let Some(raw) = entry.as_str() else {
                    return Err(format!(
                        "引擎 settings.json 的 extraScanPaths[{tool}] 含非字符串项，拒绝采集"
                    ));
                };
                roots.push((tool.clone(), raw.to_string(), true));
            }
        }
    }
    if let Some(db_paths) = scanner.and_then(|scanner| scanner.get("opencodeDbPaths")) {
        let Some(list) = db_paths.as_array() else {
            return Err("引擎 settings.json 的 opencodeDbPaths 无法解析，拒绝采集".into());
        };
        for entry in list {
            let Some(raw) = entry.as_str() else {
                return Err("引擎 settings.json 的 opencodeDbPaths 含非字符串项，拒绝采集".into());
            };
            roots.push(("opencode".to_string(), raw.to_string(), false));
        }
    }
    Ok(roots)
}

/// 校验一个引擎配置声明的根（复评 R03/R06）。
/// 目录根做文件链接审计；预审不完整=未验证，失败关闭，不计入「已校验」。
async fn validate_engine_root(
    tool: &str,
    raw: &str,
    directory: bool,
    wsl: &mut Option<Result<crate::local_sources::WslStatus, String>>,
) -> Result<(), String> {
    let reject = |error: String| format!("引擎扩展根（{tool} → {raw}）不合规：{error}");
    let (_, kind) = crate::local_sources::clean_tool_path(raw).map_err(reject)?;
    let origin = if matches!(kind, crate::local_sources::HomeKind::Wsl { .. }) {
        crate::local_sources::SourceOrigin::Wsl
    } else {
        crate::local_sources::SourceOrigin::Native
    };
    if matches!(origin, crate::local_sources::SourceOrigin::Wsl) && wsl.is_none() {
        *wsl = Some(crate::local_sources::running_wsl().await);
    }
    if let Err(error) = source_gate(&kind, wsl) {
        return Err(reject(error));
    }
    let canonical =
        crate::local_sources::probe_path(std::path::PathBuf::from(raw), directory, origin)
            .await
            .map_err(|error| format!("引擎扩展根（{tool} → {raw}）不可用：{error}"))?;
    if directory {
        match audit_root_for_reparse(&canonical) {
            Ok(ReparseAudit::Clean) => {}
            Ok(ReparseAudit::Incomplete(_)) => {
                return Err(reject(
                    "链接预审未完整，无法确认根内没有越界文件链接".into(),
                ));
            }
            Err(error) => return Err(reject(error)),
        }
    }
    Ok(())
}

fn source_gate(
    kind: &crate::local_sources::HomeKind,
    wsl: &Option<Result<crate::local_sources::WslStatus, String>>,
) -> Result<(), String> {
    match kind {
        crate::local_sources::HomeKind::Native => Ok(()),
        crate::local_sources::HomeKind::Wsl { distro } => match wsl {
            Some(Ok(list))
                if list.state == "ok"
                    && list
                        .distros
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(distro)) =>
            {
                Ok(())
            }
            Some(Ok(_)) => Err("WSL发行版未运行，请在WSL启动后重试".into()),
            _ => Err("WSL状态无法读取，未访问该目录".into()),
        },
    }
}
/// 复评 R03：`resolved` 是校验通过后的**实际读取目标**（canonical）。
/// 校验与读取必须用同一个路径，否则校验后替换链接就能让读取落在别处。
async fn run_tool_source(
    path: &Path,
    entry: &crate::local_sources::ToolPath,
    resolved: &Path,
    profile: &Path,
) -> Result<LocalSnapshot, String> {
    let target = resolved.to_string_lossy().to_string();
    if entry.tool == "zcode" {
        return crate::zcode_usage::collect(resolved.to_path_buf()).await;
    }
    // --home loads scanner settings from this app-owned empty home. Never write
    // settings into the user's tool root or copy a live SQLite/WAL database.
    let home = profile.join("scan-home");
    let config = home.join("AppData/Roaming/tokscale");
    std::fs::create_dir_all(&config).map_err(|_| "指定路径的采集设置无法保存")?;
    let settings = if entry.tool == "opencode" {
        serde_json::json!({"scanner":{"opencodeDbPaths":[target]}})
    } else {
        let mut paths = serde_json::Map::new();
        paths.insert(entry.tool.clone(), serde_json::json!([target]));
        serde_json::json!({"scanner":{"extraScanPaths": paths}})
    };
    let temporary = config.join(format!("settings.{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(&settings).map_err(|_| "采集路径设置无法编码")?,
    )
    .map_err(|_| "指定路径的采集设置无法保存")?;
    std::fs::rename(temporary, config.join("settings.json"))
        .map_err(|_| "指定路径的采集设置无法提交")?;
    let snapshot = run_engine_profile(path, Some(&home), &profile.join("cache")).await?;
    if snapshot.rows.iter().any(|row| row.tool != entry.tool) {
        return Err("指定路径采集包含非预期工具，未接收该结果".into());
    }
    Ok(snapshot)
}
/// 复评 Q01：stderr 必须**持续排空到子进程退出**，避免管道背压阻塞引擎。
///
/// 第五轮复评 Q01：上一版 `take(4MiB).read_to_end` 读满即返回并丢弃拥有的
/// 读端 —— 继续写诊断的子进程可能遇到管道关闭/写阻塞，实现与注释的
/// 「持续排空」承诺不一致。现在分块循环读到 EOF；内存预算固定为
/// `STDERR_CAPTURE_BYTES` 摘要 + 8KiB 读块，超出预算的字节**只丢弃并计数**，
/// 绝不提前关闭读端。异常洪流由外层 30 秒超时兜底（kill_on_drop 回收）。
const STDERR_CAPTURE_BYTES: usize = 16 * 1024;
async fn drain_stderr(stderr: impl tokio::io::AsyncRead + Unpin) -> (String, bool) {
    use tokio::io::AsyncReadExt;
    let mut summary: Vec<u8> = Vec::with_capacity(STDERR_CAPTURE_BYTES);
    let mut discarded: u64 = 0;
    let mut chunk = [0u8; 8 * 1024];
    let mut reader = stderr;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break, // EOF：引擎已写完诊断
            Ok(n) => {
                if summary.len() < STDERR_CAPTURE_BYTES {
                    let keep = (STDERR_CAPTURE_BYTES - summary.len()).min(n);
                    summary.extend_from_slice(&chunk[..keep]);
                    discarded += (n - keep) as u64;
                } else {
                    discarded += n as u64;
                }
            }
            // 读错误无法恢复：交回调用方按失败处理（子进程随后被回收）。
            Err(_) => return ("采集引擎诊断读取失败".to_string(), true),
        }
    }
    let mut text = String::from_utf8_lossy(&summary).to_string();
    if discarded > 0 {
        // 按行边界截断，避免把一行警告切成两半。
        let mut cut = text.len();
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str(&format!("\n…（后续诊断已截断，丢弃 {discarded} 字节）"));
    }
    (text, discarded > 0)
}

async fn run_engine_profile(
    path: &Path,
    home: Option<&Path>,
    profile: &Path,
) -> Result<LocalSnapshot, String> {
    verify_engine(path)?;
    let mut command = tokio::process::Command::new(path);
    command
        .args([
            "--json",
            "--client",
            "opencode,claude,zcode,hermes,openclaw,dsh",
            "--group-by",
            "client,workspace,session,model",
            "--month",
            "--no-spinner",
        ])
        .env("TOKSCALE_PRICING_CACHE_ONLY", "1")
        .env("TOKSCALE_CONFIG_DIR", profile)
        .env("DO_NOT_TRACK", "1")
        // 复评 T13：显式移除引擎的环境扩展来源开关。即使未来引擎在 --home
        // 模式下重新读取它，也不允许继承自启动环境扩大扫描根。
        .env_remove("TOKSCALE_EXTRA_DIRS")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // 复评 T13：引擎对越界来源只写 stderr 警告；丢弃它会让边界扩展不可见。
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console window on polling.
    if let Some(home) = home {
        command.arg("--home").arg(home);
    }
    let mut child = command.spawn().map_err(|_| "无法启动本地采集引擎")?;
    let mut data = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let stdout = child.stdout.take().ok_or("采集输出不可用")?;
        let stderr = child.stderr.take().ok_or("采集输出不可用")?;
        // 复评 Q01：两个流都必须**持续排空到子进程退出**。旧实现把 stderr
        // 截断在 16 KiB —— 引擎诊断一旦超过这个量且继续写满管道缓冲，
        // 引擎写 stderr 会阻塞，而父进程只等 stdout EOF，join 永远等不到
        // 另一半完成，最终只能吃 30 秒超时。现在并发排空整个流，
        // stderr 只保留前 16 KiB 摘要并标注截断。
        // stdout 沿用原有上限语义：读 MAX_OUTPUT+1 字节，超出即拒绝。
        let mut bounded_stdout = stdout.take(MAX_OUTPUT + 1);
        let mut stdout_data = Vec::new();
        let stderr_task = tokio::spawn(drain_stderr(stderr));
        let stdout_result = bounded_stdout.read_to_end(&mut stdout_data).await;
        stdout_result.map_err(|_| "无法读取采集结果")?;
        // 复评 Q01 回归防护：读到的数据必须交回外层 `data` 供解析。
        // 漏掉这一步会让解析拿到空 Vec，报「采集结果格式不兼容」。
        data = stdout_data;
        if data.len() as u64 > MAX_OUTPUT {
            // stdout 超限也及时终止子进程，避免继续等它的其他流。
            let _ = child.kill().await;
            let _ = stderr_task.await;
            return Err("采集结果超过安全大小限制");
        }
        let (warnings, truncated) = match stderr_task.await {
            Ok(outcome) => outcome,
            Err(_) => ("采集引擎诊断读取失败".to_string(), false),
        };
        let status = child.wait().await.map_err(|_| "采集进程状态不可用")?;
        if !status.success() {
            return Err("本地记录读取失败，请稍后重试");
        }
        // 警告在进程结束后统一落日志（不含正文，可能含路径）。
        for line in warnings.lines().filter(|line| !line.trim().is_empty()) {
            log::warn!(
                "采集引擎提示{truncated_note}:{line}",
                truncated_note = if truncated { "（已截断）" } else { "" }
            );
        }
        Ok(())
    })
    .await;
    if !matches!(result, Ok(Ok(()))) {
        let _ = child.kill().await;
        return Err(match result {
            Err(_) => "采集超时，已停止旧进程",
            Ok(Err(error)) => error,
            _ => unreachable!(),
        }
        .into());
    }
    let value: Value = serde_json::from_slice(&data).map_err(|_| "采集结果格式不兼容")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟异常")?
        .as_millis() as u64;
    normalize_report(&value, now)
}

#[derive(Default)]
pub struct LocalCollector {
    pub inner: Mutex<LocalState>,
}
#[derive(Default)]
pub struct LocalState {
    pub enabled: Option<bool>,
    pub background_enabled: Option<bool>,
    pub generation: u64,
    pub busy: bool,
    pub snapshot: Option<LocalSnapshot>,
    pub cancel: Option<Arc<tokio::sync::Notify>>,
    pub sources: Option<crate::local_sources::SourceOptions>,
    pub last_scan_failed: bool,
    pub last_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn report(client: &str) -> Value {
        json!({"entries":[{"client":client,"sessionId":"s1","workspaceKey":"opaque","model":"deepseek-test","input":100,"output":30,"reasoning":20,"cacheRead":10,"cacheWrite":0,"messageCount":1,"performance":{"totalDurationMs":2000,"timedTokens":160}}],"workspaces":[{"workspaceKey":"opaque","path":"D:\\Repo"}],"sessions":[{"client":client,"sessionId":"s1","firstActiveMs":0,"lastActiveMs":100}]})
    }
    #[test]
    fn wsl来源仅确认运行后放行_未知停止错误拒绝() {
        use crate::local_sources::{HomeKind, WslStatus};
        let kind = HomeKind::Wsl {
            distro: "Ubuntu".into(),
        };
        assert!(source_gate(&kind, &None).is_err());
        assert!(source_gate(&kind, &Some(Err("timeout".into()))).is_err());
        assert!(source_gate(
            &kind,
            &Some(Ok(WslStatus {
                state: "not-running".into(),
                distros: vec!["Ubuntu".into()]
            }))
        )
        .is_err());
        assert!(source_gate(
            &kind,
            &Some(Ok(WslStatus {
                state: "ok".into(),
                distros: vec!["Debian".into()]
            }))
        )
        .is_err());
        assert!(source_gate(
            &kind,
            &Some(Ok(WslStatus {
                state: "ok".into(),
                distros: vec!["ubuntu".into()]
            }))
        )
        .is_ok());
        assert!(source_gate(&HomeKind::Native, &None).is_ok());
    }
    #[test]
    fn 数据质量四类耗时与计数来源不冒充实测() {
        let mut data = report("opencode");
        data["entries"][0]["tokenAccuracy"] = json!("measured");
        assert_eq!(
            normalize_report(&data, 1).unwrap().rows[0].token_accuracy,
            "unclassified"
        );
        for (timed, expected) in [
            (Some(160), TimingCoverage::Matched),
            (Some(100), TimingCoverage::Partial),
            (Some(170), TimingCoverage::Unverified),
            (None, TimingCoverage::Unverified),
        ] {
            data["entries"][0]["performance"]["timedTokens"] = json!(timed);
            let row = normalize_report(&data, 1).unwrap().rows.remove(0);
            assert_eq!(row.timing_coverage, expected);
            assert_eq!(
                row.timed_duration_ms.is_some(),
                expected == TimingCoverage::Matched
            );
        }
        data["entries"][0]["performance"]["totalDurationMs"] = json!(0);
        assert_eq!(
            normalize_report(&data, 1).unwrap().rows[0].timing_coverage,
            TimingCoverage::Unavailable
        );
    }
    #[test]
    fn 汇总超出前端整数精度不显示伪精确值() {
        let mut data = report("opencode");
        data["entries"][0]["output"] = json!(9_007_199_254_740_991_u64);
        assert_eq!(normalize_report(&data, 1).unwrap().rows[0].output, None);
        data = report("claude");
        data["entries"][0]["input"] = json!(9_007_199_254_740_991_u64);
        let row = normalize_report(&data, 1).unwrap().rows.remove(0);
        assert_eq!(row.total_tokens, None);
        assert_eq!(row.timed_duration_ms, None);
    }
    #[test]
    fn 原始会话归属与推理不双计_重复汇总替换() {
        let mut value = report("opencode");
        let duplicate = value["entries"][0].clone();
        value["entries"].as_array_mut().unwrap().push(duplicate);
        let snapshot = normalize_report(&value, 200).unwrap();
        assert_eq!(snapshot.rows.len(), 1);
        let row = &snapshot.rows[0];
        assert_eq!(row.output, Some(50));
        assert_eq!(row.total_tokens, Some(160));
        assert_eq!(row.timed_output_tokens, Some(50));
        assert_eq!(row.first_active_ms, None);
        assert_eq!(row.project_key.as_deref(), Some("d:/repo"));
    }
    #[test]
    fn 缺项目或部分耗时不猜测_未知字段不跨ipc() {
        let mut value = report("claude");
        value["workspaces"] = json!([]);
        value["entries"][0]["apiKey"] = json!("SECRET");
        let result = normalize_report(&value, 200).unwrap();
        assert_eq!(result.rows[0].project_key, None);
        assert_eq!(result.rows[0].timed_output_tokens, None);
        assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));
    }
    #[test]
    fn 未知工具与缺会话拒绝_负数保持未知() {
        assert!(normalize_report(&report("other"), 200)
            .unwrap()
            .rows
            .is_empty());
        let mut value = report("hermes");
        value["entries"][0]["input"] = json!(-1);
        assert_eq!(
            normalize_report(&value, 200).unwrap().rows[0].total_tokens,
            None
        );
        value["entries"][0]["sessionId"] = Value::Null;
        assert!(normalize_report(&value, 200).unwrap().rows.is_empty());
    }
    #[test]
    fn 引擎被修改拒绝执行() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/local-usage/LICENSE-tokscale.txt");
        assert_eq!(
            verify_engine(&path).unwrap_err(),
            "采集引擎校验失败，请重新安装完整程序"
        );
    }
    #[test]
    fn linux路径大小写保留_不同主目录会话和项目隔离() {
        let mut value = report("opencode");
        value["workspaces"][0]["path"] = json!("/home/user/Repo");
        let one = scope_snapshot(normalize_report(&value, 200).unwrap(), "home-one", "目录1");
        let two = scope_snapshot(normalize_report(&value, 200).unwrap(), "home-two", "目录2");
        assert_ne!(one.rows[0].id, two.rows[0].id);
        assert_ne!(one.rows[0].project_key, two.rows[0].project_key);
        value["workspaces"][0]["path"] = json!("/home/user/repo");
        let lower = scope_snapshot(normalize_report(&value, 200).unwrap(), "home-one", "目录1");
        assert_ne!(one.rows[0].project_key, lower.rows[0].project_key);
    }
    #[tokio::test]
    #[ignore = "仅显式读取六工具合成目录，单路径不访问真实用户数据"]
    async fn 五工具单路径真实引擎与部分失败() {
        use crate::local_sources::{SourceOptions, ToolPath};
        let home = std::path::PathBuf::from(
            std::env::var("DSM_TEST_LOCAL_USAGE_HOME").expect("指定合成目录"),
        );
        let engine =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/local-usage/tokscale.exe");
        let profile = home.join("tool-source-integration-cache");
        let entries = [
            ("opencode", ".local/share/opencode/opencode.db"),
            ("claude", ".claude/projects"),
            ("hermes", ".hermes"),
            ("openclaw", ".openclaw/agents"),
            ("dsh", ".dsh/sessions"),
        ]
        .map(|(tool, relative)| ToolPath {
            tool: tool.into(),
            path: home.join(relative).to_string_lossy().into_owned(),
        });
        for chunk in entries.chunks(3) {
            let options = SourceOptions {
                include_default: false,
                homes: vec![],
                tool_paths: chunk.to_vec(),
            };
            let snapshot = collect_sources(&engine, &options, None, profile.clone())
                .await
                .unwrap();
            assert!(snapshot.complete);
            assert_eq!(snapshot.rows.len(), chunk.len());
            assert!(snapshot.rows.iter().all(|row| row.input == Some(100)
                && row.output == Some(20)
                && row.cache_read == Some(10)));
            assert!(snapshot
                .rows
                .iter()
                .all(|row| row.source_id.starts_with("tool-")));
        }
        let options = SourceOptions {
            include_default: false,
            homes: vec![],
            tool_paths: vec![
                entries[0].clone(),
                ToolPath {
                    tool: "claude".into(),
                    path: home.join("missing-tool").to_string_lossy().into_owned(),
                },
            ],
        };
        let partial = collect_sources(&engine, &options, None, profile)
            .await
            .unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.rows.len(), 1);
        assert_eq!(partial.sources[1].state, "unavailable");
    }
    #[tokio::test]
    #[ignore = "显式设置两个合成主目录，不读取真实本机或WSL数据"]
    async fn 双主目录真实引擎合并_部分失败不当零() {
        let home = std::env::var("DSM_TEST_LOCAL_USAGE_HOME").expect("指定合成目录");
        let second = std::env::var("DSM_TEST_LOCAL_USAGE_SECOND_HOME").expect("指定第二合成目录");
        let engine =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/local-usage/tokscale.exe");
        let profile = std::path::PathBuf::from(&home).join("source-integration-cache");
        let options = crate::local_sources::SourceOptions {
            include_default: false,
            homes: vec![home.clone(), second.clone()],
            ..Default::default()
        };
        let snapshot = collect_sources(&engine, &options, None, profile.clone())
            .await
            .unwrap();
        assert!(snapshot.complete);
        assert_eq!(snapshot.rows.len(), 12);
        assert_eq!(
            snapshot
                .rows
                .iter()
                .map(|row| &row.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            12
        );
        assert_eq!(
            snapshot
                .rows
                .iter()
                .map(|row| &row.source_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            2
        );
        assert!(snapshot.sources.iter().all(|source| source.state == "ok"));
        let options = crate::local_sources::SourceOptions {
            include_default: false,
            homes: vec![home.clone(), format!("{home}\\missing-home")],
            ..Default::default()
        };
        let partial = collect_sources(&engine, &options, None, profile)
            .await
            .unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.rows.len(), 6);
        assert_eq!(partial.sources[1].state, "unavailable");
        let default_missing = collect_sources(
            &engine,
            &crate::local_sources::SourceOptions {
                include_default: true,
                homes: vec![home.clone()],
                ..Default::default()
            },
            None,
            std::path::PathBuf::from(&home).join("source-integration-cache"),
        )
        .await
        .unwrap();
        assert!(!default_missing.complete);
        assert_eq!(default_missing.rows.len(), 6);
        assert_eq!(default_missing.sources[0].state, "unavailable");
    }

    #[tokio::test]
    #[ignore = "需显式指定合成数据目录和已校验的本地引擎，不读取真实用户日志"]
    async fn 六工具合成记录经真实引擎和ipc归一化一致() {
        let home = std::env::var_os("DSM_TEST_LOCAL_USAGE_HOME").expect("需要合成目录");
        let engine =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/local-usage/tokscale.exe");
        let snapshot = run_engine(&engine, Some(Path::new(&home))).await.unwrap();
        assert_eq!(snapshot.rows.len(), 6);
        let tools: std::collections::BTreeSet<_> =
            snapshot.rows.iter().map(|row| row.tool.as_str()).collect();
        assert_eq!(tools, CLIENTS.iter().copied().collect());
        for row in &snapshot.rows {
            assert_eq!(row.total_tokens, Some(130));
            assert_eq!(row.output, Some(20));
        }
        assert!(snapshot
            .rows
            .iter()
            .any(|row| row.tool == "opencode" && row.timed_duration_ms == Some(1000)));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE_TITLE"));
    }

    // ---------- 第五轮复评 Q01：stderr 持续排空 ----------

    #[tokio::test]
    async fn q01_stderr小输入完整保留无截断() {
        let (text, truncated) = drain_stderr(std::io::Cursor::new(b"engine warn".as_slice())).await;
        assert_eq!(text, "engine warn");
        assert!(!truncated);
        let (text, truncated) = drain_stderr(std::io::Cursor::new(&b""[..])).await;
        assert_eq!(text, "");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn q01_stderr超额只丢弃并计数_读端读到eof() {
        // 摘要预算 16KiB + 5000 字节：保留前 16KiB，其余只丢弃。
        // 旧实现 take(4MiB) 读满即返回并丢弃读端 —— 新实现必须消费到 EOF
        // 并以丢弃计数标注截断，内存占用停在摘要预算附近。
        let payload = vec![b'x'; STDERR_CAPTURE_BYTES + 5000];
        let (text, truncated) = drain_stderr(std::io::Cursor::new(payload)).await;
        assert!(truncated);
        assert!(text.starts_with('x'), "前缀摘要应保留");
        assert!(text.contains("丢弃 5000 字节"), "实际输出：{text}");
        assert!(
            text.len() < STDERR_CAPTURE_BYTES + 100,
            "摘要不得膨胀到与全量等长"
        );
    }

    // ---------- 第五轮复评 Q07：来源根链接预审 ----------

    #[test]
    fn q07_来源根审计_普通嵌套目录通过() {
        let base = std::env::temp_dir().join(format!("dsm-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::write(base.join("a.log"), b"x").unwrap();
        std::fs::write(base.join("sub/b.log"), b"y").unwrap();
        let outcome = audit_root_for_reparse(&base);
        assert!(matches!(outcome, Ok(ReparseAudit::Clean)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn q07_来源根审计_空目录通过且不依赖条目() {
        let base = std::env::temp_dir().join(format!("dsm-audit-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let outcome = audit_root_for_reparse(&base);
        assert!(matches!(outcome, Ok(ReparseAudit::Clean)));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---------- 第六轮复评 R04：目录链接不得被误当成文件链接 ----------

    #[cfg(unix)]
    #[test]
    fn r04_目录链接不被拒绝_文件链接仍拒绝() {
        let base = std::env::temp_dir().join(format!("dsm-audit-link-{}", std::process::id()));
        std::fs::create_dir_all(base.join("real-dir")).unwrap();
        std::fs::write(base.join("real.log"), b"x").unwrap();
        // 目录链接：引擎的通用遍历不跟随目录链接 → 不该拒绝整个来源。
        std::os::unix::fs::symlink(base.join("real-dir"), base.join("dir-link")).unwrap();
        assert!(
            matches!(audit_root_for_reparse(&base), Ok(ReparseAudit::Clean)),
            "目录链接不得导致整个来源被拒"
        );
        // 文件链接：引擎会跟随读取目标 → 必须拒绝。
        std::os::unix::fs::symlink(base.join("real.log"), base.join("file-link.log")).unwrap();
        assert!(audit_root_for_reparse(&base).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---------- 第六轮复评 R03：settings 两个来源字段都被提取 ----------

    /// 复评 R04：Windows 原生符号链接场景。没有创建权限时明确记为跳过，
    ///(不能把「没跑」当成通过 —— 真机验收仍待补)。
    #[cfg(windows)]
    #[test]
    fn r04_目录链接不被拒绝_文件链接仍拒绝_windows() {
        let base = std::env::temp_dir().join(format!("dsm-audit-wlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real-dir")).unwrap();
        std::fs::write(base.join("real.log"), b"x").unwrap();
        // junction：普通用户即可创建，是最常见的目录名称代理。
        let junction = base.join("dir-junction");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(base.join("real-dir"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if made {
            // 前提锁定：junction 在 std 里同样算 `is_symlink()`（名称代理）。
            // 若这条不成立，审计会走「普通目录」分支并进入目标 —— 那才是
            // 真正的越界，必须先被这个断言抓到。
            let meta = std::fs::symlink_metadata(&junction).unwrap();
            assert!(
                meta.file_type().is_symlink(),
                "junction 必须被识别为链接，否则审计会进入目标目录"
            );
            assert!(is_dir_link(&meta), "junction 必须被判为目录链接");
            assert!(
                matches!(audit_root_for_reparse(&base), Ok(ReparseAudit::Clean)),
                "junction 是目录名称代理：引擎不跟随，不得拒绝整个来源"
            );
            std::fs::remove_dir(&junction).ok();
        } else {
            eprintln!("NOT RUN：当前环境无法创建 junction");
        }
        // 目录符号链接需要创建符号链接权限，没有权限时明确跳过。
        let dir_link = base.join("dir-link");
        match std::os::windows::fs::symlink_dir(base.join("real-dir"), &dir_link) {
            Ok(()) => {
                assert!(
                    matches!(audit_root_for_reparse(&base), Ok(ReparseAudit::Clean)),
                    "目录符号链接：引擎的通用遍历不跟随，不得拒绝整个来源"
                );
                std::fs::remove_dir(&dir_link).ok();
            }
            Err(error) => {
                eprintln!("NOT RUN：当前环境无法创建目录符号链接（{error}）");
            }
        }
        let file_link = base.join("file-link.log");
        match std::os::windows::fs::symlink_file(base.join("real.log"), &file_link) {
            Ok(()) => {
                assert!(
                    audit_root_for_reparse(&base).is_err(),
                    "文件链接：引擎会跟随读取目标，必须拒绝"
                );
                std::fs::remove_file(&file_link).ok();
            }
            Err(error) => {
                eprintln!("NOT RUN：当前环境无法创建文件符号链接（{error}）");
            }
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn r03_settings解析覆盖两个字段与目录文件语义() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"scanner":{
                "extraScanPaths":{"claude":["D:\\Logs\\Claude"],"dsh":["D:\\Logs\\Dsh"]},
                "opencodeDbPaths":["D:\\Db\\opencode.db","D:\\Db\\other.db"]
            }}"#,
        )
        .unwrap();
        let roots = engine_config_roots(&value).unwrap();
        assert_eq!(roots.len(), 4, "两个 extra 目录 + 两个 opencode 数据库");
        assert!(roots
            .iter()
            .any(|(tool, path, dir)| tool == "claude" && path.ends_with("Claude") && *dir));
        assert!(roots
            .iter()
            .any(|(tool, path, dir)| tool == "opencode" && path.ends_with("opencode.db") && !*dir));
    }

    #[test]
    fn r03_settings字段形态非法时失败关闭() {
        // extraScanPaths 不是对象。
        let bad_extra: serde_json::Value =
            serde_json::from_str(r#"{"scanner":{"extraScanPaths":["x"]}}"#).unwrap();
        assert!(engine_config_roots(&bad_extra).is_err());
        // 某工具的值不是数组。
        let bad_list: serde_json::Value =
            serde_json::from_str(r#"{"scanner":{"extraScanPaths":{"claude":"x"}}}"#).unwrap();
        assert!(engine_config_roots(&bad_list).is_err());
        // opencodeDbPaths 不是数组。
        let bad_db: serde_json::Value =
            serde_json::from_str(r#"{"scanner":{"opencodeDbPaths":"D:\\db"}}"#).unwrap();
        assert!(engine_config_roots(&bad_db).is_err());
        // opencodeDbPaths 含非字符串项。
        let bad_item: serde_json::Value =
            serde_json::from_str(r#"{"scanner":{"opencodeDbPaths":[1]}}"#).unwrap();
        assert!(engine_config_roots(&bad_item).is_err());
        // 没有 scanner 字段：没有扩展来源。
        let empty: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(engine_config_roots(&empty).unwrap().is_empty());
    }

    // ---------- 第六轮复评 R02/R04：home 预审只覆盖真实扫描根 ----------

    #[cfg(unix)]
    #[test]
    fn r04_home预审忽略无关目录链接_只审布局根() {
        let home = std::env::temp_dir().join(format!("dsm-home-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // 标准布局根内有普通日志。
        std::fs::create_dir_all(home.join(".claude/projects/s1")).unwrap();
        std::fs::write(home.join(".claude/projects/s1/a.jsonl"), b"{}").unwrap();
        // home 里与采集无关的目录含目录链接（复评 R04：不得拒绝整个 home）。
        std::fs::create_dir_all(home.join("projects")).unwrap();
        std::os::unix::fs::symlink(&home, home.join("projects/loop")).unwrap();
        let outcome = audit_home_layout_roots(&home, crate::local_sources::SourceOrigin::Native);
        assert!(
            matches!(outcome, Ok(ReparseAudit::Clean)),
            "无关目录里的目录链接不应拒绝 home：{:?}",
            outcome.err()
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
