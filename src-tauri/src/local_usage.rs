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
    let wsl = if candidates
        .iter()
        .any(|(_, _, _, kind, _)| matches!(kind, HomeKind::Wsl { .. }))
    {
        Some(crate::local_sources::running_wsl().await)
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut succeeded = 0;
    let mut zcode_adapter_used = false;
    for (id, label, home, kind, is_default) in candidates {
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
                let canonical = crate::local_sources::probe_path(home.clone(), directory).await?;
                let key = format!(
                    "{}:{}",
                    tool_path.map(|entry| entry.tool.as_str()).unwrap_or("home"),
                    home_key(&canonical.to_string_lossy())
                );
                if seen.contains(&key) {
                    return Ok(None);
                }
                let snapshot = if let Some(entry) = tool_path {
                    run_tool_source(path, entry, &profile.join(&id)).await?
                } else {
                    run_engine_profile(
                        path,
                        if is_default { None } else { Some(&home) },
                        &profile.join(&id),
                    )
                    .await?
                };
                seen.insert(key);
                Ok::<_, String>(Some(scope_snapshot(snapshot, &id, &label)))
            })
            .await;
            match result {
                Ok(Ok(Some(snapshot))) => {
                    zcode_adapter_used |=
                        snapshot.engine_version == crate::zcode_usage::ADAPTER_VERSION;
                    if rows.len() + snapshot.rows.len() > 50000 {
                        return Err("合并记录过多，请缩小采集目录范围".into());
                    }
                    succeeded += 1;
                    rows.extend(snapshot.rows);
                }
                Ok(Ok(None)) => {
                    state = "duplicate";
                    message = Some("已由相同主目录覆盖，未重复采集".into());
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
async fn run_tool_source(
    path: &Path,
    entry: &crate::local_sources::ToolPath,
    profile: &Path,
) -> Result<LocalSnapshot, String> {
    if entry.tool == "zcode" {
        return crate::zcode_usage::collect(entry.path.clone().into()).await;
    }
    // --home loads scanner settings from this app-owned empty home. Never write
    // settings into the user's tool root or copy a live SQLite/WAL database.
    let home = profile.join("scan-home");
    let config = home.join("AppData/Roaming/tokscale");
    std::fs::create_dir_all(&config).map_err(|_| "指定路径的采集设置无法保存")?;
    let settings = if entry.tool == "opencode" {
        serde_json::json!({"scanner":{"opencodeDbPaths":[entry.path]}})
    } else {
        let mut paths = serde_json::Map::new();
        paths.insert(entry.tool.clone(), serde_json::json!([entry.path]));
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console window on polling.
    if let Some(home) = home {
        command.arg("--home").arg(home);
    }
    let mut child = command.spawn().map_err(|_| "无法启动本地采集引擎")?;
    let mut data = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        child
            .stdout
            .take()
            .ok_or("采集输出不可用")?
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut data)
            .await
            .map_err(|_| "无法读取采集结果")?;
        if data.len() as u64 > MAX_OUTPUT {
            return Err("采集结果超过安全大小限制");
        }
        let status = child.wait().await.map_err(|_| "采集进程状态不可用")?;
        if !status.success() {
            return Err("本地记录读取失败，请稍后重试");
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
}
