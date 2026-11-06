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
// OpenClaw resolves usage through Codex transcripts, even when Codex is not
// requested as output. These are read boundaries, not additional output tools.
const READ_CLIENTS: &[&str] = &[
    "opencode", "claude", "zcode", "hermes", "openclaw", "dsh", "codex",
];
const MAX_OUTPUT: u64 = 16 * 1024 * 1024;
const ENGINE_MANIFEST: &str = include_str!("../../scripts/local-usage-engine.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRow {
    pub id: String,
    pub tool: String,
    /// 复评 N01：**稳定 client 身份**（引擎输出的原始 client，如
    /// `claude` / `claude-mirror` / `cc-mirror:xxx`）。
    ///
    /// `tool` 是展示槽位（镜像归到 claude），而 client_id 才是会话归属的
    /// 真实身份。分组、留存 ID、归档与导出都必须用它，否则同 source 下
    /// 原生 Claude 与多个 mirror 的同名 sessionId 会被合并成一条记录，
    /// 后一轮只有一个 variant 出现时还会**覆盖**其它会话的留存（历史丢失）。
    /// 旧 schema 缺省保持空串，身份未知，不按 `tool` 猜测 client。
    #[serde(default)]
    pub client_id: String,
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
    /// 复评 N03：**质量证据**（脱敏、稳定 code），与 `complete`（读取是否
    /// 完整）分开。已知重叠时 `complete` 仍为 true，但去重可信度下降 ——
    /// 旧实现只写一句来源 message，导出/留存/归档都拿不到这条结论，
    /// 用户看到 complete=true 就会把重复合计当成准确值。
    /// 只放 code 与可读说明，不放可能含路径的原始 message。
    #[serde(default)]
    pub quality_warnings: Vec<String>,
    /// False only for legacy snapshots that did not record quality evidence.
    #[serde(default)]
    pub quality_evidence_recorded: bool,
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
    // 复评 R05：固定引擎的 Claude 解析器会把 cc-mirror 的 variant 作为独立
    // client（如 `claude-mirror`/`cc-mirror:*`）输出，上游明确为 claude 请求
    // 保留并原样导出。旧实现用 `CLIENTS.contains` 严格相等过滤，把这些条目
    // **静默丢弃**，而来源仍标成功/complete —— 用户看到的是「采集成功但数据
    // 变少」，且 home 成功后还会登记镜像覆盖，抑制能解析成普通 claude 的
    // 单工具退路。
    // 现在：镜像 client 归到 claude 槽位（保留原始 client 名与 variant 身份，
    // 不做会制造会话碰撞的整体改名 —— 会话键仍按原始 client 区分）。
    let canonical_tool = |client: &str| -> Option<(&'static str, bool)> {
        if CLIENTS.contains(&client) {
            return Some((
                CLIENTS.iter().find(|tool| **tool == client).copied()?,
                false,
            ));
        }
        // 镜像识别：以 `claude` 为前缀或显式带 mirror 标记的 client。
        let lower = client.to_ascii_lowercase();
        if lower.starts_with("claude-mirror")
            || lower.starts_with("cc-mirror")
            || (lower.starts_with("claude") && lower.contains("mirror"))
        {
            return Some(("claude", true));
        }
        None
    };
    for entry in entries {
        let Some(raw_client) = text(entry, "client") else {
            continue;
        };
        let Some((tool, is_mirror)) = canonical_tool(&raw_client) else {
            continue;
        };
        // 复评 R05：会话与行的身份仍按**原始 client** 区分 —— 镜像与原生
        // claude 的同名 sessionId 不能被合并成同一会话（那会制造碰撞）。
        let identity = if is_mirror { raw_client.as_str() } else { tool };
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
        let output = if matches!(tool, "opencode" | "zcode" | "dsh") {
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
        let meta = sessions.get(&format!("{identity}\0{session_id}"));
        let id = format!(
            "{identity}\0{}\0{session_id}\0{model}",
            project_key.as_deref().unwrap_or("")
        );
        rows.insert(
            id.clone(),
            LocalRow {
                id,
                tool: tool.to_string(),
                client_id: identity.to_string(),
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
        quality_warnings: Vec::new(),
        quality_evidence_recorded: true,
    })
}

pub fn verify_engine(path: &Path) -> Result<(), String> {
    io_checkpoint()?;
    let manifest: Value = serde_json::from_str(ENGINE_MANIFEST).map_err(|_| "采集引擎配置损坏")?;
    let file = std::fs::File::open(path).map_err(|_| "采集引擎未就绪，请重新安装完整程序")?;
    if file.metadata().map_err(|_| "无法读取采集引擎")?.len() > 50 * 1024 * 1024 {
        return Err("采集引擎大小异常".into());
    }
    use std::io::Read;
    let mut hash = Sha256::new();
    let mut reader = file.take(50 * 1024 * 1024 + 1);
    let mut total = 0usize;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        io_checkpoint()?;
        let count = reader.read(&mut chunk).map_err(|_| "采集引擎校验失败")?;
        if count == 0 {
            break;
        }
        total += count;
        if total > 50 * 1024 * 1024 {
            return Err("采集引擎大小异常".into());
        }
        hash.update(&chunk[..count]);
    }
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
    // Same-invocation aliases are skipped only after that invocation succeeds.
    // A home's declared roots never suppress a separately configured tool:
    // exit 0 cannot establish per-root adoption or successful parser reads.
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
    // Completed invocations retain their declarations only to flag overlap.
    // The pinned executable does not return per-root adoption/read receipts.
    let mut completed_plans: Vec<(crate::local_overlap::ScanRoot, String)> = Vec::new();
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    let mut succeeded = 0;
    let mut zcode_adapter_used = false;
    let mut has_overlap = false;
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
            let mut overlap = false;
            let mut duplicate_owner = None;
            let mut settings_notice = None;
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
                let requested = home.clone();
                let expect = if directory {
                    crate::local_sources::ResolvedExpect::Directory
                } else {
                    crate::local_sources::ResolvedExpect::File
                };
                let canonical = run_bounded_io(move || {
                    crate::local_sources::resolve_layout_root(&requested, origin, expect)
                })
                .await??;
                if tool_path.is_some_and(|entry| entry.tool == "opencode") {
                    require_opencode_database_name(&canonical)?;
                }
                let key = match tool_path {
                    Some(entry) => format!(
                        "tool:{}:{}",
                        entry.tool,
                        home_key(&canonical.to_string_lossy())
                    ),
                    None => format!("home:{}", home_key(&canonical.to_string_lossy())),
                };
                if let Some(owner) = seen.get(&key) {
                    duplicate_owner = Some(owner.clone());
                    return Ok(None);
                }
                // Build and validate the entire plan before overlap decisions. This
                // also keeps discovery, canonicalization and audits off async poll.
                let (mut plan, audit_budget) = if let Some(entry) = tool_path {
                    let mut tool_plan = vec![RegisteredRoot {
                        tool: entry.tool.clone(),
                        client: entry.tool.clone(),
                        engine_path: canonical.clone(),
                        path: canonical.clone(),
                        expect,
                        origin,
                        optional: false,
                    }];
                    if directory {
                        let audit_root = canonical.clone();
                        let tool = entry.tool.clone();
                        let databases = run_bounded_io(move || {
                            let mut budget = AuditBudget::default();
                            require_complete_audit(audit_root_for_reparse_budgeted(
                                &audit_root,
                                origin,
                                &mut budget,
                            )?)?;
                            audit_special_databases(&audit_root, &tool, false, origin, &mut budget)
                        })
                        .await??;
                        tool_plan.extend(databases);
                    } else {
                        let database = canonical.clone();
                        run_bounded_io(move || audit_database_sidecars(&database, origin))
                            .await??;
                    }
                    (tool_plan, AuditBudget::default())
                } else {
                    let root = canonical.clone();
                    run_bounded_io(move || {
                        audit_engine_aux_configs(&root, origin)?;
                        let mut budget = AuditBudget::default();
                        let roots =
                            validated_standard_roots_with_budget(&root, origin, &mut budget)?;
                        Ok::<_, String>((roots, budget))
                    })
                    .await??
                };
                let extra = validate_engine_extra_roots(
                    &canonical,
                    origin,
                    tool_path.is_none(),
                    &mut wsl_memo,
                    audit_budget,
                )
                .await?;
                if let Some(extra) = extra {
                    settings_notice =
                        Some("该主目录的引擎扩展根已按应用来源策略校验，不合规会拒绝采集");
                    plan.extend(extra);
                }
                check_plan_size(plan.len())?;
                let dependency_plan = plan.clone();
                run_bounded_io(move || audit_claude_dependencies(&dependency_plan)).await??;
                let scan_plan: Vec<_> = plan.iter().map(RegisteredRoot::scan_root).collect();
                let coverage = crate::local_overlap::compare_plans(&scan_plan, &completed_plans);
                debug_assert!(coverage.covered_by.is_none());
                // The fixed executable cannot exclude individual home roots. Do
                // not discard unique data or pretend this is a deduplicated total.
                overlap = coverage.partial;
                let snapshot = if let Some(entry) = tool_path {
                    run_tool_source(path, entry, &canonical, &profile.join(&id)).await?
                } else {
                    run_engine_profile(path, Some(&canonical), &profile.join(&id)).await?
                };
                seen.insert(key, label.clone());
                completed_plans.extend(scan_plan.into_iter().map(|root| (root, label.clone())));
                Ok::<_, String>(Some(scope_snapshot(snapshot, &id, &label)))
            })
            .await;
            match result {
                Ok(Ok(Some(snapshot))) => {
                    zcode_adapter_used |=
                        snapshot.engine_version == crate::zcode_usage::ADAPTER_VERSION;
                    has_overlap |= overlap;
                    if overlap {
                        message = Some("实际读取根部分重叠；已保留独有数据，但固定引擎无法剔除重叠根，合计可能重复".into());
                    }
                    if let Some(notice) = settings_notice {
                        message = Some(match message.take() {
                            Some(existing) => format!("{existing}；{notice}"),
                            None => notice.to_string(),
                        });
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
                    let covering = duplicate_owner.unwrap_or_else(|| "相同来源".into());
                    message = Some(format!(
                        "与来源「{covering}」的已完成采集入口相同，未重复执行"
                    ));
                }
                Ok(Err(error)) => {
                    state = "unavailable";
                    message = Some(error);
                }
                Err(_) => {
                    state = "unavailable";
                    message = Some(
                        "本轮采集达到60秒预算，已停止等待；未返回的文件系统操作仍占用检查许可"
                            .into(),
                    );
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
    // 复评 N03：已知重叠必须作为**质量证据**贯穿输出（导出/留存/归档），
    // 而不是只写一句来源 message。这里收集稳定 code，`complete` 语义保持
    // 「读取是否完整」，不因去重不确定而变 false。
    let mut quality_warnings: Vec<String> = Vec::new();
    if has_overlap {
        quality_warnings.push("overlap_partial".into());
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
        quality_warnings,
        quality_evidence_recorded: true,
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
    /// 预审不完整（目录过大/不可读）：拒绝来源，不能当成已验证。
    Incomplete(&'static str),
}

/// 目录条目审计上限：元数据遍历，不含文件内容读取。超过按「预审不完整」
/// 处理并拒绝该来源；不能让引擎继续读取尚未验证的目录。
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

/// 复评 R07：把同步链接预审放进**单许可** blocking worker。
///
/// 预审由 `read_dir` / `metadata` / `canonicalize` 组成，都是同步 IO：
/// 在 async poll 里执行时，外层 `tokio::time::timeout` 只能在 poll 交还后
/// 才生效，一次慢盘/过滤驱动调用就能把整轮采集拖住。这里：
/// 1. 单许可信号量 —— 同一时刻只有一个预审在跑，重复刷新不会堆积阻塞线程；
/// 2. `spawn_blocking` 承载同步调用，async 侧可正常被取消（许可随任务
///    结束释放；OS 调用本身无法被抢占，这一点如实保留，不宣称已中止 IO）。
///
/// 复评 N08：**所有**同步文件系统发现/读取/校验都走这一个有界 IO 层。
///
/// 旧实现只把标准布局预审放进 worker，配置读取、镜像发现、扩展根审计与
/// 事后登记仍在 async poll 里同步执行 —— 一次慢盘/WSL/过滤驱动阻塞就能让
/// 外层 60 秒预算迟返。这里统一：
/// 1. 共享**单许可**信号量：同一时刻只有一个同步任务在跑，重复刷新不会
///    堆积阻塞线程；
/// 2. `spawn_blocking` 承载同步调用，async 侧可正常被取消；
/// 3. 许可随任务结束释放 —— OS 调用本身无法被抢占，这一点如实保留，
///    不宣称已中止 IO，也不在调用未返时释放许可。
#[derive(Clone)]
struct IoControl {
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    deadline: std::time::Instant,
}
thread_local! {
    static IO_CONTROL: std::cell::RefCell<Option<IoControl>> = const { std::cell::RefCell::new(None) };
}
pub(crate) fn io_checkpoint() -> Result<(), String> {
    IO_CONTROL.with(|slot| {
        if slot.borrow().as_ref().is_some_and(|control| {
            control.cancelled.load(std::sync::atomic::Ordering::Relaxed)
                || std::time::Instant::now() >= control.deadline
        }) {
            Err("文件系统检查已取消或达到期限".into())
        } else {
            Ok(())
        }
    })
}
struct CancelIoOnDrop(Arc<std::sync::atomic::AtomicBool>);
impl Drop for CancelIoOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}
async fn run_bounded_io<F, T>(task: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    static PERMIT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let permit = PERMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "文件系统检查仍在进行，请稍后重试")?;
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _cancel_on_drop = CancelIoOnDrop(cancelled.clone());
    let control = IoControl {
        cancelled,
        deadline: std::time::Instant::now() + Duration::from_secs(60),
    };
    let collection = crate::commands::collection_worker_lease();
    tokio::task::spawn_blocking(move || {
        // The permit lives in the worker even when its waiter is cancelled.
        let _permit = permit;
        let _collection = collection;
        IO_CONTROL.with(|slot| *slot.borrow_mut() = Some(control));
        struct ClearControl;
        impl Drop for ClearControl {
            fn drop(&mut self) {
                IO_CONTROL.with(|slot| *slot.borrow_mut() = None);
            }
        }
        let _clear = ClearControl;
        task()
    })
    .await
    .map_err(|_| "文件系统检查任务失败".to_string())
}

fn require_complete_audit(audit: ReparseAudit) -> Result<(), String> {
    match audit {
        ReparseAudit::Clean => Ok(()),
        ReparseAudit::Incomplete(reason) => Err(format!("{reason}，已拒绝该来源以保证读取边界")),
    }
}

/// 复评 Q07：审计来源根内的**文件符号链接**。
///
/// 固定引擎的文件发现接受 `is_symlink() && path.is_file()` 并读取目标 ——
/// 根内一个指向外部的日志文件链接就能把读取范围带出已确认的来源边界，
/// 且应用无法在引擎内部拦截。这里在启动引擎前用**不跟随**的目录遍历检查；
/// 发现文件链接（含断链）即拒绝该来源。目录链接不进入：引擎的通用遍历
/// 不跟随目录链接，标准布局根上的目录链接由布局解析按策略单独解析登记。
#[cfg(test)]
fn audit_root_for_reparse(root: &Path) -> Result<ReparseAudit, String> {
    audit_root_for_reparse_budgeted(
        root,
        crate::local_sources::SourceOrigin::Native,
        &mut AuditBudget::default(),
    )
}

#[derive(Default)]
struct AuditBudget {
    entries: usize,
    active: std::collections::BTreeSet<std::path::PathBuf>,
    completed: std::collections::BTreeSet<std::path::PathBuf>,
}

/// Explicit DFS keeps all ordinary entries and link branches in one budget.
/// A visiting identity is a cycle, not a successfully audited directory.
fn audit_root_for_reparse_budgeted(
    root: &Path,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut AuditBudget,
) -> Result<ReparseAudit, String> {
    let mut stack = vec![(root.to_path_buf(), false)];
    while let Some((requested, exiting)) = stack.pop() {
        io_checkpoint()?;
        if exiting {
            budget.active.remove(&requested);
            budget.completed.insert(requested);
            continue;
        }
        // Never canonicalize/read_dir a target until *every* parent and target
        // link has passed the original origin and WSL-distribution boundary.
        crate::local_sources::check_link_chain(&requested, origin)?;
        let identity =
            std::fs::canonicalize(&requested).map_err(|_| "目录身份无法解析，链接预审未完整")?;
        crate::local_sources::recheck_resolved_target(
            &requested.to_string_lossy(),
            &identity,
            crate::local_sources::ResolvedExpect::Directory,
            origin,
        )?;
        if budget.active.contains(&identity) {
            return Err("目录链接形成回环，已拒绝该来源".into());
        }
        if budget.completed.contains(&identity) {
            continue;
        }
        budget.active.insert(identity.clone());
        stack.push((identity.clone(), true));
        io_checkpoint()?;
        let entries = match std::fs::read_dir(&identity) {
            Ok(entries) => entries,
            Err(_) => return Ok(ReparseAudit::Incomplete("子目录无法读取，链接预审未完整")),
        };
        for entry in entries {
            io_checkpoint()?;
            budget.entries += 1;
            if budget.entries > REPARSE_AUDIT_MAX_ENTRIES {
                return Ok(ReparseAudit::Incomplete("目录过大，链接预审未完整"));
            }
            let entry = entry.map_err(|_| "目录项无法读取，链接预审未完整")?;
            let meta = std::fs::symlink_metadata(entry.path())
                .map_err(|_| "目录项类型无法读取，链接预审未完整")?;
            if crate::local_sources::is_reparse_entry(&meta) {
                if !is_dir_link(&meta) {
                    return Err("来源目录内包含文件链接或未知名称代理，已拒绝该来源".into());
                }
                // WalkDir probes is_file on links but never descends into a
                // directory link. Check that probe's full chain, not unrelated
                // trees. Specialized database discovery is audited separately.
                crate::local_sources::resolve_layout_root(
                    &entry.path(),
                    origin,
                    crate::local_sources::ResolvedExpect::Directory,
                )?;
            } else if meta.is_dir() {
                stack.push((entry.path(), false));
            }
        }
    }
    Ok(ReparseAudit::Clean)
}

/// 复评 R04：home 来源的链接预审只覆盖**实际扫描根** —— 六款工具的标准
/// 布局根（R02 窄化后的多根）。无关目录里的链接不再拒绝整个 home。
/// 布局根本身是目录链接时按策略解析（junction 到允许目标是既有语义），
/// 解析后审计其内容；布局根的链接目标越界 = 引擎会读到越界数据，直接拒绝。
#[cfg(all(test, unix))]
fn audit_home_layout_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<ReparseAudit, String> {
    validated_standard_roots(home, origin).map(|_| ReparseAudit::Clean)
}

#[cfg(test)]
fn validated_standard_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<Vec<RegisteredRoot>, String> {
    validated_standard_roots_with_budget(home, origin, &mut AuditBudget::default())
}

fn validated_standard_roots_with_budget(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut AuditBudget,
) -> Result<Vec<RegisteredRoot>, String> {
    let mut roots = Vec::new();
    for tool in READ_CLIENTS {
        for layout in crate::local_overlap::standard_layouts(tool) {
            io_checkpoint()?;
            let path = home.join(layout.relative);
            crate::local_sources::check_link_chain(&path, origin)?;
            match std::fs::symlink_metadata(&path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("布局根状态不可读取，已拒绝该来源".into()),
            }
            let expect = match layout.kind {
                crate::local_overlap::LayoutKind::Directory => {
                    crate::local_sources::ResolvedExpect::Directory
                }
                crate::local_overlap::LayoutKind::File => {
                    crate::local_sources::ResolvedExpect::File
                }
            };
            let resolved = crate::local_sources::resolve_layout_root(&path, origin, expect)?;
            if expect == crate::local_sources::ResolvedExpect::Directory {
                if matches!(*tool, "hermes" | "opencode") {
                    roots.extend(audit_special_databases(&path, tool, true, origin, budget)?);
                    check_plan_size(roots.len())?;
                    continue;
                }
                require_complete_audit(audit_root_for_reparse_budgeted(
                    &resolved, origin, budget,
                )?)?;
                if *tool == "openclaw" {
                    roots.extend(audit_special_databases(&path, tool, false, origin, budget)?);
                }
            } else {
                audit_database_sidecars(&path, origin)?;
                audit_database_sidecars(&resolved, origin)?;
            }
            check_plan_size(roots.len() + 1)?;
            roots.push(RegisteredRoot {
                tool: tool.to_string(),
                client: tool.to_string(),
                engine_path: path,
                path: resolved,
                expect,
                origin,
                optional: false,
            });
        }
    }
    Ok(roots)
}

fn count_audit_entry(budget: &mut AuditBudget) -> Result<(), String> {
    io_checkpoint()?;
    budget.entries += 1;
    if budget.entries > REPARSE_AUDIT_MAX_ENTRIES {
        Err("目录项累计超过检查上限，已拒绝该来源".into())
    } else {
        Ok(())
    }
}

fn audit_directory_entries(
    path: &Path,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut AuditBudget,
) -> Result<Vec<std::path::PathBuf>, String> {
    io_checkpoint()?;
    crate::local_sources::check_link_chain(path, origin)?;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(Vec::new())
        }
        Err(_) => return Err("专用数据库目录无法枚举，已拒绝该来源".into()),
    };
    let mut paths = Vec::new();
    for entry in entries {
        count_audit_entry(budget)?;
        paths.push(entry.map_err(|_| "专用数据库目录项无法读取")?.path());
    }
    Ok(paths)
}

