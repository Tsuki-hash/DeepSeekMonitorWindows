//! Opt-in latest observed session checkpoints. Never infer deletion or merge
//! retained sessions into live totals. Background collection is a separate feature.
use crate::{
    local_archive::{sanitized_rows, valid_entry, ArchiveEntry, ArchiveSummary},
    local_usage::LocalSnapshot,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
fn path(name: &str) -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name(name))
}
fn store_path() -> Result<PathBuf, String> {
    path("local-usage-retention.json")
}
fn enabled_path() -> Result<PathBuf, String> {
    path("local-usage-retention-enabled.json")
}
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    schema_version: u32,
    entries: Vec<ArchiveEntry>,
}
fn id(period: &str, source: &str, tool: &str, session: &str) -> Result<String, String> {
    let value =
        serde_json::to_vec(&(period, source, tool, session)).map_err(|_| "留存标识不可用")?;
    Ok(format!("{:x}", Sha256::digest(value)))
}
fn load_enabled() -> Result<bool, String> {
    let file = match fs::File::open(enabled_path()?) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("自动留存设置无法读取".into()),
    };
    let mut data = Vec::new();
    file.take(17)
        .read_to_end(&mut data)
        .map_err(|_| "自动留存设置无法读取")?;
    if data.len() > 16 {
        return Err("自动留存设置不可用，请关闭并重置设置".into());
    }
    serde_json::from_slice(&data).map_err(|_| "自动留存设置损坏，请关闭并重置设置".into())
}
fn atomic(path: PathBuf, data: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("留存目录不可用")?).map_err(|_| "留存目录不可用")?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, data).map_err(|_| "留存无法保存，原记录保留")?;
    fs::rename(&temp, path).map_err(|error| {
        // 复评 T12：提交失败时尽力删除临时副本，避免留下可读的元数据文件。
        let _ = fs::remove_file(&temp);
        format!("留存无法提交，原记录保留（{error}）")
    })
}
pub fn enabled() -> Result<bool, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    load_enabled()
}
pub fn set_enabled(enabled: bool) -> Result<bool, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    atomic(enabled_path()?, if enabled { b"true" } else { b"false" })?;
    Ok(enabled)
}
fn valid(entry: &ArchiveEntry) -> bool {
    if !valid_entry(entry) || entry.scope != "session" || entry.includes_paths {
        return false;
    }
    let row = &entry.rows[0];
    id(
        &entry.period_key,
        &row.source_id,
        &row.tool,
        &row.session_id,
    )
    .is_ok_and(|id| id == entry.id)
        && entry.rows.iter().all(|other| {
            other.source_id == row.source_id
                && other.tool == row.tool
                && other.session_id == row.session_id
        })
}
fn load() -> Result<Store, String> {
    let file = match fs::File::open(store_path()?) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                schema_version: 1,
                entries: vec![],
            })
        }
        Err(_) => return Err("会话留存无法读取".into()),
    };
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "会话留存无法读取")?;
    if bytes.len() > MAX_BYTES {
        return Err("会话留存超过8MiB，未覆盖".into());
    }
    let store: Store =
        serde_json::from_slice(&bytes).map_err(|_| "会话留存损坏，未覆盖；可显式清空后恢复")?;
    if store.schema_version != 1
        || store.entries.len() > MAX_ENTRIES
        || store.entries.iter().any(|entry| !valid(entry))
        || store
            .entries
            .iter()
            .map(|entry| &entry.id)
            .collect::<BTreeSet<_>>()
            .len()
            != store.entries.len()
    {
        return Err("会话留存结构或版本不可用，未覆盖".into());
    }
    Ok(store)
}
fn write(store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|_| "会话留存无法编码")?;
    if bytes.len() > MAX_BYTES {
        return Err("会话留存超过8MiB，未覆盖；请删除不需要的记录".into());
    }
    atomic(store_path()?, &bytes)
}
/// 容量状态：让界面能显示「还剩几条」而不是只在满额时报错。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub entries: usize,
    pub max_entries: usize,
    pub bytes: u64,
    pub max_bytes: u64,
    /// 剩余可新增的会话月份数；0 表示已满。
    pub remaining_entries: usize,
}

pub fn capacity() -> Result<Capacity, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    let store = load()?;
    let bytes = store_path()
        .ok()
        .and_then(|path| fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    Ok(Capacity {
        entries: store.entries.len(),
        max_entries: MAX_ENTRIES,
        bytes,
        max_bytes: MAX_BYTES as u64,
        remaining_entries: MAX_ENTRIES.saturating_sub(store.entries.len()),
    })
}

