//! Explicit, bounded snapshots. Never merged into live totals or tool logs.
use crate::local_usage::{LocalSnapshot, TimingCoverage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 12;
fn path() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-archive.json"))
}
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRow {
    pub source_id: String,
    pub source_label: String,
    pub tool: String,
    pub session_id: String,
    pub model: String,
    pub project_ref: Option<String>,
    pub project_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
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
    pub timing_coverage: TimingCoverage,
    pub token_accuracy: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub id: String,
    pub saved_at: u64,
    pub collected_at: u64,
    pub period_key: String,
    pub engine_version: String,
    pub scope: String,
    pub includes_paths: bool,
    pub complete: bool,
    pub stale: bool,
    pub rows: Vec<ArchiveRow>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    schema_version: u32,
    entries: Vec<ArchiveEntry>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            schema_version: 1,
            entries: vec![],
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    pub source_label: Option<String>,
    pub session_id: Option<String>,
    pub tool: Option<String>,
    pub project_label: Option<String>,
    pub id: String,
    pub saved_at: u64,
    pub collected_at: u64,
    pub period_key: String,
    pub scope: String,
    pub includes_paths: bool,
    pub complete: bool,
    pub stale: bool,
    pub row_count: usize,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ArchiveScope {
    All,
    Project {
        key: String,
    },
    Session {
        key: String,
        #[serde(default, rename = "projectKey")]
        project_key: Option<String>,
    },
}
/// Only the current accepted backend snapshot may be saved; frontend sends no rows.
pub fn current_snapshot(
    state: &crate::local_usage::LocalState,
    collected_at: u64,
    now: u64,
) -> Result<&LocalSnapshot, String> {
    if state.busy || state.enabled != Some(true) {
        return Err("采集更新中或统计已关闭，请稍后重试".into());
    }
    let snapshot = state
        .snapshot
        .as_ref()
        .filter(|snapshot| snapshot.collected_at == collected_at)
        .ok_or("采集已变更，请刷新后再保存")?;
    if now < collected_at {
        return Err("系统时间早于采集时间，请重新读取后归档".into());
    }
    if crate::local_usage::local_period(now).as_deref() != Some(snapshot.period_key.as_str()) {
        return Err("采集不属于当前本地月份，请重新读取后归档".into());
    }
    Ok(snapshot)
}
fn selected<'a>(
    snapshot: &'a LocalSnapshot,
    scope: &ArchiveScope,
) -> Vec<&'a crate::local_usage::LocalRow> {
    snapshot
        .rows
        .iter()
        .filter(|row| match scope {
            ArchiveScope::All => true,
            ArchiveScope::Project { key } => matches_project(row, key),
            ArchiveScope::Session { key, project_key } => {
                *key == format!("{}\0{}\0{}", row.source_id, row.tool, row.session_id)
                    && project_key
                        .as_ref()
                        .is_none_or(|project| matches_project(row, project))
            }
        })
        .collect()
}
fn matches_project(row: &crate::local_usage::LocalRow, key: &str) -> bool {
    row.project_key.as_deref() == Some(key)
        || row.project_key.is_none() && key == format!("{}\0unassigned", row.source_id)
}
fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}
pub(crate) fn valid_entry(entry: &ArchiveEntry) -> bool {
    let text = |value: &str| {
        !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
    };
    let number = |value: Option<u64>| value.is_none_or(|value| value <= 9_007_199_254_740_991);
    let month = entry.period_key.as_bytes();
    valid_id(&entry.id)
        && entry.collected_at <= 8_640_000_000_000_000
        && entry.saved_at <= 8_640_000_000_000_000
        && text(&entry.engine_version)
        && matches!(entry.scope.as_str(), "all" | "project" | "session")
        && month.len() == 7
        && month[4] == b'-'
        && month[..4]
            .iter()
            .chain(month[5..].iter())
            .all(u8::is_ascii_digit)
        && ("01"..="12").contains(&&entry.period_key[5..])
        && !entry.rows.is_empty()
        && entry.rows.len() <= 50000
        && entry.rows.iter().all(|row| {
            text(&row.source_id)
                && text(&row.source_label)
                && text(&row.model)
                && text(&row.session_id)
                && matches!(
                    row.tool.as_str(),
                    "opencode" | "claude" | "zcode" | "hermes" | "openclaw" | "dsh"
                )
                && row.project_ref.as_ref().is_none_or(|value| valid_id(value))
                && row.project_label.as_ref().is_none_or(|value| text(value))
                && row
                    .project_path
                    .as_ref()
                    .is_none_or(|value| entry.includes_paths && text(value))
                && row.token_accuracy == "unclassified"
                && [
                    row.input,
                    row.output,
                    row.cache_read,
                    row.cache_write,
                    row.reasoning,
                    row.total_tokens,
                    row.message_count,
                    row.timed_output_tokens,
                    row.timed_duration_ms,
                    row.first_active_ms,
                    row.last_active_ms,
                ]
                .into_iter()
                .all(number)
        })
}
fn load() -> Result<Store, String> {
    let path = path()?;
    let file = match fs::File::open(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(_) => return Err("归档无法读取，请重试".into()),
        Ok(file) => file,
    };
    use std::io::Read;
    let mut data = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "归档无法读取")?;
    if data.len() > MAX_BYTES {
        return Err("归档超过8MiB限制，未读取或改写".into());
    }
    let store: Store =
        serde_json::from_slice(&data).map_err(|_| "归档损坏，未覆盖；可清空全部归档后重新保存")?;
    if store.schema_version != 1
        || store.entries.len() > MAX_ENTRIES
        || store.entries.iter().any(|entry| !valid_entry(entry))
    {
        return Err("归档版本或结构不可用，未覆盖".into());
    }
    let unique: BTreeSet<_> = store.entries.iter().map(|entry| &entry.id).collect();
    if unique.len() != store.entries.len() {
        return Err("归档包含重复标识，未覆盖".into());
    }
    Ok(store)
}
fn write(store: &Store) -> Result<(), String> {
    let data = serde_json::to_vec(store).map_err(|_| "归档无法编码")?;
    if data.len() > MAX_BYTES {
        return Err("归档总量超过8MiB，请缩小保存范围或删除旧归档".into());
    }
    let path = path()?;
    fs::create_dir_all(path.parent().ok_or("归档目录不可用")?).map_err(|_| "归档目录不可用")?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, data).map_err(|_| "归档无法保存，原记录保留")?;
    fs::rename(temp, path).map_err(|_| "归档无法提交，原记录保留".into())
}
pub(crate) fn sanitized_rows(
    rows: Vec<&crate::local_usage::LocalRow>,
    includes_paths: bool,
) -> Vec<ArchiveRow> {
    rows.into_iter()
        .map(|row| ArchiveRow {
            source_id: row.source_id.clone(),
            source_label: row.source_label.clone(),
            tool: row.tool.clone(),
            session_id: row.session_id.clone(),
            model: row.model.clone(),
            project_ref: row.project_key.as_ref().map(|key| digest(key)),
            project_label: row.project_path.as_ref().and_then(|path| {
                path.replace('\\', "/")
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
            }),
            project_path: if includes_paths {
                row.project_path.clone()
            } else {
                None
            },
            input: row.input,
            output: row.output,
            cache_read: row.cache_read,
            cache_write: row.cache_write,
            reasoning: row.reasoning,
            total_tokens: row.total_tokens,
            message_count: row.message_count,
            timed_output_tokens: row.timed_output_tokens,
            timed_duration_ms: row.timed_duration_ms,
            first_active_ms: row.first_active_ms,
            last_active_ms: row.last_active_ms,
            timing_coverage: row.timing_coverage.clone(),
            token_accuracy: "unclassified".into(),
        })
        .collect::<Vec<_>>()
}
pub fn capture(
    snapshot: &LocalSnapshot,
    scope: &ArchiveScope,
    includes_paths: bool,
    stale: bool,
    saved_at: u64,
) -> Result<ArchiveEntry, String> {
    let _guard = lock().lock().map_err(|_| "归档状态不可用")?;
    let mut store = load()?;
    let selected = selected(snapshot, scope);
    if selected.is_empty() {
        return Err("当前范围没有可归档记录".into());
    }
    let scope_name = match scope {
        ArchiveScope::All => "all",
        ArchiveScope::Project { .. } => "project",
        ArchiveScope::Session { .. } => "session",
    };
    let rows = sanitized_rows(selected, includes_paths);
    let id = digest(
        &serde_json::to_string(&(
            &snapshot.period_key,
            snapshot.collected_at,
            &snapshot.engine_version,
            snapshot.complete,
            scope_name,
            includes_paths,
            stale,
            &rows,
        ))
        .map_err(|_| "归档无法编码")?,
    );
    if let Some(entry) = store.entries.iter().find(|entry| entry.id == id) {
        return Ok(entry.clone());
    }
    if store.entries.len() >= MAX_ENTRIES {
        return Err("已保留12份归档，请先删除不需要的记录；未自动覆盖".into());
    }
    let entry = ArchiveEntry {
        id,
        saved_at,
        collected_at: snapshot.collected_at,
        period_key: snapshot.period_key.clone(),
        engine_version: snapshot.engine_version.clone(),
        scope: scope_name.into(),
        includes_paths,
        complete: snapshot.complete,
        stale,
        rows,
    };
    if !valid_entry(&entry) {
        return Err("归档字段或期间不可用，未保存".into());
    }
    store.entries.push(entry.clone());
    write(&store)?;
    Ok(entry)
}
pub fn list() -> Result<Vec<ArchiveSummary>, String> {
    let _guard = lock().lock().map_err(|_| "归档状态不可用")?;
    let mut entries = load()?.entries;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at));
    Ok(entries
        .into_iter()
        .map(|entry| ArchiveSummary {
            source_label: None,
            session_id: None,
            tool: None,
            project_label: None,
            id: entry.id,
            saved_at: entry.saved_at,
            collected_at: entry.collected_at,
            period_key: entry.period_key,
            scope: entry.scope,
            includes_paths: entry.includes_paths,
            complete: entry.complete,
            stale: entry.stale,
            row_count: entry.rows.len(),
        })
        .collect())
}
pub fn read(id: &str) -> Result<ArchiveEntry, String> {
    if !valid_id(id) {
        return Err("归档标识不可用".into());
    }
    let _guard = lock().lock().map_err(|_| "归档状态不可用")?;
    load()?
        .entries
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or("归档不存在，请重新读取列表".into())
}
pub fn delete(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("归档标识不可用".into());
    }
    let _guard = lock().lock().map_err(|_| "归档状态不可用")?;
    let mut store = load()?;
    let before = store.entries.len();
    store.entries.retain(|entry| entry.id != id);
    if before == store.entries.len() {
        return Err("归档不存在".into());
    }
    write(&store)
}
pub fn clear() -> Result<(), String> {
    let _guard = lock().lock().map_err(|_| "归档状态不可用")?;
    match fs::remove_file(path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("归档无法清空，原记录保留".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{local_usage::normalize_report, test_support::TempConfigDir};
    fn snapshot(at: u64) -> LocalSnapshot {
        let value = serde_json::json!({"entries":[
            {"client":"opencode","sessionId":"s1","workspaceKey":"w1","model":"deepseek","input":10,"output":20,"reasoning":0,"cacheRead":0,"cacheWrite":0},
            {"client":"claude","sessionId":"s2","workspaceKey":"w1","model":"deepseek","input":30,"output":40,"cacheRead":0,"cacheWrite":0},
            {"client":"hermes","sessionId":"s3","model":"deepseek","input":50,"output":60}
        ], "workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}], "sessions":[]});
        normalize_report(&value, at).unwrap()
    }
    #[test]
    fn session_in_project_is_intersection_and_all_session_retains_all_projects() {
        let _dir = TempConfigDir::new("archive-session-project");
        let mut snap = snapshot(1000);
        let mut a = snap
            .rows
            .iter()
            .find(|row| row.tool == "opencode")
            .unwrap()
            .clone();
        a.input = Some(100);
        a.output = Some(0);
        a.total_tokens = Some(100);
        let mut b = a.clone();
        b.project_key = Some("d:/private/other".into());
        b.project_path = Some("D:\\Private\\Other".into());
        b.input = Some(900);
        b.total_tokens = Some(900);
        let mut unassigned = a.clone();
        unassigned.project_key = None;
        unassigned.project_path = None;
        snap.rows = vec![a, b, unassigned];
        let scope = |project_key| ArchiveScope::Session {
            key: "native\0opencode\0s1".into(),
            project_key,
        };
        for include_paths in [false, true] {
            let entry = capture(
                &snap,
                &scope(Some("d:/private/repo".into())),
                include_paths,
                false,
                2000,
            )
            .unwrap();
            assert_eq!(entry.rows.len(), 1);
            assert_eq!(entry.rows[0].total_tokens, Some(100));
            assert!(!serde_json::to_string(&entry).unwrap().contains("Other"));
            assert_eq!(entry.rows[0].project_path.is_some(), include_paths);
        }
        assert_eq!(selected(&snap, &scope(None)).len(), 3);
        let legacy: ArchiveScope =
            serde_json::from_str(r#"{"kind":"session","key":"native\u0000opencode\u0000s1"}"#)
                .unwrap();
        assert_eq!(selected(&snap, &legacy).len(), 3);
        assert_eq!(
            selected(&snap, &scope(Some("native\0unassigned".into()))).len(),
            1
        );
        assert!(selected(&snap, &scope(Some("absent".into()))).is_empty());
    }
    #[test]
    fn capture_gate_rejects_disabled_busy_changed_future_and_other_month() {
        let mut state = crate::local_usage::LocalState {
            enabled: Some(true),
            snapshot: Some(snapshot(1000)),
            ..Default::default()
        };
        assert!(current_snapshot(&state, 1000, 2000).is_ok());
        state.busy = true;
        assert!(current_snapshot(&state, 1000, 2000).is_err());
        state.busy = false;
        state.enabled = Some(false);
        assert!(current_snapshot(&state, 1000, 2000).is_err());
        state.enabled = Some(true);
        assert!(current_snapshot(&state, 1001, 2000).is_err());
        assert!(current_snapshot(&state, 1000, 999).is_err());
        assert!(current_snapshot(&state, 1000, 90 * 86_400_000).is_err());
        state.snapshot = None;
        assert!(current_snapshot(&state, 1000, 2000).is_err());
    }
    #[test]
    fn scope_roundtrip_privacy_and_explicit_paths() {
        let _dir = TempConfigDir::new("archive-scope");
        let snap = snapshot(1000);
        let all = capture(&snap, &ArchiveScope::All, false, true, 2000).unwrap();
        assert_eq!(all.rows.len(), 3);
        assert_eq!(read(&all.id).unwrap(), all);
        let serialized = serde_json::to_string(&all).unwrap();
        assert!(!serialized.contains("Private"));
        assert!(!serialized.contains("projectKey"));
        assert!(all.rows.iter().all(|row| row.project_path.is_none()));
        let project = capture(
            &snap,
            &ArchiveScope::Project {
                key: "d:/private/repo".into(),
            },
            true,
            false,
            3000,
        )
        .unwrap();
        assert_eq!(project.rows.len(), 2);
        assert!(project
            .rows
            .iter()
            .all(|row| row.project_path.as_deref() == Some("D:\\Private\\Repo")));
        let session = capture(
            &snap,
            &ArchiveScope::Session {
                key: "native\0opencode\0s1".into(),
                project_key: None,
            },
            false,
            false,
            4000,
        )
        .unwrap();
        assert_eq!(session.rows.len(), 1);
        assert!(capture(
            &snap,
            &ArchiveScope::Session {
                key: "absent".into(),
                project_key: None,
            },
            false,
            false,
            5000
        )
        .is_err());
        let unassigned = capture(
            &snap,
            &ArchiveScope::Project {
                key: "native\0unassigned".into(),
            },
            false,
            false,
            5000,
        )
        .unwrap();
        assert_eq!(unassigned.rows[0].tool, "hermes");
        assert_eq!(list().unwrap()[0].id, unassigned.id);
    }
    #[test]
    fn duplicate_capture_and_limit_preserve_existing_file() {
        let _dir = TempConfigDir::new("archive-limit");
        let first = capture(&snapshot(1000), &ArchiveScope::All, false, false, 2000).unwrap();
        assert_eq!(
            capture(&snapshot(1000), &ArchiveScope::All, false, false, 3000).unwrap(),
            first
        );
        for at in 1001..1012 {
            capture(&snapshot(at), &ArchiveScope::All, false, false, 3000).unwrap();
        }
        let before = fs::read(path().unwrap()).unwrap();
        assert!(capture(&snapshot(1012), &ArchiveScope::All, false, false, 4000).is_err());
        assert_eq!(fs::read(path().unwrap()).unwrap(), before);
        assert_eq!(list().unwrap().len(), 12);
    }
    #[test]
    fn write_failure_delete_and_clear_are_scoped() {
        let dir = TempConfigDir::new("archive-failure");
        let first = capture(&snapshot(1000), &ArchiveScope::All, false, false, 2000).unwrap();
        let before = fs::read(path().unwrap()).unwrap();
        let temp = path().unwrap().with_extension("tmp");
        fs::create_dir(&temp).unwrap();
        assert!(capture(&snapshot(1001), &ArchiveScope::All, false, false, 2000).is_err());
        assert_eq!(fs::read(path().unwrap()).unwrap(), before);
        fs::remove_dir(temp).unwrap();
        fs::write(dir.join("tool-log.json"), b"keep").unwrap();
        fs::write(dir.join("cache.json"), b"keep").unwrap();
        assert!(delete("../../tool-log.json").is_err());
        assert!(read("../../tool-log.json").is_err());
        delete(&first.id).unwrap();
        assert!(read(&first.id).is_err());
        clear().unwrap();
        clear().unwrap();
        assert_eq!(fs::read(dir.join("tool-log.json")).unwrap(), b"keep");
        assert_eq!(fs::read(dir.join("cache.json")).unwrap(), b"keep");
    }
    #[test]
    fn damaged_unknown_and_oversize_stores_are_never_overwritten() {
        let _dir = TempConfigDir::new("archive-damage");
        for bytes in [
            b"broken".to_vec(),
            br#"{"schemaVersion":2,"entries":[]}"#.to_vec(),
            vec![b' '; MAX_BYTES + 1],
        ] {
            fs::write(path().unwrap(), &bytes).unwrap();
            assert!(list().is_err());
            assert!(capture(&snapshot(1000), &ArchiveScope::All, false, false, 2000).is_err());
            assert_eq!(fs::read(path().unwrap()).unwrap(), bytes);
            clear().unwrap();
            assert!(list().unwrap().is_empty());
        }
    }
    #[test]
    fn stored_whitelist_rejects_paths_accuracy_and_unsafe_counters() {
        let _dir = TempConfigDir::new("archive-validation");
        let entry = capture(&snapshot(1000), &ArchiveScope::All, false, false, 2000).unwrap();
        let base = serde_json::json!({"schemaVersion":1,"entries":[entry]});
        let mut extra = base.clone();
        extra["entries"][0]["rows"][0]["prompt"] = "SECRET".into();
        fs::write(path().unwrap(), serde_json::to_vec(&extra).unwrap()).unwrap();
        assert!(!serde_json::to_string(&read(&entry.id).unwrap())
            .unwrap()
            .contains("SECRET"));
        for (field, value) in [
            ("projectPath", serde_json::json!("D:\\Private")),
            ("tokenAccuracy", serde_json::json!("measured")),
            ("totalTokens", serde_json::json!(9_007_199_254_740_992u64)),
        ] {
            let mut changed = base.clone();
            changed["entries"][0]["rows"][0][field] = value;
            fs::write(path().unwrap(), serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(list().is_err());
        }
    }
    #[test]
    fn snapshot_period_and_unknown_values_survive_without_inference() {
        let _dir = TempConfigDir::new("archive-period");
        let mut snap = snapshot(1000);
        snap.period_key = "2026-10".into();
        snap.complete = false;
        let entry = capture(&snap, &ArchiveScope::All, false, true, 2000).unwrap();
        assert_eq!(entry.period_key, "2026-10");
        assert!(!entry.complete);
        assert!(entry.stale);
        assert!(entry.rows.iter().any(|row| row.total_tokens.is_none()));
        snap.complete = true;
        let changed = capture(&snap, &ArchiveScope::All, false, true, 2000).unwrap();
        assert_ne!(changed.id, entry.id);
        assert!(changed.complete);
        assert!(crate::local_usage::local_period(u64::MAX).is_none());
        snap.period_key = "2026-13".into();
        assert!(capture(&snap, &ArchiveScope::All, false, false, 2000).is_err());
    }
}