fn audit_database_sidecars(
    path: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<(), String> {
    for suffix in ["-wal", "-shm", "-journal"] {
        io_checkpoint()?;
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        crate::local_sources::check_link_chain(Path::new(&sidecar), origin)?;
    }
    Ok(())
}

fn audit_optional_database(
    path: &Path,
    tool: &str,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut AuditBudget,
) -> Result<Option<RegisteredRoot>, String> {
    count_audit_entry(budget)?;
    crate::local_sources::check_link_chain(path, origin)?;
    match std::fs::metadata(path) {
        Ok(meta) if !meta.is_file() => return Ok(None),
        Ok(_) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err("专用数据库状态无法检查，已拒绝该来源".into()),
    }
    let resolved = crate::local_sources::resolve_layout_root(
        path,
        origin,
        crate::local_sources::ResolvedExpect::File,
    )?;
    // SQLite may resolve its side files beside the supplied or canonical path.
    audit_database_sidecars(path, origin)?;
    audit_database_sidecars(&resolved, origin)?;
    Ok(Some(RegisteredRoot {
        tool: tool.into(),
        client: tool.into(),
        engine_path: path.to_path_buf(),
        optional: false,
        path: resolved,
        expect: crate::local_sources::ResolvedExpect::File,
        origin,
    }))
}

fn is_opencode_database_name(name: &str) -> bool {
    if name == "opencode.db" {
        return true;
    }
    name.strip_prefix("opencode-")
        .and_then(|name| name.strip_suffix(".db"))
        .is_some_and(|channel| {
            !channel.is_empty()
                && channel
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

/// The fixed scanner filters the supplied basename before canonicalizing.
/// Explicit tool sources supply the canonical path, so validate that exact
/// name rather than the spelling of a symlink chosen in the settings UI.
fn require_opencode_database_name(path: &Path) -> Result<(), String> {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_opencode_database_name)
    {
        Ok(())
    } else {
        Err("OpenCode规范目标文件名不受固定引擎支持；须为opencode.db或opencode-渠道.db，未将命名跳过当成空用量".into())
    }
}

/// The fixed engine's specialized discovery is shallow. Check only its exact
/// database components, not arbitrary trees beneath a linked agent/profile.
fn audit_special_databases(
    root: &Path,
    tool: &str,
    home_layout: bool,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut AuditBudget,
) -> Result<Vec<RegisteredRoot>, String> {
    let mut roots = Vec::new();
    match tool {
        "openclaw" => {
            for agent in audit_directory_entries(root, origin, budget)? {
                crate::local_sources::check_link_chain(&agent, origin)?;
                match std::fs::metadata(&agent) {
                    Ok(meta) if meta.is_dir() => {
                        if let Some(db) = audit_optional_database(
                            &agent.join("agent/openclaw-agent.sqlite"),
                            tool,
                            origin,
                            budget,
                        )? {
                            push_plan_root(&mut roots, db)?;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => return Err("OpenClaw agent 状态无法检查".into()),
                }
            }
        }
        "hermes" if home_layout => {
            if let Some(db) = audit_optional_database(&root.join("state.db"), tool, origin, budget)?
            {
                push_plan_root(&mut roots, db)?;
            }
            if root
                .parent()
                .and_then(Path::file_name)
                .is_none_or(|name| name != "profiles")
            {
                for profile in audit_directory_entries(&root.join("profiles"), origin, budget)? {
                    if let Some(db) =
                        audit_optional_database(&profile.join("state.db"), tool, origin, budget)?
                    {
                        push_plan_root(&mut roots, db)?;
                    }
                }
            }
        }
        "opencode" if home_layout => {
            for entry in audit_directory_entries(root, origin, budget)? {
                // Upstream is_file also probes non-database symlink entries.
                crate::local_sources::check_link_chain(&entry, origin)?;
                if entry
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_opencode_database_name)
                {
                    if let Some(db) = audit_optional_database(&entry, tool, origin, budget)? {
                        push_plan_root(&mut roots, db)?;
                    }
                }
            }
            let legacy = root.join("storage/message");
            crate::local_sources::check_link_chain(&legacy, origin)?;
            match std::fs::metadata(&legacy) {
                Ok(meta) if meta.is_dir() => {
                    let canonical = crate::local_sources::resolve_layout_root(
                        &legacy,
                        origin,
                        crate::local_sources::ResolvedExpect::Directory,
                    )?;
                    require_complete_audit(audit_root_for_reparse_budgeted(
                        &canonical, origin, budget,
                    )?)?;
                    check_plan_size(roots.len() + 1)?;
                    roots.push(RegisteredRoot {
                        tool: tool.into(),
                        client: tool.into(),
                        optional: false,
                        engine_path: legacy,
                        path: canonical,
                        expect: crate::local_sources::ResolvedExpect::Directory,
                        origin,
                    });
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(_) => return Err("OpenCode 日志目录状态无法检查".into()),
            }
        }
        _ => {}
    }
    Ok(roots)
}

/// Read at most limit + 1 bytes; callers reject the extra byte rather than parse truncation.
fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let checkpoint = || io_checkpoint().map_err(std::io::Error::other);
    checkpoint()?;
    let file = std::fs::File::open(path)?;
    let mut reader = file.take(limit.saturating_add(1));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        checkpoint()?;
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
    Ok(buffer)
}

/// 复评 N06：固定引擎在 `--home` 模式下**仍会读取**辅助配置文件。
///
/// 上游 `opencode_model_name` 会读 `.config/opencode/opencode.json`、
/// `.config/opencode/opencode.jsonc`、`.opencode/opencode.json`、
/// `.opencode/opencode.jsonc` 四个文件来解析模型显示名，且没有体积上限。
/// 应用只覆盖了 `.local/share/opencode` 扫描根 —— 这些辅助文件的父链/文件
/// 链接可以触达禁止目标，读取本身也不受限。
///
/// 这里在启动引擎前对四个文件逐个：先验链（不访问越界目标）、再有界读取
/// 并校验 JSON 形态。任一越界即拒绝该来源；不存在/超限/非法只作为「显示名
/// 不可用」的质量提示（不影响用量数据本身）。
fn audit_engine_aux_configs(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<Vec<&'static str>, String> {
    const AUX: &[&str] = &[
        ".config/opencode/opencode.json",
        ".config/opencode/opencode.jsonc",
        ".opencode/opencode.json",
        ".opencode/opencode.jsonc",
    ];
    let mut warnings = Vec::new();
    for relative in AUX {
        io_checkpoint()?;
        let path = home.join(relative);
        // 越界目标在访问前拒绝该来源。
        crate::local_sources::check_link_chain(&path, origin)
            .map_err(|error| format!("引擎辅助配置（{relative}）路径未通过检查：{error}"))?;
        match read_bounded(&path, 256 * 1024) {
            Ok(text) => {
                if text.len() > 256 * 1024 {
                    // 复评 T09：超限不能只警告 —— 固定引擎仍会 `read_to_string`
                    // 整份原文件（30 秒超时不限制峰值内存）。这里**拒绝该来源**，
                    // 因为宿主无法保证引擎读取是有界的。
                    return Err(format!("引擎辅助配置（{relative}）超过 256KiB，拒绝采集"));
                }
                // 复评 T09：上游支持 JSONC（含注释），宿主不能用 serde_json 的
                // 严格解析结果去判断「未采用」—— 只做形态提示，不误报。
                if text.contains(&b'\0') {
                    warnings.push("辅助配置含异常字节，显示名可能未采用");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => warnings.push("辅助配置不可读，显示名未采用"),
        }
    }
    Ok(warnings)
}

/// 复评 Q06/R03：引擎 settings 的 extraScanPaths 与 opencodeDbPaths（含
/// 备用配置文件）在采集时**直接生效**，事后的提示修不回已经发生的读取。
/// 启动引擎前解析所有配置文件，对每个扩展根执行与应用入口一致的校验：
/// 文本种类 → WSL 发行版运行状态 → 链接链（不访问越界目标）→ 解析后目标
/// → 目录根内文件链接审计。任一不合规立即拒绝该来源 —— 失败关闭。
///
/// 返回 `None` 表示主/备配置都不存在；`Some(roots)` 是全部通过校验、
/// 会被引擎实际读取的扩展根清单（供 F01 登记到覆盖索引）。
///
/// 复评 R01（P1）：必须传入来源**真实**的 `origin`。上一轮把配置检查硬编码为
/// `SourceOrigin::Native`，于是运行中的 WSL 主目录在配置存在性检查阶段就被
/// 判定「路径指向 WSL，未访问」而整类拒绝 —— 合法 WSL 来源全部失效。
/// 另外单工具来源执行时用的是隔离 home（`run_tool_source` 用独立 profile），
/// 用户工具根下的 settings 并不生效，不应据此阻断（复评 R06）。
/// 复评 N08：**同步**读取引擎配置与镜像声明，返回尚未做来源策略校验的根清单。
///
/// 旧实现把 `check_link_chain`、`read_bounded`、`read_dir` 都放在 async poll
/// 里，一次慢盘调用就能越过外层预算。这里把纯同步的发现/读取收进一个函数，
/// 由调用方通过 `run_bounded_io`（单许可 blocking worker）执行；随后再在
/// async 上下文里做需要查 WSL 状态的来源策略校验。
fn read_engine_config_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
    uses_user_settings: bool,
) -> Result<Option<Vec<RegisteredRoot>>, String> {
    // 复评 R06：单工具来源用隔离 home 执行引擎，用户 home 下的 settings 不参与。
    if !uses_user_settings {
        return Ok(None);
    }
    // Select by read_to_string semantics, including UTF-8 decoding, and keep
    // the bytes from that one bounded read. Invalid JSON is not a read failure.
    let primary = home.join("AppData/Roaming/tokscale/settings.json");
    let fallback = home.join("Library/Application Support/tokscale/settings.json");
    let settings = match read_settings_text(&primary, origin)? {
        Some(text) => Some(text),
        None => read_settings_text(&fallback, origin)?,
    };
    let mut roots: Vec<RegisteredRoot> = Vec::new();
    if let Some(text) = settings {
        for (tool, raw, directory) in engine_config_roots_from_text(&text)? {
            // 复评 R06：只登记实际启用且受支持的扩展根。
            if !READ_CLIENTS.contains(&tool.as_str()) {
                continue;
            }
            if roots.len() >= MAX_SCAN_ROOTS {
                return Err("引擎扩展根数量超过检查上限".into());
            }
            roots.push(RegisteredRoot {
                client: tool.clone(),
                tool,
                engine_path: std::path::PathBuf::from(&raw),
                path: std::path::PathBuf::from(&raw),
                expect: if directory {
                    crate::local_sources::ResolvedExpect::Directory
                } else {
                    crate::local_sources::ResolvedExpect::File
                },
                // 复评 N02：扩展根按**自身**路径文本决定 origin。
                origin: crate::local_sources::origin_for_path(&raw),
                optional: false,
            });
        }
    }
    // 复评 R02/N04：镜像根独立于 settings 存在性发现（含缺省/相对/~/ 语义）。
    roots.extend(read_cc_mirror_roots(home, origin)?);
    if roots.len() > MAX_SCAN_ROOTS {
        return Err("实际读取根超过检查上限".into());
    }
    Ok(if roots.is_empty() { None } else { Some(roots) })
}

async fn validate_engine_extra_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
    uses_user_settings: bool,
    wsl: &mut Option<Result<crate::local_sources::WslStatus, String>>,
    mut budget: AuditBudget,
) -> Result<Option<Vec<RegisteredRoot>>, String> {
    if !uses_user_settings {
        return Ok(None);
    }
    // 复评 N08：同步发现/读取走有界 IO 层（单许可 blocking worker）。
    let home_path = home.to_path_buf();
    let raw =
        run_bounded_io(move || read_engine_config_roots(&home_path, origin, uses_user_settings))
            .await
            .and_then(|value| value)?;
    let Some(roots) = raw else {
        return Ok(None);
    };
    // WSL status is the only asynchronous discovery here. No target metadata
    // is touched before its concrete distribution has been approved.
    for entry in &roots {
        let raw = entry.path.to_string_lossy();
        // Canonical home paths may carry Windows' extended prefix. Strip it
        // only for lexical policy checks; never rewrite what the engine reads.
        let policy_path = raw.replace(r"\\?\UNC\", r"\\");
        let policy_path = policy_path.strip_prefix(r"\\?\").unwrap_or(&policy_path);
        let (_, kind) = crate::local_sources::clean_tool_path(policy_path)?;
        if matches!(kind, crate::local_sources::HomeKind::Wsl { .. }) && wsl.is_none() {
            *wsl = Some(crate::local_sources::running_wsl().await);
        }
        source_gate(&kind, wsl)?;
    }
    run_bounded_io(move || {
        let mut validated = Vec::new();
        for mut entry in roots {
            io_checkpoint()?;
            if let Some(canonical) = validate_engine_root(&entry, &mut budget)? {
                if entry.tool == "openclaw"
                    && entry.expect == crate::local_sources::ResolvedExpect::Directory
                {
                    validated.extend(audit_special_databases(
                        &entry.path,
                        "openclaw",
                        false,
                        entry.origin,
                        &mut budget,
                    )?);
                }
                check_plan_size(validated.len() + 1)?;
                entry.path = canonical;
                validated.push(entry);
            }
        }
        Ok(Some(validated))
    })
    .await?
}

const MAX_SCAN_ROOTS: usize = 256;
fn check_plan_size(count: usize) -> Result<(), String> {
    if count > MAX_SCAN_ROOTS {
        Err("实际读取根超过 256 项安全上限，已拒绝该来源".into())
    } else {
        Ok(())
    }
}
fn push_plan_root(roots: &mut Vec<RegisteredRoot>, root: RegisteredRoot) -> Result<(), String> {
    check_plan_size(roots.len() + 1)?;
    roots.push(root);
    Ok(())
}
fn read_settings_text(
    path: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<Option<String>, String> {
    io_checkpoint()?;
    crate::local_sources::check_link_chain(path, origin)?;
    match read_bounded(path, 256 * 1024) {
        Ok(bytes) => {
            if bytes.len() > 256 * 1024 {
                return Err("采集引擎 settings.json 超过 256KiB，拒绝采集".into());
            }
            Ok(String::from_utf8(bytes).ok())
        }
        Err(_) => Ok(None),
    }
}

/// A declared root which passed preflight. This is not evidence that the
/// executable adopted it or that its parser successfully read it.
#[derive(Debug, Clone)]
pub(crate) struct RegisteredRoot {
    pub tool: String,
    pub client: String,
    pub optional: bool,
    /// Exact spelling passed by the scanner, retained because Claude derives
    /// parent/variant paths from ancestry before canonicalization.
    pub engine_path: std::path::PathBuf,
    pub path: std::path::PathBuf,
    pub expect: crate::local_sources::ResolvedExpect,
    /// 复评 N02：根**自身**的 origin。旧实现登记时用外层 home 的 origin
    /// 重算解析结果 —— Native home 里的合法 WSL 扩展根会因此漏登记
    ///（随后被显式的 WSL 工具源再读一次，静默双计）。
    pub origin: crate::local_sources::SourceOrigin,
}

impl RegisteredRoot {
    fn scan_root(&self) -> crate::local_overlap::ScanRoot {
        crate::local_overlap::ScanRoot {
            parser: self.tool.clone(),
            client: self.client.clone(),
            identity: crate::local_sources::home_key(&self.path.to_string_lossy()),
            kind: match self.expect {
                crate::local_sources::ResolvedExpect::Directory => {
                    crate::local_overlap::LayoutKind::Directory
                }
                crate::local_sources::ResolvedExpect::File => {
                    crate::local_overlap::LayoutKind::File
                }
            },
        }
    }
}

/// 复评 F01/N04/N08：**同步**读取 `.cc-mirror/*/variant.json` 的根声明。
///
/// 只做发现与解析（含缺省/相对/`~/` 语义），返回尚未做来源策略校验的精确
/// `projects` 根；调用方经 `run_bounded_io`（单许可 blocking worker）执行，
/// 随后在 async 上下文里做需要查 WSL 状态的策略校验。
fn read_cc_mirror_roots(
    home: &Path,
    origin: crate::local_sources::SourceOrigin,
) -> Result<Vec<RegisteredRoot>, String> {
    let mirror = home.join(crate::local_overlap::CC_MIRROR_DIR);
    // 复评 R02：镜像容器本身也先验链（不跟随），越界即拒绝该来源。
    crate::local_sources::check_link_chain(&mirror, origin)
        .map_err(|error| format!("cc-mirror 目录路径未通过检查：{error}"))?;
    let entries = match std::fs::read_dir(&mirror) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("cc-mirror 目录枚举失败，已拒绝该来源".into()),
    };
    let mut roots = Vec::new();
    let mut total_bytes = 0usize;
    for (index, entry) in entries.enumerate() {
        io_checkpoint()?;
        if index >= MAX_SCAN_ROOTS {
            return Err("cc-mirror 目录项超过检查上限".into());
        }
        let entry = entry.map_err(|_| "cc-mirror 目录项枚举失败")?;
        crate::local_sources::check_link_chain(&entry.path(), origin)?;
        let metadata = std::fs::metadata(entry.path()).map_err(|_| "cc-mirror 目录项无法读取")?;
        if !metadata.is_dir() {
            continue;
        }
        let variant = entry.path().join("variant.json");
        crate::local_sources::check_link_chain(&variant, origin).map_err(|error| {
            format!(
                "cc-mirror 配置（{}）路径未通过检查：{error}",
                variant.display()
            )
        })?;
        // 复评 R02：超限 variant 不能截断后忽略（上游仍可能整份读取）。
        let text = match read_bounded(&variant, 256 * 1024) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(format!(
                    "cc-mirror 配置（{}）无法读取，拒绝采集",
                    variant.display()
                ));
            }
        };
        if text.len() > 256 * 1024 {
            return Err(format!(
                "cc-mirror 配置（{}）超过 256KiB，拒绝采集",
                variant.display()
            ));
        }
        total_bytes += text.len();
        if total_bytes > 4 * 1024 * 1024 {
            return Err("cc-mirror 配置总量超过 4MiB".into());
        }
        let text = std::str::from_utf8(&text).map_err(|_| "cc-mirror 配置不是 UTF-8")?;
        let config_root = crate::local_overlap::cc_mirror_resolve_root(text, &entry.path(), home)?;
        let projects = config_root.join("projects");
        roots.push(RegisteredRoot {
            tool: "claude".to_string(),
            client: format!(
                "claude-mirror:{}",
                crate::local_sources::home_key(&entry.path().to_string_lossy())
            ),
            optional: true,
            engine_path: projects.clone(),
            path: projects.clone(),
            expect: crate::local_sources::ResolvedExpect::Directory,
            origin: crate::local_sources::origin_for_path(&projects.to_string_lossy()),
        });
    }
    Ok(roots)
}

/// Typed acceptance contract from the pinned d5e8ad9b Settings and nested
/// structs. Do not deserialize to Value first: that discards duplicate keys.
/// All known non-scanner fields still participate in validation because any
/// typed failure makes the executable replace the *whole* Settings by defaults.
/// Unknown fields and the upstream lossy fields intentionally remain accepted.
/// Upstream normalize only clamps UI/autosubmit timings; it does not alter roots.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[allow(dead_code)] // These fields validate the complete upstream contract.
struct PinnedEngineSettings {
    color_palette: String,
    auto_refresh_enabled: bool,
    auto_refresh_ms: u64,
    include_unused_models: bool,
    native_timeout_ms: u64,
    scanner: PinnedScannerSettings,
    #[serde(deserialize_with = "pinned_lossy_string_array")]
    default_clients: Vec<String>,
    light: PinnedLightSettings,
    usage: PinnedUsageSettings,
    minutely_tab_enabled: bool,
    autosubmit: PinnedAutosubmitSettings,
    model_aliases: Value,
    tui_light_mode: bool,
    tui_language: Value,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[allow(dead_code)]
struct PinnedScannerSettings {
    opencode_db_paths: Vec<String>,
    extra_scan_paths: BTreeMap<String, Vec<String>>,
    bucket_timezone: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[allow(dead_code)]
struct PinnedLightSettings {
    write_cache: bool,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[allow(dead_code)]
struct PinnedUsageSettings {
    // Upstream drops non-string members, but rejects a non-array field.
    disabled_providers: Vec<Value>,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[allow(dead_code)]
struct PinnedAutosubmitSettings {
    enabled: bool,
    interval_minutes: u64,
    #[serde(deserialize_with = "pinned_lossy_string_array")]
    clients: Vec<String>,
    since: Option<String>,
    until: Option<String>,
    year: Option<String>,
    today: bool,
    yesterday: bool,
    week: bool,
    month: bool,
    scheduler: Option<String>,
    managed_executable: Option<String>,
    managed_executable_version: Option<String>,
    last_run_at_ms: Option<i64>,
    last_error: Option<String>,
}

// Preserve the fixed implementation, including error consumption, rather than
// replacing a lossy Vec deserializer by a more permissive generic Value.
fn pinned_lossy_string_array<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<Vec<Value>> = Option::deserialize(deserializer).ok().flatten();
    Ok(value
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect())
}

fn engine_config_roots_from_text(text: &str) -> Result<Vec<(String, String, bool)>, String> {
    let settings: PinnedEngineSettings = serde_json::from_str(text).map_err(|_| {
        "引擎 settings.json 的类型或重复字段与固定版本不兼容，已拒绝该主目录；单工具来源仍可独立采集".to_string()
    })?;
    let mut roots = Vec::new();
    for (tool, paths) in settings.scanner.extra_scan_paths {
        // Match ClientId::from_str and extra_scan_paths_for: exact lowercase
        // client IDs; an empty path is ignored, not a successful read root.
        if !READ_CLIENTS.contains(&tool.as_str()) {
            continue;
        }
        roots.extend(
            paths
                .into_iter()
                .filter(|path| !path.is_empty())
                .map(|path| (tool.clone(), path, true)),
        );
    }
    for path in settings.scanner.opencode_db_paths {
        // The engine receives the original configured spelling here, unlike
        // run_tool_source, which passes a canonical path. Invalid names cannot
        // be registered as evidence for a database the engine silently skips.
        let name = path.rsplit(['\\', '/']).next().unwrap_or("");
        if !is_opencode_database_name(name) {
            return Err(
                "引擎 settings.json 的OpenCode数据库文件名不受固定版本支持，已拒绝该主目录".into(),
            );
        }
        roots.push(("opencode".into(), path, false));
    }
    Ok(roots)
}

#[cfg(test)]
fn engine_config_roots(value: &Value) -> Result<Vec<(String, String, bool)>, String> {
    engine_config_roots_from_text(&value.to_string())
}

const CLAUDE_AUDIT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const CLAUDE_AUDIT_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const CLAUDE_AUDIT_METADATA_BYTES: u64 = 256 * 1024;

#[derive(Default)]
struct ClaudeDependencyBudget {
    entries: usize,
    bytes: u64,
    metadata: std::collections::BTreeSet<std::path::PathBuf>,
}

impl ClaudeDependencyBudget {
    fn entry(&mut self) -> Result<(), String> {
        io_checkpoint()?;
        self.entries += 1;
        if self.entries > REPARSE_AUDIT_MAX_ENTRIES {
            return Err("Claude依赖条目累计超过安全上限，未启动该来源采集".into());
        }
        Ok(())
    }
}

/// Pure lexical gate, before any candidate exists/metadata/open operation.
/// Appending `.jsonl` does not make drive/UNC/ADS or reserved device names safe.
fn safe_claude_parent_id(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 200
        || value == "."
        || value == ".."
        || value.ends_with('.')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return false;
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix)
                .is_some_and(|tail| tail.len() == 1 && matches!(tail.as_bytes()[0], b'1'..=b'9'))
        })
}

/// Same candidate order as d5e8ad9b parent_session_paths, without filesystem IO.
fn claude_parent_candidates(
    path: &Path,
    session_id: &str,
) -> Result<Vec<std::path::PathBuf>, String> {
    if !safe_claude_parent_id(session_id) {
        return Err("Claude记录含不安全的父会话标识，未访问派生路径并拒绝该来源".into());
    }
    let filename = format!("{session_id}.jsonl");
    let mut candidates = Vec::new();
    for ancestor in path.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("subagents") {
            if let Some(project) = ancestor.parent().and_then(Path::parent) {
                candidates.push(project.join(&filename));
            }
            break;
        }
    }
    if let Some(parent) = path.parent() {
        let candidate = parent.join(filename);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

/// The default mirror layout may be outside home, including when an extra root
/// starts below `projects`. Match the engine's ancestry rule, not a root label.
fn claude_variant_dependency(path: &Path) -> Option<std::path::PathBuf> {
    for ancestor in path.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) != Some("config")
            || !path.starts_with(ancestor.join("projects"))
        {
            continue;
        }
        let variant = ancestor.parent()?;
        if variant
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(".cc-mirror")
        {
            return Some(variant.join("variant.json"));
        }
    }
    None
}

fn read_claude_dependency(
    path: &Path,
    origin: crate::local_sources::SourceOrigin,
    limit: u64,
    optional: bool,
    budget: &mut ClaudeDependencyBudget,
) -> Result<Option<Vec<u8>>, String> {
    budget.entry()?;
    // Full ancestry/link policy precedes metadata and bounded content reads.
    crate::local_sources::check_link_chain(path, origin)?;
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Err("Claude依赖不是普通文件，已拒绝该来源".into()),
        Err(error)
            if optional
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err("Claude依赖无法完整检查，已拒绝该来源".into()),
    };
    let remaining = CLAUDE_AUDIT_TOTAL_BYTES.saturating_sub(budget.bytes);
    if metadata.len() > limit || metadata.len() > remaining {
        return Err("Claude依赖超过单文件或累计读取预算，未启动该来源采集".into());
    }
    let bytes =
        read_bounded(path, limit.min(remaining)).map_err(|_| "Claude依赖读取失败，已拒绝该来源")?;
    budget.bytes = budget.bytes.saturating_add(bytes.len() as u64);
    if bytes.len() as u64 > limit || budget.bytes > CLAUDE_AUDIT_TOTAL_BYTES {
        return Err("Claude依赖在读取时超过预算，已拒绝该来源".into());
    }
    Ok(Some(bytes))
}

fn audit_claude_metadata(
    path: &Path,
    origin: crate::local_sources::SourceOrigin,
    budget: &mut ClaudeDependencyBudget,
) -> Result<(), String> {
    if budget.metadata.insert(path.to_path_buf()) {
        // Invalid/missing metadata affects attribution, not the read boundary.
        // It still must be checked and bounded even when a usable meta sidecar
        // would prevent the hot parser's parent fallback: the cache probes it.
        read_claude_dependency(path, origin, CLAUDE_AUDIT_METADATA_BYTES, true, budget)?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct ClaudeDependencyEntry {
    #[serde(rename = "isSidechain", default)]
    is_sidechain: Value,
    #[serde(rename = "sessionId", default)]
    session_id: Value,
}

/// Transitional preflight for both parser and source-cache dependencies.
/// This is NOT an IO sandbox: the fixed executable later reopens the originals.
/// TOCTOU, cached parent paths and historical cache-key probes still require
/// an engine-side fix; the old cache is preserved for compacted history.
fn audit_claude_dependencies(plan: &[RegisteredRoot]) -> Result<(), String> {
    let mut budget = ClaudeDependencyBudget::default();
    for root in plan.iter().filter(|root| root.tool == "claude") {
        let mut root_aliases =
            crate::local_sources::checked_root_aliases(&root.engine_path, root.origin)?;
        let resolved =
            std::fs::canonicalize(&root.engine_path).map_err(|_| "Claude日志根身份无法复核")?;
        if crate::local_sources::home_key(&resolved.to_string_lossy())
            != crate::local_sources::home_key(&root.path.to_string_lossy())
        {
            return Err("Claude日志根在检查期间发生变化，请重试".into());
        }
        root_aliases.push(root.path.clone());
        let approved_roots: Vec<&Path> = root_aliases
            .iter()
            .map(std::path::PathBuf::as_path)
            .collect();
        let mut directories = vec![root.engine_path.clone()];
        while let Some(directory) = directories.pop() {
            budget.entry()?;
            crate::local_sources::check_link_chain(&directory, root.origin)?;
            let entries = std::fs::read_dir(&directory)
                .map_err(|_| "Claude目录无法完整检查，已拒绝该来源")?;
            for entry in entries {
                budget.entry()?;
                let path = entry.map_err(|_| "Claude目录项无法检查")?.path();
                let meta =
                    std::fs::symlink_metadata(&path).map_err(|_| "Claude目录项状态无法检查")?;
                if crate::local_sources::is_reparse_entry(&meta) {
                    // WalkDir never descends into directory links, but may
                    // probe them. The ordinary audit has already validated it.
                    if !is_dir_link(&meta) {
                        return Err("Claude目录内含文件链接，已拒绝该来源".into());
                    }
                    crate::local_sources::check_link_chain(&path, root.origin)?;
                    continue;
                }
                if meta.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !meta.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                {
                    continue;
                }
                let bytes = read_claude_dependency(
                    &path,
                    root.origin,
                    CLAUDE_AUDIT_FILE_BYTES,
                    false,
                    &mut budget,
                )?
                .ok_or("Claude日志在检查时消失")?;
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| "Claude日志不是完整UTF-8，已拒绝该来源")?;
                if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                    audit_claude_metadata(
                        &path.with_file_name(format!("{stem}.meta.json")),
                        root.origin,
                        &mut budget,
                    )?;
                }
                if let Some(variant) = claude_variant_dependency(&path) {
                    // This grants the exact inferred variant file only, never
                    // its containing tree. It covers explicit/extra roots too.
                    audit_claude_metadata(&variant, root.origin, &mut budget)?;
                }
                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                    io_checkpoint()?;
                    // Be conservative about parser differences and duplicate
                    // fields. Incomplete active writes must be retried, not
                    // labeled as fully checked based on a partial prefix.
                    let entry: ClaudeDependencyEntry = serde_json::from_str(line)
                        .map_err(|_| "Claude日志含未完整或歧义JSON行，请等待写入完成后重试")?;
                    if entry.is_sidechain != Value::Bool(true) || entry.session_id.is_null() {
                        continue;
                    }
                    let session = entry
                        .session_id
                        .as_str()
                        .ok_or("Claude父会话标识类型不兼容，已拒绝该来源")?;
                    // Audit every sidechain line, including late lines seen by
                    // parent_session_paths_for_cache after a normal first row.
                    for parent in claude_parent_candidates(&path, session)? {
                        if !parent.starts_with(&root.engine_path) {
                            return Err("Claude父会话候选超出已批准日志根，未访问该候选".into());
                        }
                        crate::local_sources::check_link_chain_within(
                            &parent,
                            root.origin,
                            &approved_roots,
                        )?;
                        if let Ok(canonical) = std::fs::canonicalize(&parent) {
                            if !crate::local_overlap::key_within(
                                &crate::local_sources::home_key(&root.path.to_string_lossy()),
                                &crate::local_sources::home_key(&canonical.to_string_lossy()),
                            ) {
                                return Err(
                                    "Claude父会话候选的规范目标超出日志根，已拒绝该来源".into()
                                );
                            }
                        }
                        // Parser reads the parent in full and cache fingerprints
                        // all candidates, including a lower-priority candidate.
                        if budget.metadata.insert(parent.clone()) {
                            read_claude_dependency(
                                &parent,
                                root.origin,
                                CLAUDE_AUDIT_FILE_BYTES,
                                true,
                                &mut budget,
                            )?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// 校验一个引擎配置声明的根（复评 R03/R06）。
/// 目录根做文件链接审计；预审不完整=未验证，失败关闭，不计入「已校验」。
fn validate_engine_root(
    entry: &RegisteredRoot,
    budget: &mut AuditBudget,
) -> Result<Option<std::path::PathBuf>, String> {
    io_checkpoint()?;
    crate::local_sources::check_link_chain(&entry.path, entry.origin)?;
    if entry.optional {
        match std::fs::metadata(&entry.path) {
            Ok(meta) if !meta.is_dir() => return Ok(None),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(None)
            }
            Err(_) => return Err("镜像 projects 状态无法检查，已拒绝该来源".into()),
        }
    }
    let canonical =
        crate::local_sources::resolve_layout_root(&entry.path, entry.origin, entry.expect)?;
    if entry.expect == crate::local_sources::ResolvedExpect::Directory {
        require_complete_audit(audit_root_for_reparse_budgeted(
            &canonical,
            entry.origin,
            budget,
        )?)?;
    } else {
        audit_database_sidecars(&entry.path, entry.origin)?;
        audit_database_sidecars(&canonical, entry.origin)?;
    }
    Ok(Some(canonical))
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
    if entry.tool == "opencode" {
        require_opencode_database_name(resolved)?;
    }
    // --home loads scanner settings from this app-owned empty home. Never write
    // settings into the user's tool root or copy a live SQLite/WAL database.
    let home = profile.join("scan-home");
    let config = home.join("AppData/Roaming/tokscale");
    let settings = if entry.tool == "opencode" {
        serde_json::json!({"scanner":{"opencodeDbPaths":[target]}})
    } else {
        let mut paths = serde_json::Map::new();
        paths.insert(entry.tool.clone(), serde_json::json!([target]));
        serde_json::json!({"scanner":{"extraScanPaths": paths}})
    };
    let encoded = serde_json::to_vec(&settings).map_err(|_| "采集路径设置无法编码")?;
    run_bounded_io(move || -> Result<(), String> {
        io_checkpoint()?;
        std::fs::create_dir_all(&config).map_err(|_| "指定路径的采集设置无法保存")?;
        let temporary = config.join(format!("settings.{}.tmp", std::process::id()));
        io_checkpoint()?;
        std::fs::write(&temporary, encoded).map_err(|_| "指定路径的采集设置无法保存")?;
        io_checkpoint()?;
        std::fs::rename(temporary, config.join("settings.json"))
            .map_err(|_| "指定路径的采集设置无法提交")?;
        Ok(())
    })
    .await??;
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
    let engine_path = path.to_path_buf();
    run_bounded_io(move || verify_engine(&engine_path)).await??;
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
        // Preserve cached history needed by compacted Claude transcripts.
        // The fixed engine can still probe historical cached dependency paths;
        // host preflight alone does not close that cache-side boundary.
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
    let mut child =
        crate::commands::CollectionChild::new(command.spawn().map_err(|_| "无法启动本地采集引擎")?);
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
    pub inner: Arc<Mutex<LocalState>>,
}
#[derive(Default)]
pub struct LocalState {
    pub enabled: Option<bool>,
    pub background_enabled: Option<bool>,
    /// Runtime stop is effective even if its persistence has not succeeded yet.
    pub stop_save_pending: bool,
    pub background_stop_save_pending: bool,
    /// Exit is monotonic for this process; a late enable worker cannot reopen it.
    pub shutting_down: bool,
    pub generation: u64,
    pub busy: bool,
    /// A settings/retention mutation owns this until its blocking work really exits.
    pub settings_busy: bool,
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

    /// 复评 N19：Unix 上 `is_dir_link` 恒为 false（保守策略：无法不跟随地区分
    /// 目录链接，一律按文件链接拒绝）。旧测试却断言 Clean —— 与实现矛盾。
    /// 这里让断言匹配**保守拒绝**语义，并在链接创建失败时明确 NOT RUN。
    #[cfg(unix)]
    #[test]
    fn n19_unix目录链接按保守策略拒绝() {
        let base = std::env::temp_dir().join(format!("dsm-audit-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real-dir")).unwrap();
        std::fs::write(base.join("real.log"), b"x").unwrap();
        let dir_link = base.join("dir-link");
        match std::os::unix::fs::symlink(base.join("real-dir"), &dir_link) {
            Ok(()) => {
                assert!(
                    audit_root_for_reparse(&base).is_err(),
                    "Unix 上目录链接按保守策略拒绝（无法不跟随地区分类型）"
                );
                std::fs::remove_file(&dir_link).ok();
            }
            Err(error) => panic!("NOT RUN：无法创建目录符号链接（{error}）"),
        }
        let file_link = base.join("file-link.log");
        match std::os::unix::fs::symlink(base.join("real.log"), &file_link) {
            Ok(()) => {
                assert!(audit_root_for_reparse(&base).is_err(), "文件链接必须拒绝");
                std::fs::remove_file(&file_link).ok();
            }
            Err(error) => panic!("NOT RUN：无法创建文件符号链接（{error}）"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---------- 第八轮复评 R01：WSL 来源不能被配置检查拒绝 ----------

    /// 复评 R01（P1）：配置路径检查必须用来源**真实** origin。
    ///
    /// 上一轮把它硬编码为 `SourceOrigin::Native`，运行中的 WSL 主目录在配置
    /// 存在性检查阶段就被判「路径指向 WSL」而整类拒绝。这里在**文本层面**
    /// 锁定 origin 语义（不触发真实 WSL IO —— 本机 `\\wsl.localhost` 实测
    /// 会因发行版未运行而超时，真实采集由 `source_gate` 先确认运行状态）。
    #[test]
    fn r01_配置检查使用来源真实origin_而非硬编码native() {
        let wsl_path = r"\\wsl.localhost\Ubuntu\home\user\AppData\Roaming\tokscale\settings.json";
        // WSL 入口：目标是 WSL 不算越界（这正是 R01 回归的根因）。
        assert!(
            crate::local_sources::reject_link_target(
                wsl_path,
                crate::local_sources::SourceOrigin::Wsl
            )
            .is_ok(),
            "WSL 来源检查 WSL 路径时不得被拒绝（上一轮硬编码 Native 导致整类失效）"
        );
        // 同一路径按本地入口语义必须被拒绝（边界没有因为放宽而丢失）。
        assert!(
            crate::local_sources::reject_link_target(
                wsl_path,
                crate::local_sources::SourceOrigin::Native
            )
            .is_err(),
            "本地入口指向 WSL 仍必须拒绝"
        );
        // 网络共享对两种入口都拒绝（WSL 入口也不例外）。
        let unc = r"\\server\share\logs";
        for origin in [
            crate::local_sources::SourceOrigin::Native,
            crate::local_sources::SourceOrigin::Wsl,
        ] {
            assert!(
                crate::local_sources::reject_link_target(unc, origin).is_err(),
                "网络共享必须对所有入口拒绝"
            );
        }
    }

    /// 复评 R06：单工具来源用隔离 home 执行，不检查用户 settings。
    #[tokio::test]
    async fn r06_单工具来源不检查用户配置() {
        let mut wsl = None;
        let home = std::path::Path::new(r"D:\U");
        let outcome = validate_engine_extra_roots(
            home,
            crate::local_sources::SourceOrigin::Native,
            false,
            &mut wsl,
            AuditBudget::default(),
        )
        .await;
        assert!(
            outcome.unwrap().is_none(),
            "uses_user_settings=false 时不读取/登记用户配置"
        );
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
            // 复评 T14：junction 由普通用户即可创建（`mklink /J` 不需要
            // SeCreateSymbolicLinkPrivilege）。这里创建失败说明环境异常，
            // 必须让测试 **FAIL** —— 旧实现只 eprintln! 就正常返回，
            // libtest 记 PASS，门禁会把「没跑」当成「通过」。
            panic!("junction 创建失败：环境异常，链接场景未验证");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 复评 T14：**符号链接能力探针**。`symlink_dir`/`symlink_file` 需要
    /// SeCreateSymbolicLinkPrivilege（或开发者模式）。这里把「是否具备能力」
    /// 与「链接场景是否通过」拆开：不具备能力时本测试标记为 ignored 语义
    /// 的显式跳过（打印机器可读的 `NOT RUN:` 前缀），具备能力时必须真实断言。
    ///
    /// 发行门禁（release-record）会统计 `NOT RUN:` 行并阻断，不再把它当 PASS。
    #[cfg(windows)]
    #[test]
    fn t14_符号链接场景按能力显式执行() {
        let base = std::env::temp_dir().join(format!("dsm-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("real-dir")).unwrap();
        std::fs::write(base.join("real.log"), b"x").unwrap();

        let dir_link = base.join("dir-link");
        match std::os::windows::fs::symlink_dir(base.join("real-dir"), &dir_link) {
            Ok(()) => {
                assert!(
                    matches!(audit_root_for_reparse(&base), Ok(ReparseAudit::Clean)),
                    "目录符号链接：引擎的通用遍历不跟随，不得拒绝整个来源"
                );
                std::fs::remove_dir(&dir_link).ok();
            }
            Err(error) if error.raw_os_error() == Some(1314) => {
                // ERROR_PRIVILEGE_NOT_HELD：能力缺失，明确 NOT RUN。
                panic!("NOT RUN: 缺少创建符号链接权限，目录链接场景未执行");
            }
            Err(error) => panic!("目录符号链接创建异常：{error}"),
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
            Err(error) if error.raw_os_error() == Some(1314) => {
                panic!("NOT RUN: 缺少创建符号链接权限，文件链接场景未执行");
            }
            Err(error) => panic!("文件符号链接创建异常：{error}"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn r03_settings解析覆盖两个字段与目录文件语义() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"scanner":{
                "extraScanPaths":{"claude":["D:\\Logs\\Claude"],"dsh":["D:\\Logs\\Dsh"]},
                "opencodeDbPaths":["D:\\Db\\opencode.db","D:\\Db\\opencode-stable.db"]
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

    // Round-12 regressions are written for the user's local test run. These
    // source-level cases are not evidence that the fixed EXE was exercised.
    #[test]
    fn r12_settings完整typed合同拒绝假覆盖但保留lossy字段() {
        for invalid in [
            r#"{"autoRefreshMs":"oops","scanner":{"extraScanPaths":{"claude":["D:\\Shared"]}}}"#,
            r#"{"colorPalette":0}"#,
            r#"{"autoRefreshEnabled":1}"#,
            r#"{"includeUnusedModels":null}"#,
            r#"{"nativeTimeoutMs":-1}"#,
            r#"{"scanner":{"bucketTimezone":3}}"#,
            r#"{"light":{"writeCache":"yes"}}"#,
            r#"{"usage":{"disabledProviders":null}}"#,
            r#"{"autosubmit":{"since":5}}"#,
            r#"{"autosubmit":{"lastRunAtMs":1.5}}"#,
            r#"{"minutelyTabEnabled":[]}"#,
            r#"{"tuiLightMode":{}}"#,
            r#"{"scanner":{},"scanner":{"extraScanPaths":{"claude":["D:\\Shared"]}}}"#,
            r#"{"autoRefreshMs":30000,"autoRefreshMs":60000}"#,
            r#"{"scanner":{"opencodeDbPaths":[],"opencodeDbPaths":[]}}"#,
            r#"{"light":{"writeCache":false,"writeCache":true}}"#,
            r#"{"scanner":{"opencodeDbPaths":["D:\\Db\\actual.sqlite"]}}"#,
        ] {
            assert!(engine_config_roots_from_text(invalid).is_err(), "{invalid}");
        }
        let valid = r#"{
            "defaultClients":["claude",1,null],
            "autosubmit":{"clients":[false,"opencode"],"intervalMinutes":0},
            "usage":{"disabledProviders":["x",0,null]},
            "modelAliases":42,"tuiLanguage":{"unknown":true},
            "unknownFutureField":{"arbitrary":[1,2]},
            "autoRefreshMs":0,"nativeTimeoutMs":18446744073709551615,
            "scanner":{"extraScanPaths":{"claude":["", "D:\\Shared"],"Claude":["D:\\Ignored"]}}
        }"#;
        let roots = engine_config_roots_from_text(valid).unwrap();
        assert_eq!(roots, vec![("claude".into(), r"D:\Shared".into(), true)]);
    }

    #[test]
    fn r12_opencode检查实际执行basename而非入口链接名称() {
        for valid in ["opencode.db", "opencode-stable.db", "opencode-test_1.2.db"] {
            assert!(require_opencode_database_name(Path::new(valid)).is_ok());
        }
        for invalid in [
            "actual.db",
            "actual.sqlite",
            "opencode-.db",
            "OPENCODE.db",
            "opencode.db-wal",
        ] {
            assert!(require_opencode_database_name(Path::new(invalid)).is_err());
        }
    }

    #[test]
    fn r12_claude父标识在任何派生访问前拒绝不安全文本() {
        for unsafe_id in [
            "",
            ".",
            "..",
            "../outside",
            r"..\outside",
            r"D:\Outside\sentinel",
            r"\outside",
            r"\\server\share\sentinel",
            r"\\wsl.localhost\Other\sentinel",
            r"\\?\GLOBALROOT\Device\x",
            "a:b",
            "CON",
            "con.txt",
            "LPT1",
            "COM9.log",
            "id.",
            "id ",
        ] {
            assert!(
                claude_parent_candidates(Path::new("unused/agent-a.jsonl"), unsafe_id).is_err(),
                "{unsafe_id}"
            );
        }
        for safe in ["11111111-2222-3333-4444-555555555555", "parent_1", "name.2"] {
            assert!(safe_claude_parent_id(safe));
        }
        let nested = Path::new("projects/p/s/subagents/workflows/w/agent-a.jsonl");
        assert_eq!(
            claude_parent_candidates(nested, "s").unwrap(),
            vec![
                Path::new("projects/p/s.jsonl").to_path_buf(),
                Path::new("projects/p/s/subagents/workflows/w/s.jsonl").to_path_buf(),
            ]
        );
    }

    fn claude_test_root(engine_path: &Path) -> RegisteredRoot {
        RegisteredRoot {
            tool: "claude".into(),
            client: "claude".into(),
            optional: false,
            engine_path: engine_path.to_path_buf(),
            path: std::fs::canonicalize(engine_path).unwrap(),
            expect: crate::local_sources::ResolvedExpect::Directory,
            origin: crate::local_sources::SourceOrigin::Native,
        }
    }

    #[test]
    fn r12_claude迟到sidechain与有效meta仍必须检查cache父候选() {
        let root = round11_fixture("claude-late-parent");
        std::fs::write(root.join("agent-a.meta.json"), br#"{"agentType":"valid"}"#).unwrap();
        std::fs::write(root.join("agent-a.jsonl"), concat!(
            "{\"type\":\"user\"}\n",
            "{\"type\":\"user\",\"isSidechain\":true,\"sessionId\":\"../outside\",\"agentId\":\"a\"}\n"
        )).unwrap();
        assert!(audit_claude_dependencies(&[claude_test_root(&root)])
            .unwrap_err()
            .contains("不安全"));
        std::fs::write(
            root.join("agent-a.jsonl"),
            br#"{"type":"user","isSidechain":true,"sessionId":"safe-parent"}"#,
        )
        .unwrap();
        assert!(audit_claude_dependencies(&[claude_test_root(&root)]).is_ok());
        std::fs::write(
            root.join("agent-a.jsonl"),
            br#"{"sessionId":"safe","sessionId":"../bad","isSidechain":true}"#,
        )
        .unwrap();
        assert!(audit_claude_dependencies(&[claude_test_root(&root)]).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn r12_claude正常nested和deep保持且窄根不得隐式批准树外父日志() {
        let base = round11_fixture("claude-nested");
        let projects = base.join("projects");
        let subagents = projects.join("p/s/subagents");
        std::fs::create_dir_all(subagents.join("workflows/w")).unwrap();
        std::fs::write(projects.join("p/s.jsonl"), b"{}").unwrap();
        for file in [
            subagents.join("agent-a.jsonl"),
            subagents.join("workflows/w/agent-b.jsonl"),
        ] {
            std::fs::write(
                file,
                br#"{"type":"user","isSidechain":true,"sessionId":"s"}"#,
            )
            .unwrap();
        }
        assert!(audit_claude_dependencies(&[claude_test_root(&projects)]).is_ok());
        assert!(audit_claude_dependencies(&[claude_test_root(&subagents)])
            .unwrap_err()
            .contains("超出"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn r12_claude树外variant与meta有界且缺失坏json不扩大依赖树() {
        let base = round11_fixture("claude-external-variant");
        let variant = base.join(".cc-mirror/v");
        let projects = variant.join("config/projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("normal.jsonl"), b"{}").unwrap();
        let plan = vec![claude_test_root(&projects)];
        assert!(audit_claude_dependencies(&plan).is_ok());
        std::fs::write(variant.join("variant.json"), b"{invalid").unwrap();
        assert!(audit_claude_dependencies(&plan).is_ok());
        std::fs::File::create(variant.join("variant.json"))
            .unwrap()
            .set_len(CLAUDE_AUDIT_METADATA_BYTES + 1)
            .unwrap();
        assert!(audit_claude_dependencies(&plan)
            .unwrap_err()
            .contains("预算"));
        std::fs::write(variant.join("variant.json"), b"{}").unwrap();
        std::fs::File::create(projects.join("normal.meta.json"))
            .unwrap()
            .set_len(CLAUDE_AUDIT_METADATA_BYTES + 1)
            .unwrap();
        assert!(audit_claude_dependencies(&plan)
            .unwrap_err()
            .contains("预算"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn r12_claude超预算和不完整日志明确拒源不当成功空() {
        let root = round11_fixture("claude-budget");
        let log = root.join("normal.jsonl");
        std::fs::write(&log, b"{\"type\":").unwrap();
        assert!(audit_claude_dependencies(&[claude_test_root(&root)]).is_err());
        std::fs::write(&log, b"{}").unwrap();
        let mut budget = ClaudeDependencyBudget {
            bytes: CLAUDE_AUDIT_TOTAL_BYTES - 1,
            ..Default::default()
        };
        assert!(read_claude_dependency(
            &log,
            crate::local_sources::SourceOrigin::Native,
            CLAUDE_AUDIT_FILE_BYTES,
            false,
            &mut budget
        )
        .is_err());
        std::fs::File::create(&log)
            .unwrap()
            .set_len(CLAUDE_AUDIT_FILE_BYTES + 1)
            .unwrap();
        assert!(audit_claude_dependencies(&[claude_test_root(&root)]).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn r12_claude原始junction拼写仍检查树外variant() {
        let base = round11_fixture("claude-variant-junction");
        let variant = base.join(".cc-mirror/v");
        let actual = base.join("actual");
        let selected = variant.join("config/projects");
        std::fs::create_dir_all(selected.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&actual).unwrap();
        std::fs::write(actual.join("normal.jsonl"), b"{}").unwrap();
        std::fs::File::create(variant.join("variant.json"))
            .unwrap()
            .set_len(CLAUDE_AUDIT_METADATA_BYTES + 1)
            .unwrap();
        round11_junction(&selected, &actual);
        assert!(audit_claude_dependencies(&[claude_test_root(&selected)])
            .unwrap_err()
            .contains("预算"));
        std::fs::remove_dir(&selected).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn r12_claude双junction根只批准完整根映射不扩大到祖先() {
        let base = round11_fixture("claude-two-junctions");
        let actual = base.join("actual/projects");
        let middle = base.join("middle");
        let selected = base.join("selected");
        std::fs::create_dir_all(&actual).unwrap();
        std::fs::write(
            actual.join("agent-a.jsonl"),
            br#"{"type":"user","isSidechain":true,"sessionId":"parent"}"#,
        )
        .unwrap();
        std::fs::write(actual.join("parent.jsonl"), b"{}").unwrap();
        round11_junction(&middle, &actual);
        round11_junction(&selected, &middle);
        assert!(audit_claude_dependencies(&[claude_test_root(&selected)]).is_ok());
        let aliases = crate::local_sources::checked_root_aliases(
            &selected,
            crate::local_sources::SourceOrigin::Native,
        )
        .unwrap();
        let refs: Vec<&Path> = aliases.iter().map(|path| path.as_path()).collect();
        assert!(crate::local_sources::check_link_chain_within(
            &base.join("outside.jsonl"),
            crate::local_sources::SourceOrigin::Native,
            &refs,
        )
        .is_err());
        std::fs::remove_dir(&selected).unwrap();
        std::fs::remove_dir(&middle).unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn r12_opencode文件链接最终名不符必须拒绝而非空成功() {
        let base = round11_fixture("opencode-canonical-name");
        let selected = base.join("opencode.db");
        for filename in ["actual.db", "actual.sqlite", "opencode-stable.db"] {
            let actual = base.join(filename);
            std::fs::write(&actual, b"fixture").unwrap();
            std::os::windows::fs::symlink_file(&actual, &selected)
                .unwrap_or_else(|error| panic!("NOT RUN: 无法创建OpenCode文件链接（{error}）"));
            let canonical = crate::local_sources::resolve_layout_root(
                &selected,
                crate::local_sources::SourceOrigin::Native,
                crate::local_sources::ResolvedExpect::File,
            )
            .unwrap();
            assert_eq!(
                require_opencode_database_name(&canonical).is_ok(),
                filename == "opencode-stable.db"
            );
            std::fs::remove_file(&selected).unwrap();
        }
        let _ = std::fs::remove_dir_all(base);
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
    fn round11_fixture(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("dsm-round11-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn r12_非utf8主配置选备用_合法utf8坏json不回退() {
        let root = round11_fixture("fallback");
        let primary = root.join("AppData/Roaming/tokscale/settings.json");
        let fallback = root.join("Library/Application Support/tokscale/settings.json");
        std::fs::create_dir_all(primary.parent().unwrap()).unwrap();
        std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();
        std::fs::write(&primary, [0xff, 0xfe]).unwrap();
        std::fs::write(
            &fallback,
            br#"{"scanner":{"extraScanPaths":{"claude":["D:\\Valid"]}}}"#,
        )
        .unwrap();
        let roots =
            read_engine_config_roots(&root, crate::local_sources::SourceOrigin::Native, true)
                .unwrap()
                .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, std::path::PathBuf::from(r"D:\Valid"));
        std::fs::write(&primary, b"{").unwrap();
        assert!(
            read_engine_config_roots(&root, crate::local_sources::SourceOrigin::Native, true)
                .is_err()
        );
        std::fs::write(&primary, b"{}").unwrap();
        assert!(
            read_engine_config_roots(&root, crate::local_sources::SourceOrigin::Native, true)
                .unwrap()
                .is_none()
        );
        std::fs::File::create(&primary)
            .unwrap()
            .set_len(256 * 1024 + 1)
            .unwrap();
        assert!(
            read_engine_config_roots(&root, crate::local_sources::SourceOrigin::Native, true)
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn r03_合法空variant不阻断home_枚举故障不能当空集合() {
        let root = round11_fixture("mirror-empty");
        let variant = root.join(".cc-mirror/v1");
        std::fs::create_dir_all(&variant).unwrap();
        std::fs::write(variant.join("variant.json"), b"{}").unwrap();
        let roots =
            read_cc_mirror_roots(&root, crate::local_sources::SourceOrigin::Native).unwrap();
        assert_eq!(roots.len(), 1);
        assert!(validate_engine_root(&roots[0], &mut AuditBudget::default())
            .unwrap()
            .is_none());
        std::fs::write(variant.join("config"), b"not a directory").unwrap();
        assert!(validate_engine_root(&roots[0], &mut AuditBudget::default())
            .unwrap()
            .is_none());
        std::fs::write(variant.join("variant.json"), br#"{"name":3}"#).unwrap();
        assert!(read_cc_mirror_roots(&root, crate::local_sources::SourceOrigin::Native).is_err());
        std::fs::remove_dir_all(root.join(".cc-mirror")).unwrap();
        std::fs::write(root.join(".cc-mirror"), b"not a directory").unwrap();
        assert!(read_cc_mirror_roots(&root, crate::local_sources::SourceOrigin::Native).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn r05_真实目录条目共享预算_已完成身份不重复遍历() {
        let root = round11_fixture("budget");
        std::fs::write(root.join("a"), b"a").unwrap();
        std::fs::write(root.join("b"), b"b").unwrap();
        let mut exhausted = AuditBudget {
            entries: REPARSE_AUDIT_MAX_ENTRIES - 1,
            ..AuditBudget::default()
        };
        let result = audit_root_for_reparse_budgeted(
            &root,
            crate::local_sources::SourceOrigin::Native,
            &mut exhausted,
        );
        assert!(matches!(result, Ok(ReparseAudit::Incomplete(_))));
        assert_eq!(exhausted.entries, REPARSE_AUDIT_MAX_ENTRIES + 1);
        let mut shared = AuditBudget::default();
        assert!(matches!(
            audit_root_for_reparse_budgeted(
                &root,
                crate::local_sources::SourceOrigin::Native,
                &mut shared
            ),
            Ok(ReparseAudit::Clean)
        ));
        assert_eq!(shared.entries, 2);
        assert!(matches!(
            audit_root_for_reparse_budgeted(
                &root,
                crate::local_sources::SourceOrigin::Native,
                &mut shared
            ),
            Ok(ReparseAudit::Clean)
        ));
        assert_eq!(shared.entries, 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn r01_标准数据库计划只登记实际文件与日志根() {
        let root = round11_fixture("exact-dbs");
        let opencode = root.join(".local/share/opencode");
        std::fs::create_dir_all(opencode.join("storage/message")).unwrap();
        std::fs::write(opencode.join("opencode.db"), b"fixture").unwrap();
        std::fs::write(opencode.join("opencode-stable.1.db"), b"fixture").unwrap();
        std::fs::write(opencode.join("unrelated.db"), b"fixture").unwrap();
        std::fs::create_dir_all(root.join(".hermes/profiles/p1")).unwrap();
        std::fs::write(root.join(".hermes/profiles/p1/state.db"), b"fixture").unwrap();
        std::fs::write(root.join(".hermes/profiles/README"), b"ordinary file").unwrap();
        let roots =
            validated_standard_roots(&root, crate::local_sources::SourceOrigin::Native).unwrap();
        assert_eq!(
            roots.iter().filter(|root| root.tool == "opencode").count(),
            3
        );
        assert_eq!(roots.iter().filter(|root| root.tool == "hermes").count(), 1);
        assert!(!roots.iter().any(|root| root.path.ends_with("unrelated.db")));
        assert!(!roots
            .iter()
            .any(|root| root.path == std::fs::canonicalize(&opencode).unwrap()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn r06_取消等待不释放在途worker许可_检查点退出后可再采集() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn(async move {
            run_bounded_io(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let _ = finished_tx.send(io_checkpoint());
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        // A blocking operation must not keep the async timer from being polled.
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::time::sleep(Duration::from_millis(5)),
        )
        .await
        .unwrap();
        waiting.abort();
        let _ = waiting.await;
        let busy = run_bounded_io(|| ()).await;
        release_tx.send(()).unwrap();
        assert!(busy.is_err(), "worker 尚未退出时必须保留许可");
        assert!(
            finished_rx.await.unwrap().is_err(),
            "取消标志须在下一检查点可见"
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if run_bounded_io(|| ()).await.is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(windows)]
    fn round11_junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "NOT RUN: junction 前置条件失败，不能记为通过"
        );
    }

    #[cfg(windows)]
    #[test]
    fn r04_二跳在规范化前拒绝_不递归无关目录链接() {
        let base = round11_fixture("two-hop");
        let root = base.join("agents");
        let target = base.join("target");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        round11_junction(&root.join("a"), &target);
        round11_junction(&target.join("unrelated"), Path::new(r"C:\Windows\System32"));
        assert!(
            matches!(audit_root_for_reparse(&root), Ok(ReparseAudit::Clean)),
            "通用遍历不进入链接目录的无关内容"
        );
        assert!(audit_special_databases(
            &root,
            "openclaw",
            false,
            crate::local_sources::SourceOrigin::Native,
            &mut AuditBudget::default()
        )
        .is_ok());
        round11_junction(&target.join("agent"), Path::new(r"C:\Windows\System32"));
        let error = audit_special_databases(
            &root,
            "openclaw",
            false,
            crate::local_sources::SourceOrigin::Native,
            &mut AuditBudget::default(),
        )
        .unwrap_err();
        assert!(error.contains("未访问"));
        for link in [
            target.join("agent"),
            target.join("unrelated"),
            root.join("a"),
        ] {
            std::fs::remove_dir(link).unwrap();
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn r05_自回链和双节点目录回链有界且不进入引擎不读的树() {
        let base = round11_fixture("cycles");
        let a = base.join("a");
        let b = base.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        round11_junction(&a.join("self"), &a);
        round11_junction(&a.join("to-b"), &b);
        round11_junction(&b.join("to-a"), &a);
        let mut budget = AuditBudget::default();
        assert!(matches!(
            audit_root_for_reparse_budgeted(
                &a,
                crate::local_sources::SourceOrigin::Native,
                &mut budget
            ),
            Ok(ReparseAudit::Clean)
        ));
        assert_eq!(budget.entries, 2, "只检查引擎会探测的链接，不递归重建预算");
        for link in [a.join("self"), a.join("to-b"), b.join("to-a")] {
            std::fs::remove_dir(link).unwrap();
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn r04_精确数据库所有sqlite旁文件都必须在读取边界内() {
        let base = round11_fixture("sidecars");
        let database = base.join("state.db");
        std::fs::write(&database, b"fixture").unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            let link = base.join(format!("state.db{suffix}"));
            round11_junction(&link, Path::new(r"C:\Windows\System32"));
            assert!(audit_optional_database(
                &database,
                "hermes",
                crate::local_sources::SourceOrigin::Native,
                &mut AuditBudget::default()
            )
            .is_err());
            std::fs::remove_dir(link).unwrap();
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn r06_动态数据库根也受最终计划数量限制() {
        let root = round11_fixture("plan-limit");
        for index in 0..=MAX_SCAN_ROOTS {
            std::fs::write(root.join(format!("opencode-c{index}.db")), b"fixture").unwrap();
        }
        let error = audit_special_databases(
            &root,
            "opencode",
            true,
            crate::local_sources::SourceOrigin::Native,
            &mut AuditBudget::default(),
        )
        .unwrap_err();
        assert!(error.contains("256"));
        let _ = std::fs::remove_dir_all(root);
    }
}