/// 采集检查点的结果：区分「完全成功」与「部分写入」。
///
/// 评审 P2：原实现在满额时**整批**返回错误，连已存在会话这一轮的更新也不落盘。
/// 新策略是逐条判定：已存在的会话继续更新，新会话在无空间时单独拒绝并计入
/// `skipped`；已写入的部分照常落盘，用户看到的是明确的部分结果而不是整体失败。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CheckpointOutcome {
    /// 已写入（含内容未变的跳过写盘）。
    pub written: usize,
    /// 因容量已满而未新增的会话数。
    pub skipped: usize,
    /// 写入失败（此时整批不落盘，保持原记录）。
    pub failed: bool,
}

pub fn checkpoint(snapshot: &LocalSnapshot) -> Result<CheckpointOutcome, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    let mut outcome = CheckpointOutcome::default();
    if !load_enabled()? {
        return Ok(outcome);
    }
    let mut store = load()?;
    let mut groups: BTreeMap<(&str, &str, &str), Vec<&crate::local_usage::LocalRow>> =
        BTreeMap::new();
    for row in &snapshot.rows {
        groups
            .entry((&row.source_id, &row.tool, &row.session_id))
            .or_default()
            .push(row);
    }
    let mut changed = false;
    for ((source, tool, session), rows) in groups {
        let entry = ArchiveEntry {
            id: id(&snapshot.period_key, source, tool, session)?,
            saved_at: snapshot.collected_at,
            collected_at: snapshot.collected_at,
            period_key: snapshot.period_key.clone(),
            // 与手动归档一致：保留采集时的本地 UTC 偏移，便于换时区复核。
            accounting_utc_offset_seconds: snapshot.accounting_utc_offset_seconds,
            engine_version: snapshot.engine_version.clone(),
            scope: "session".into(),
            includes_paths: false,
            complete: snapshot.complete,
            stale: false,
            rows: sanitized_rows(rows, false),
        };
        if !valid(&entry) {
            return Err("会话留存字段不可用，未改写".into());
        }
        if let Some(previous) = store
            .entries
            .iter_mut()
            .find(|previous| previous.id == entry.id)
        {
            if entry.collected_at < previous.collected_at {
                return Err("采集时间早于已有留存，未改写；请核对系统时间".into());
            }
            if previous.rows == entry.rows
                && previous.complete == entry.complete
                && previous.engine_version == entry.engine_version
                && previous.accounting_utc_offset_seconds == entry.accounting_utc_offset_seconds
            {
                outcome.written += 1;
                continue;
            }
            *previous = entry;
            outcome.written += 1;
        } else if store.entries.len() >= MAX_ENTRIES {
            // 只拒绝这一条新会话，已存在会话的更新不受影响。
            outcome.skipped += 1;
            continue;
        } else {
            store.entries.push(entry);
            outcome.written += 1;
        }
        changed = true;
    }
    if changed && write(&store).is_err() {
        // 写盘失败：整批未提交，原记录保留，如实报告。
        outcome.failed = true;
        return Ok(outcome);
    }
    Ok(outcome)
}
pub fn list() -> Result<Vec<ArchiveSummary>, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    let mut entries = load()?.entries;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at));
    Ok(entries
        .into_iter()
        .map(|entry| ArchiveSummary {
            source_label: Some(entry.rows[0].source_label.clone()),
            session_id: Some(entry.rows[0].session_id.clone()),
            tool: Some(entry.rows[0].tool.clone()),
            project_label: entry.rows[0].project_label.clone(),
            id: entry.id,
            saved_at: entry.saved_at,
            collected_at: entry.collected_at,
            period_key: entry.period_key,
            accounting_utc_offset_seconds: entry.accounting_utc_offset_seconds,
            scope: entry.scope,
            includes_paths: false,
            complete: entry.complete,
            stale: entry.stale,
            row_count: entry.rows.len(),
        })
        .collect())
}
pub fn read(id: &str) -> Result<ArchiveEntry, String> {
    validate_id(id)?;
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    load()?
        .entries
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or("会话留存不存在，请重读列表".into())
}
pub fn delete(id: &str) -> Result<(), String> {
    validate_id(id)?;
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    let mut store = load()?;
    let before = store.entries.len();
    store.entries.retain(|entry| entry.id != id);
    if before == store.entries.len() {
        return Err("会话留存不存在".into());
    }
    write(&store)
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("会话留存标识不可用".into())
    }
}
pub fn clear() -> Result<(), String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    // 复评 T12：写后 rename 失败或进程中断会留下 `.tmp` 临时副本，
    // 内容与正式文件相同（会话 ID、项目名等）。清空必须连同删除；
    // 任一失败都如实报告，不宣称「已全部清空」。只删本应用固定名称的文件。
    let mut failed = Vec::new();
    for target in [store_path()?, store_path()?.with_extension("tmp")] {
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed.push(
                target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "会话留存无法完全清空（{} 保留）；请检查文件权限后重试",
            failed.join("、")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempConfigDir;
    fn snapshot(at: u64) -> LocalSnapshot {
        crate::local_usage::normalize_report(&serde_json::json!({"entries":[{"client":"opencode","sessionId":"s1","workspaceKey":"w1","model":"deepseek","input":100,"output":20,"reasoning":0,"cacheRead":10,"cacheWrite":0},{"client":"hermes","sessionId":"s2","model":"deepseek","input":null,"output":20}],"workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}],"sessions":[]}),at).unwrap()
    }
    #[test]
    fn clear_removes_leftover_tmp_copy() {
        // 复评 T12：写后 rename 失败/中断留下的 `.tmp` 副本必须随清空一并删除，
        // 否则清空返回成功、总览却仍有可读的会话元数据文件。
        let _dir = TempConfigDir::new("retention-tmp");
        let stale = store_path().unwrap().with_extension("tmp");
        std::fs::write(&stale, b"stale-copy").unwrap();
        std::fs::write(store_path().unwrap(), b"stale-store").unwrap();
        clear().unwrap();
        assert!(!store_path().unwrap().exists());
        assert!(!stale.exists(), "临时副本必须一并删除");
        // 再次清空（两个文件都不存在）也应成功。
        clear().unwrap();
    }
    #[test]
    fn opt_in_private_session_summary_roundtrip_and_unknown() {
        let _dir = TempConfigDir::new("retention-private");
        let snapshot = snapshot(1000);
        assert!(!enabled().unwrap());
        checkpoint(&snapshot).unwrap();
        assert!(!store_path().unwrap().exists());
        set_enabled(true).unwrap();
        checkpoint(&snapshot).unwrap();
        let entries = list().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].scope, "session");
        for summary in entries {
            let entry = read(&summary.id).unwrap();
            assert!(!entry.includes_paths);
            assert!(entry
                .rows
                .iter()
                .all(|row| row.project_path.is_none() && row.token_accuracy == "unclassified"));
            assert!(!serde_json::to_string(&entry).unwrap().contains("Private"));
        }
        assert!(load()
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.rows[0].total_tokens.is_none()));
    }
    #[test]
    fn latest_replaces_exactly_unchanged_skips_writes_missing_is_retained() {
        let _dir = TempConfigDir::new("retention-latest");
        set_enabled(true).unwrap();
        let mut next = snapshot(1000);
        checkpoint(&next).unwrap();
        let before = fs::read(store_path().unwrap()).unwrap();
        next.collected_at = 2000;
        checkpoint(&next).unwrap();
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
        next.collected_at = 3000;
        let row = next
            .rows
            .iter_mut()
            .find(|row| row.tool == "opencode")
            .unwrap();
        row.input = Some(1);
        row.total_tokens = Some(31);
        checkpoint(&next).unwrap();
        assert_eq!(
            load()
                .unwrap()
                .entries
                .iter()
                .find(|entry| entry.rows[0].tool == "opencode")
                .unwrap()
                .rows[0]
                .input,
            Some(1)
        );
        next.rows.clear();
        next.collected_at = 4000;
        checkpoint(&next).unwrap();
        assert_eq!(list().unwrap().len(), 2);
        set_enabled(false).unwrap();
        let before = fs::read(store_path().unwrap()).unwrap();
        checkpoint(&snapshot(5000)).unwrap();
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
    }
    #[test]
    fn source_month_partial_and_old_timestamp_stay_separate() {
        let _dir = TempConfigDir::new("retention-scopes");
        set_enabled(true).unwrap();
        let mut next = snapshot(1000);
        checkpoint(&next).unwrap();
        next.collected_at = 2000;
        next.period_key = "1970-02".into();
        for row in &mut next.rows {
            row.source_id = "home-hash".into();
            row.source_label = "目录1".into();
        }
        next.complete = false;
        checkpoint(&next).unwrap();
        assert_eq!(list().unwrap().len(), 4);
        next.collected_at = 3000;
        next.rows.truncate(1);
        checkpoint(&next).unwrap();
        assert_eq!(list().unwrap().len(), 4);
        let before = fs::read(store_path().unwrap()).unwrap();
        assert!(checkpoint(&snapshot(999)).is_err());
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
        assert_eq!(
            load()
                .unwrap()
                .entries
                .iter()
                .filter(|entry| !entry.complete)
                .count(),
            2
        );
    }
    #[test]
    fn capacity_keeps_existing_updates_and_only_rejects_new_sessions() {
        let _dir = TempConfigDir::new("retention-limits");
        set_enabled(true).unwrap();
        let mut next = snapshot(1000);
        next.rows.truncate(1);
        for index in 0..MAX_ENTRIES {
            next.rows[0].session_id = format!("s{index}");
            checkpoint(&next).unwrap();
        }
        assert_eq!(capacity().unwrap().remaining_entries, 0);
        let before = fs::read(store_path().unwrap()).unwrap();
        // 新会话在满额时被单独拒绝，已存在会话仍能更新（不是整批失败）。
        next.rows[0].session_id = "overflow".into();
        let outcome = checkpoint(&next).unwrap();
        assert_eq!(outcome.skipped, 1);
        assert!(!outcome.failed);
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
        // 已存在的会话继续更新并落盘。
        next.rows[0].session_id = "s0".into();
        next.collected_at = 2000;
        next.rows[0].input = Some(7);
        next.rows[0].total_tokens = Some(37);
        let outcome = checkpoint(&next).unwrap();
        assert_eq!(outcome.written, 1);
        assert_eq!(outcome.skipped, 0);
        assert_eq!(
            read(&list().unwrap()[0].id).unwrap().rows[0].input,
            Some(7),
            "满额时已存在会话的更新必须落盘"
        );
        for data in [
            b"broken".to_vec(),
            br#"{"schemaVersion":2,"entries":[]}"#.to_vec(),
            vec![b' '; MAX_BYTES + 1],
        ] {
            fs::write(store_path().unwrap(), &data).unwrap();
            assert!(checkpoint(&next).is_err());
            assert_eq!(fs::read(store_path().unwrap()).unwrap(), data);
            clear().unwrap();
        }
    }
    #[test]
    fn write_failure_scoped_delete_clear_and_policy_repair() {
        let dir = TempConfigDir::new("retention-io");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        let entries = list().unwrap();
        let before = fs::read(store_path().unwrap()).unwrap();
        let temp = store_path().unwrap().with_extension("tmp");
        fs::create_dir(&temp).unwrap();
        let mut next = snapshot(2000);
        next.rows[0].input = Some(2);
        let outcome = checkpoint(&next).unwrap();
        assert!(outcome.failed, "写盘失败必须如实报告，不能假装成功");
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
        fs::remove_dir(temp).unwrap();
        fs::write(dir.join("tool.log"), b"keep").unwrap();
        fs::write(dir.join("local-usage-archive.json"), b"manual-keep").unwrap();
        assert!(delete("../tool.log").is_err());
        delete(&entries[0].id).unwrap();
        assert_eq!(list().unwrap().len(), 1);
        clear().unwrap();
        assert!(enabled().unwrap());
        assert_eq!(fs::read(dir.join("tool.log")).unwrap(), b"keep");
        assert_eq!(
            fs::read(dir.join("local-usage-archive.json")).unwrap(),
            b"manual-keep"
        );
        fs::write(enabled_path().unwrap(), b"bad").unwrap();
        assert!(enabled().is_err());
        set_enabled(false).unwrap();
        assert!(!enabled().unwrap());
    }
    #[test]
    fn tampered_slot_or_full_paths_are_rejected() {
        let _dir = TempConfigDir::new("retention-tamper");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        let before = fs::read(store_path().unwrap()).unwrap();
        for field in ["id", "scope", "includesPaths"] {
            let mut value: serde_json::Value = serde_json::from_slice(&before).unwrap();
            value["entries"][0][field] = match field {
                "id" => serde_json::json!("a".repeat(64)),
                "scope" => serde_json::json!("all"),
                _ => serde_json::json!(true),
            };
            fs::write(store_path().unwrap(), serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(list().is_err());
        }
    }
}
