//! Opt-in latest observed session checkpoints. Never infer deletion or merge
//! retained sessions into live totals. Background collection is a separate feature.
use crate::{
    local_archive::{
        normalize_quality, quality_evidence, sanitized_rows, summary, valid_entry, ArchiveEntry,
        ArchiveSummary,
    },
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
/// 复评 T01：留存库 schema 版本。
///
/// - **v1**：ID = SHA256(JSON([period, source, tool, session]))，行内没有
///   client 身份（第九轮之前的格式）。
/// - **v2**：ID = SHA256(JSON([period, source, tool, **client**, session]))，
///   行内带 `clientId`。
///
/// 第九轮把 ID 改成五元组却仍写 schema 1，导致任何**旧**留存库在 `valid()`
/// 里都算不出匹配 ID，整个 store 被拒读（历史不可读、后续留存停止）。
/// 现在显式区分版本，并保留 v1 的校验路径。
const SCHEMA_V1: u32 = 1;
const SCHEMA_V2: u32 = 2;

/// 复评 T01：v1 旧 ID（不含 client）。
fn legacy_id(period: &str, source: &str, tool: &str, session: &str) -> Result<String, String> {
    let value =
        serde_json::to_vec(&(period, source, tool, session)).map_err(|_| "留存标识不可用")?;
    Ok(format!("{:x}", Sha256::digest(value)))
}

/// 复评 N01/T01：v2 ID（含 client 身份）。
fn id(
    period: &str,
    source: &str,
    tool: &str,
    client: &str,
    session: &str,
) -> Result<String, String> {
    // 复评 N01：留存标识必须包含**client 身份** —— 原生 Claude 与多个 mirror
    // 可能在同一 source/tool 下有同名 sessionId；旧键会让它们共用一条留存，
    // 后一轮只有一个 variant 出现时就把其它会话覆盖掉（历史归属丢失）。
    let value = serde_json::to_vec(&(period, source, tool, client, session))
        .map_err(|_| "留存标识不可用")?;
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
    atomic_guarded(path, data, &|| true)
}
fn atomic_guarded(path: PathBuf, data: &[u8], current: &impl Fn() -> bool) -> Result<(), String> {
    if !current() {
        return Err("采集已失效，未提交留存".into());
    }
    fs::create_dir_all(path.parent().ok_or("留存目录不可用")?).map_err(|_| "留存目录不可用")?;
    let temp = path.with_extension("tmp");
    if !current() {
        return Err("采集已失效，未提交留存".into());
    }
    fs::write(&temp, data).map_err(|_| "留存无法保存，原记录保留")?;
    #[cfg(test)]
    if path
        .file_name()
        .is_some_and(|name| name == "local-usage-retention.json")
    {
        crate::commands::collection_test_stage("retention-temp-written");
    }
    if !current() {
        let _ = fs::remove_file(&temp);
        return Err("采集已失效，未提交留存".into());
    }
    // This is the commit boundary. An OS rename cannot be interrupted. All
    // clear/delete/disable acknowledgements wait for this same store lock, so
    // an already-entered rename finishes before those operations can succeed.
    #[cfg(test)]
    if path
        .file_name()
        .is_some_and(|name| name == "local-usage-retention.json")
    {
        crate::commands::collection_test_stage("retention-commit-entered");
    }
    fs::rename(&temp, path).map_err(|error| {
        // 复评 T12：提交失败时尽力删除临时副本，避免留下可读的元数据文件。
        let _ = fs::remove_file(&temp);
        format!("留存无法提交，原记录保留（{error}）")
    })
}
/// Wait only on a blocking worker, never while holding the collector mutex.
pub fn commit_barrier() -> Result<(), String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    Ok(())
}
#[cfg(test)]
pub(crate) fn hold_commit_lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    lock().lock().unwrap()
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
    // 复评 T01：ID 可能是 **v1 四元组**（旧库，不含 client）或 **v2 五元组**
    //（第九轮之后）。旧实现只认五元组，于是任何旧库记录都校验失败、整个
    // store 被拒读。这里两种都接受 —— 但**行内身份一致性**仍严格要求：
    // 同一条留存里的所有行必须属于同一 source/tool/session/client。
    let client = if row.client_id.is_empty() {
        row.tool.as_str()
    } else {
        row.client_id.as_str()
    };
    let unknown_id_matches = row.client_id.is_empty()
        && id(
            &entry.period_key,
            &row.source_id,
            &row.tool,
            "legacy-unknown",
            &row.session_id,
        )
        .is_ok_and(|expected| expected == entry.id);
    let id_matches = unknown_id_matches
        || id(
            &entry.period_key,
            &row.source_id,
            &row.tool,
            client,
            &row.session_id,
        )
        .is_ok_and(|expected| expected == entry.id)
        || legacy_id(
            &entry.period_key,
            &row.source_id,
            &row.tool,
            &row.session_id,
        )
        .is_ok_and(|expected| expected == entry.id);
    id_matches
        && entry.rows.iter().all(|other| {
            other.source_id == row.source_id
                && other.tool == row.tool
                && other.session_id == row.session_id
                && other.client_id == row.client_id
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
    // 复评 T01：schema 1（旧库，v1 ID）与 schema 2（v2 ID）都可读；
    // 只有真正结构损坏/版本未知才拒绝。
    if !matches!(store.schema_version, SCHEMA_V1 | SCHEMA_V2)
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
    write_guarded(store, &|| true)
}
fn write_guarded(store: &Store, current: &impl Fn() -> bool) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|_| "会话留存无法编码")?;
    if bytes.len() > MAX_BYTES {
        return Err("会话留存超过8MiB，未覆盖；请删除不需要的记录".into());
    }
    atomic_guarded(store_path()?, &bytes, current)
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
///
/// 复评 R09/F03：字节上限（8MiB）纳入**条目级**选择。复评 F03 进一步要求
/// 优先级：**先**应用已存在会话的更新（含缩小释放空间），**再**在剩余预算内
/// 接收新会话 —— 不能因键序让新条目抢占本可提交的旧更新。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CheckpointOutcome {
    /// 已写入（含内容未变的跳过写盘）。
    pub written: usize,
    /// 因条数已满而未新增的会话数。
    pub skipped: usize,
    /// 已存在会话的更新因字节预算不足而保持旧值的条目数。
    pub skipped_bytes: usize,
    /// 新会话因字节预算不足而未写入的条目数（它们没有旧值可保留）。
    pub skipped_new_bytes: usize,
    /// 写入失败（此时整批不落盘，保持原记录）。
    pub failed: bool,
}

/// 单条目的序列化体积（复评 R09 的条目级预算依据）。
/// 序列化失败按最大值处理（会被预算判定拒绝，不会污染存储）。
fn entry_size(entry: &ArchiveEntry) -> usize {
    serde_json::to_vec(entry)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

pub fn checkpoint(snapshot: &LocalSnapshot) -> Result<CheckpointOutcome, String> {
    checkpoint_budget(snapshot, MAX_BYTES)
}
pub fn checkpoint_guarded(
    snapshot: &LocalSnapshot,
    current: impl Fn() -> bool,
) -> Result<CheckpointOutcome, String> {
    checkpoint_budget_guarded(snapshot, MAX_BYTES, &current)
}

/// `budget` 可注入（测试用小预算验证条目级选择，不必构造 8MiB 级 fixture）。
fn checkpoint_budget(snapshot: &LocalSnapshot, budget: usize) -> Result<CheckpointOutcome, String> {
    checkpoint_budget_guarded(snapshot, budget, &|| true)
}
fn checkpoint_budget_guarded(
    snapshot: &LocalSnapshot,
    budget: usize,
    current: &impl Fn() -> bool,
) -> Result<CheckpointOutcome, String> {
    #[cfg(test)]
    crate::commands::collection_test_stage("retention-lock-wait");
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    if !current() {
        return Err("采集已失效，未提交留存".into());
    }
    let mut outcome = CheckpointOutcome::default();
    if !load_enabled()? {
        return Ok(outcome);
    }
    #[cfg(test)]
    crate::commands::collection_test_stage("retention-read");
    let mut store = load()?;
    if !current() {
        return Err("采集已失效，未提交留存".into());
    }
    // 复评 R09：以当前文件的**实际序列化体积**为预算基线，逐条目增量更新；
    // 最终 write 仍做精确字节检查（原子提交语义不变），这里的估算只负责
    // 把放不下的条目挑出来单独跳过。
    let mut store_size = serde_json::to_vec(&store)
        .map_err(|_| "留存数据无法编码")?
        .len();
    // 复评 N01：分组按 (source, tool, **client**, session) —— 镜像与原生
    // 的同名会话各自独立成组、各自留存。
    let mut groups: BTreeMap<(&str, &str, &str, &str), Vec<&crate::local_usage::LocalRow>> =
        BTreeMap::new();
    for row in &snapshot.rows {
        let client = if row.client_id.is_empty() {
            "legacy-unknown"
        } else {
            row.client_id.as_str()
        };
        groups
            .entry((&row.source_id, &row.tool, client, &row.session_id))
            .or_default()
            .push(row);
    }
    let mut changed = false;
    // 复评 F03/R08：**三阶段**分配，与键序无关，且增长项不会因排序而丢失。
    // 旧实现（F03）虽然先处理旧更新，但仍按 BTreeMap 键序单遍遍历：
    // 预算满时 `a`（增长 100）先被跳过，`z`（缩小 200）后成功 —— 全批其实
    // 可容纳，`a` 却保留了旧值。现在按 **size delta** 排序：
    //   阶段 1：缩小/等大的替换（释放预算）；
    //   阶段 2：增长的替换（此时预算已因缩小而放宽）；
    //   阶段 3：新增（只用真正剩余的预算）。
    let mut shrink_or_same: Vec<(usize, ArchiveEntry, usize)> = Vec::new();
    let mut grow: Vec<(usize, ArchiveEntry, usize)> = Vec::new();
    let mut additions: Vec<ArchiveEntry> = Vec::new();
    let (quality_evidence_recorded, quality_warnings) = quality_evidence(
        snapshot.quality_evidence_recorded,
        &snapshot.quality_warnings,
    );
    for ((source, tool, client, session), rows) in groups {
        let entry = ArchiveEntry {
            // 复评 T05：留存同样保留质量证据。
            quality_evidence_recorded,
            quality_warnings: quality_warnings.clone(),
            id: id(&snapshot.period_key, source, tool, client, session)?,
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
        let index = store.entries.iter().position(|p| p.id == entry.id);
        let Some(index) = index else {
            additions.push(entry);
            continue;
        };
        let previous = &store.entries[index];
        if entry.collected_at < previous.collected_at {
            return Err("采集时间早于已有留存，未改写；请核对系统时间".into());
        }
        if previous.rows == entry.rows
            && previous.complete == entry.complete
            && quality_evidence(
                previous.quality_evidence_recorded,
                &previous.quality_warnings,
            ) == (
                entry.quality_evidence_recorded,
                entry.quality_warnings.clone(),
            )
            && previous.engine_version == entry.engine_version
            && previous.accounting_utc_offset_seconds == entry.accounting_utc_offset_seconds
        {
            outcome.written += 1;
            continue;
        }
        let new_size = entry_size(&entry);
        let old_size = entry_size(previous);
        // 替换不改变 JSON 结构开销：体积差 = 新条目 − 旧条目（精确）。
        if new_size <= old_size {
            shrink_or_same.push((old_size - new_size, entry, index));
        } else {
            grow.push((new_size - old_size, entry, index));
        }
    }
    // 阶段 1：缩小/等大 —— 总是允许，且释放预算给增长项与新增。
    // 释放多的排前面，让后续增长项更容易被容纳（与键序无关）。
    shrink_or_same.sort_by_key(|item| std::cmp::Reverse(item.0));
    for (freed, entry, index) in shrink_or_same {
        store_size = store_size.saturating_sub(freed);
        store.entries[index] = entry;
        outcome.written += 1;
        changed = true;
    }
    // 阶段 2：增长 —— 按增量从小到大尝试，最大化可容纳的旧更新条数。
    grow.sort_by_key(|item| item.0);
    for (delta, entry, index) in grow {
        if store_size + delta > budget {
            // 该条自身扩大到超限：跳过并保持旧值，不拖累其他条目。
            outcome.skipped_bytes += 1;
            continue;
        }
        store_size += delta;
        store.entries[index] = entry;
        outcome.written += 1;
        changed = true;
    }
    // 阶段 3：新增按字节预算逐个接收；条数上限单独计 `skipped`。
    for entry in additions {
        if store.entries.len() >= MAX_ENTRIES {
            outcome.skipped += 1;
            continue;
        }
        let new_size = entry_size(&entry);
        // +1 ≈ JSON 数组追加一个元素的逗号开销；首条追加会高估，方向保守。
        if store_size + new_size.saturating_add(1) > budget {
            // 字节预算放不下这条新会话 —— 单独跳过（它没有旧值可保留）。
            outcome.skipped_new_bytes += 1;
            continue;
        }
        store_size += new_size.saturating_add(1);
        store.entries.push(entry);
        outcome.written += 1;
        changed = true;
    }
    if changed && write_guarded(&store, current).is_err() {
        // 写盘失败：整批未提交，原记录保留，如实报告。
        // 复评 R09/F03：条目级预算选择后这里只剩真实 IO 失败或极端漂移。
        outcome.failed = true;
        return Ok(outcome);
    }
    Ok(outcome)
}
pub fn list() -> Result<Vec<ArchiveSummary>, String> {
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    let mut entries = load()?.entries;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at));
    Ok(entries.into_iter().map(summary).collect())
}
pub fn read(id: &str) -> Result<ArchiveEntry, String> {
    validate_id(id)?;
    let _guard = lock().lock().map_err(|_| "留存状态不可用")?;
    load()?
        .entries
        .into_iter()
        .find(|entry| entry.id == id)
        .map(|mut entry| {
            normalize_quality(&mut entry);
            entry
        })
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

    // ---------- 复评 R09：字节预算的条目级选择 ----------

    #[test]
    fn r09_预算内旧会话更新保留_放不下的新增单独跳过() {
        let _dir = TempConfigDir::new("retention-budget");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        let baseline = fs::read(store_path().unwrap()).unwrap().len();
        // 收紧预算：只留 1 字节余量 —— 旧会话 s1 的更新（同位数字，体积不变）
        // 放得下；新会话 s3（整条都要新增）放不下。
        let budget = baseline + 1;
        let next = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"opencode","sessionId":"s1","workspaceKey":"w1","model":"deepseek","input":101,"output":20,"reasoning":0,"cacheRead":10,"cacheWrite":0},
                {"client":"claude","sessionId":"s3","workspaceKey":"w1","model":"deepseek","input":5,"output":5,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}],"sessions":[]}),
            2000,
        )
        .unwrap();
        let outcome = checkpoint_budget(&next, budget).unwrap();
        assert_eq!(outcome.written, 1, "只有旧会话 s1 的更新被保存");
        assert_eq!(outcome.skipped_new_bytes, 1, "放不下的新会话 s3 单独跳过");
        assert_eq!(outcome.skipped, 0);
        assert!(!outcome.failed, "条目级选择后不应整批失败");
        let store = load().unwrap();
        assert_eq!(
            store
                .entries
                .iter()
                .find(|entry| entry.rows[0].session_id == "s1")
                .unwrap()
                .rows[0]
                .input,
            Some(101),
            "本可提交的旧会话更新必须落盘"
        );
        assert!(
            store
                .entries
                .iter()
                .all(|entry| entry.rows[0].session_id != "s3"),
            "放不下的新会话不得写入"
        );
        // 预算放宽后同一批次可以完整保存：新会话补上。
        let relaxed = checkpoint_budget(&next, usize::MAX).unwrap();
        assert_eq!(relaxed.skipped_new_bytes, 0);
        assert!(load()
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.rows[0].session_id == "s3"));
    }

    // ---------- 第九轮复评 N01：镜像会话身份贯穿留存 ----------

    #[test]
    fn n01_同源原生与两个镜像的同名会话各自留存() {
        // 评审触发：同一 sourceId 下原生 Claude 与两个 mirror 有相同 sessionId。
        // 旧实现按 (source, tool, session) 分组 → 3 行合并成 1 条留存，
        // 后一轮只有 1 个 variant 出现时就把另外两个覆盖掉（历史丢失）。
        let _dir = TempConfigDir::new("retention-client-id");
        set_enabled(true).unwrap();
        let snapshot = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"claude","sessionId":"s1","model":"deepseek-flash","input":10,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0},
                {"client":"claude-mirror","sessionId":"s1","model":"deepseek-flash","input":20,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0},
                {"client":"cc-mirror:variant-b","sessionId":"s1","model":"deepseek-flash","input":30,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[],"sessions":[]}),
            1000,
        )
        .unwrap();
        assert_eq!(snapshot.rows.len(), 3, "三条行都必须被接受");
        checkpoint(&snapshot).unwrap();
        assert_eq!(
            list().unwrap().len(),
            3,
            "原生 + 两个镜像的同名会话必须是 3 条独立留存"
        );
        // 后一轮只有其中一个 variant 出现：不得覆盖其它两条。
        let partial = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"claude-mirror","sessionId":"s1","model":"deepseek-flash","input":25,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[],"sessions":[]}),
            2000,
        )
        .unwrap();
        checkpoint(&partial).unwrap();
        let store = load().unwrap();
        assert_eq!(store.entries.len(), 3, "缺席的会话不能被删除或合并");
        let clients: std::collections::BTreeSet<_> = store
            .entries
            .iter()
            .map(|entry| entry.rows[0].client_id.clone())
            .collect();
        assert_eq!(clients.len(), 3, "三个 client 身份各自保留");
        // 只有 claude-mirror 那一条被更新。
        let updated = store
            .entries
            .iter()
            .find(|entry| entry.rows[0].client_id == "claude-mirror")
            .unwrap();
        assert_eq!(updated.collected_at, 2000);
    }

    // ---------- 第十轮复评 T01：旧库（v1 四元组 ID）升级不拒读 ----------

    #[test]
    fn t01_旧schema库仍可读取且新写入使用新身份() {
        let _dir = TempConfigDir::new("retention-legacy");
        set_enabled(true).unwrap();
        // 手工构造一份**旧格式** store：schema 1 + 四元组 ID + 无 clientId。
        let first = snapshot(1000);
        let mut entries: Vec<ArchiveEntry> = Vec::new();
        for row in &first.rows {
            let legacy = legacy_id(
                &first.period_key,
                &row.source_id,
                &row.tool,
                &row.session_id,
            )
            .unwrap();
            let mut cloned = row.clone();
            cloned.client_id = String::new();
            entries.push(ArchiveEntry {
                quality_evidence_recorded: false,
                quality_warnings: Vec::new(),
                id: legacy,
                saved_at: first.collected_at,
                collected_at: first.collected_at,
                period_key: first.period_key.clone(),
                accounting_utc_offset_seconds: first.accounting_utc_offset_seconds,
                engine_version: first.engine_version.clone(),
                scope: "session".into(),
                includes_paths: false,
                complete: first.complete,
                stale: false,
                rows: sanitized_rows(vec![&cloned], false),
            });
        }
        let legacy_store = Store {
            schema_version: SCHEMA_V1,
            entries,
        };
        let mut legacy_json = serde_json::to_value(&legacy_store).unwrap();
        for entry in legacy_json["entries"].as_array_mut().unwrap() {
            entry
                .as_object_mut()
                .unwrap()
                .remove("qualityEvidenceRecorded");
            entry.as_object_mut().unwrap().remove("qualityWarnings");
            for row in entry["rows"].as_array_mut().unwrap() {
                row.as_object_mut().unwrap().remove("clientId");
            }
        }
        std::fs::write(
            store_path().unwrap(),
            serde_json::to_vec(&legacy_json).unwrap(),
        )
        .unwrap();
        // 旧库必须可读（第九轮会整体拒读）。
        let loaded = load().expect("旧 schema 库必须可读");
        assert_eq!(loaded.entries.len(), 2, "旧库记录全部保留");
        let summaries = list().unwrap();
        assert_eq!(summaries.len(), 2, "旧库列表可用");
        assert!(summaries.iter().all(|entry| entry.client_id.is_none()
            && entry.identity_status == "unknown"
            && !entry.quality_evidence_recorded));
        assert!(loaded
            .entries
            .iter()
            .all(|entry| entry.rows.iter().all(|row| row.client_id.is_empty())));
        // 新采集写入用 v2 身份，且不覆盖旧记录。
        let next = snapshot(2000);
        checkpoint(&next).unwrap();
        let store = load().unwrap();
        assert!(
            store.entries.iter().any(|entry| {
                legacy_id(
                    &entry.period_key,
                    &entry.rows[0].source_id,
                    &entry.rows[0].tool,
                    &entry.rows[0].session_id,
                )
                .is_ok_and(|expected| expected == entry.id)
            }),
            "旧记录仍以 v1 身份存在，未被新写入挤掉"
        );
        assert!(
            store.entries.iter().any(|entry| {
                id(
                    &entry.period_key,
                    &entry.rows[0].source_id,
                    &entry.rows[0].tool,
                    &entry.rows[0].client_id,
                    &entry.rows[0].session_id,
                )
                .is_ok_and(|expected| expected == entry.id)
            }),
            "新记录使用 v2 身份"
        );
    }

    // ---------- 第七轮复评 F03：旧更新优先于新增 ----------

    #[test]
    fn f03_新增键排在旧更新之前_旧更新仍优先落盘() {
        // 复评 F03 的最小反例：新增会话的键（claude）排在既有会话（opencode）
        // 之前。旧实现按 BTreeMap 键序处理，新增先占预算、旧更新被挤掉。
        // 修复后两阶段分配：旧更新先应用，新增只用剩余预算。
        let _dir = TempConfigDir::new("retention-priority");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        let baseline = fs::read(store_path().unwrap()).unwrap().len();
        // 构造评审的最小反例：新增（claude，键序在前）约 300 字节，
        // 既有会话更新（opencode）约 300 字节，预算只够其中一项。
        // 旧实现按键序先给新增 → 旧更新被挤成 skipped_bytes（collected_at 停在 1000）；
        // 修复后先应用旧更新 → 新增被 skipped_new_bytes 拒绝。
        let padded = "m".repeat(260);
        let grow = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"opencode","sessionId":"s1","workspaceKey":"w1","model":padded,"input":100,"output":20,"reasoning":0,"cacheRead":10,"cacheWrite":0},
                {"client":"claude","sessionId":"s3","workspaceKey":"w1","model":"deepseek-claude","input":5,"output":5,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}],"sessions":[]}),
            2000,
        )
        .unwrap();
        // 预算 = 基线 + 约一项的增量（不足以同时容纳两项）。
        let outcome = checkpoint_budget(&grow, baseline + 320).unwrap();
        let store = load().unwrap();
        let existing = store
            .entries
            .iter()
            .find(|entry| entry.rows[0].session_id == "s1")
            .unwrap();
        assert_eq!(
            existing.collected_at, 2000,
            "既有会话的更新必须优先于新增落盘（旧实现会被新增挤掉）"
        );
        assert!(
            store
                .entries
                .iter()
                .all(|entry| entry.rows[0].session_id != "s3"),
            "剩余预算不足时新增被跳过"
        );
        assert!(
            outcome.skipped_new_bytes >= 1,
            "新增因字节预算被跳过并单独计数：{outcome:?}"
        );
        assert_eq!(outcome.skipped_bytes, 0, "旧更新不应被跳过");
    }

    #[test]
    fn f03_旧条目缩小释放空间_新增可进入() {
        let _dir = TempConfigDir::new("retention-shrink");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        let baseline = fs::read(store_path().unwrap()).unwrap().len();
        // 用极小预算：只允许缩小的更新 + 少量新增。
        let mut shrink = snapshot(2000);
        shrink.rows.retain(|row| row.tool == "opencode");
        for row in &mut shrink.rows {
            row.model = "s".into();
        }
        let outcome = checkpoint_budget(&shrink, baseline).unwrap();
        assert!(
            outcome.written >= 1,
            "缩小（或不变）的旧条目更新必须被应用：{outcome:?}"
        );
        assert!(!outcome.failed);
        assert_eq!(outcome.skipped_bytes, 0, "缩小的旧更新不该被跳过");
    }

    // ---------- 第八轮复评 R08：增长项不能因键序/排序被缩小项挤掉 ----------

    #[test]
    fn r08_满预算下增长与缩小同时存在_两项都应更新() {
        // 评审反例：预算已满，`a`（增长）按键序先处理被跳过，`z`（缩小）
        // 后成功 —— 全批其实可容纳。三阶段（缩小/等大 → 增长 → 新增）
        // 让缩小先释放预算，增长项随后即可容纳，`skipped_bytes` 应为 0。
        let _dir = TempConfigDir::new("retention-delta");
        set_enabled(true).unwrap();
        checkpoint(&snapshot(1000)).unwrap();
        // 两个既有会话：一个（claude）本轮增长，一个（opencode）本轮缩小。
        let first = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"claude","sessionId":"s-grow","workspaceKey":"w1","model":"m","input":10,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0},
                {"client":"opencode","sessionId":"s-shrink","workspaceKey":"w1","model":"LONGPADDINGPADDINGPADDINGPADDINGPADDING","input":10,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}],"sessions":[]}),
            1000,
        )
        .unwrap();
        checkpoint_budget(&first, usize::MAX).unwrap();
        let baseline = fs::read(store_path().unwrap()).unwrap().len();
        // 下一轮：claude 增长（模型名变长），opencode 缩小（模型名变短）。
        let next = crate::local_usage::normalize_report(
            &serde_json::json!({"entries":[
                {"client":"claude","sessionId":"s-grow","workspaceKey":"w1","model":"m","input":11,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0},
                {"client":"opencode","sessionId":"s-shrink","workspaceKey":"w1","model":"s","input":10,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0}
            ],"workspaces":[{"workspaceKey":"w1","path":"D:\\Private\\Repo"}],"sessions":[]}),
            2000,
        )
        .unwrap();
        // 预算保持原文件大小：增长需要空间，只有缩小先释放才够。
        let outcome = checkpoint_budget(&next, baseline).unwrap();
        assert_eq!(outcome.written, 2, "两项都应更新：{outcome:?}");
        assert_eq!(
            outcome.skipped_bytes, 0,
            "缩小先释放预算后，增长项不应被跳过：{outcome:?}"
        );
        assert!(!outcome.failed);
        let store = load().unwrap();
        assert!(store
            .entries
            .iter()
            .any(|entry| entry.rows[0].session_id == "s-grow"
                && entry.rows[0].model.starts_with("m")));
        assert!(store
            .entries
            .iter()
            .any(|entry| entry.rows[0].session_id == "s-shrink" && entry.rows[0].model == "s"));
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
            // 复评 T01：schema 1/2 都是合法版本，这里用**未知版本**验证拒绝路径。
            br#"{"schemaVersion":99,"entries":[]}"#.to_vec(),
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
    #[test]
    fn r02_quality_only_add_clear_and_unknown_to_recorded_are_persisted() {
        let _dir = TempConfigDir::new("retention-quality-chain");
        set_enabled(true).unwrap();
        let mut first = snapshot(1000);
        first.quality_evidence_recorded = false;
        checkpoint(&first).unwrap();
        assert!(list()
            .unwrap()
            .iter()
            .all(|entry| !entry.quality_evidence_recorded));
        let mut next = first.clone();
        next.collected_at = 2000;
        next.quality_evidence_recorded = true;
        checkpoint(&next).unwrap();
        assert!(list()
            .unwrap()
            .iter()
            .all(|entry| entry.quality_evidence_recorded && entry.collected_at == 2000));
        next.collected_at = 3000;
        next.quality_warnings = vec![
            "overlap_partial".into(),
            "future_risk".into(),
            "overlap_partial".into(),
        ];
        checkpoint(&next).unwrap();
        for entry in list().unwrap() {
            assert_eq!(
                entry.quality_warnings,
                vec!["future_risk", "overlap_partial"]
            );
            assert_eq!(
                read(&entry.id).unwrap().quality_warnings,
                entry.quality_warnings
            );
            assert_eq!(entry.collected_at, 3000);
        }
        let before = fs::read(store_path().unwrap()).unwrap();
        next.collected_at = 4000;
        next.quality_warnings = vec!["future_risk".into(), "overlap_partial".into()];
        checkpoint(&next).unwrap();
        assert_eq!(
            fs::read(store_path().unwrap()).unwrap(),
            before,
            "ordering/duplicate-only changes are equivalent"
        );
        next.quality_warnings.clear();
        checkpoint(&next).unwrap();
        for entry in list().unwrap() {
            assert!(entry.quality_evidence_recorded);
            assert!(entry.quality_warnings.is_empty());
            assert_eq!(entry.collected_at, 4000);
        }
    }

    #[test]
    fn r02_quality_growth_over_budget_reports_unsaved_and_preserves_old_bytes() {
        let _dir = TempConfigDir::new("retention-quality-capacity");
        set_enabled(true).unwrap();
        let mut first = snapshot(1000);
        first.quality_evidence_recorded = true;
        checkpoint(&first).unwrap();
        let before = fs::read(store_path().unwrap()).unwrap();
        let mut next = first.clone();
        next.collected_at = 2000;
        next.quality_warnings = vec!["overlap_partial".into()];
        let outcome = checkpoint_budget(&next, before.len()).unwrap();
        assert_eq!(outcome.written, 0);
        assert_eq!(outcome.skipped_bytes, first.rows.len());
        assert_eq!(fs::read(store_path().unwrap()).unwrap(), before);
        let retried = checkpoint(&next).unwrap();
        assert_eq!(retried.written, first.rows.len());
        assert_eq!(retried.skipped_bytes, 0);
        assert!(list()
            .unwrap()
            .iter()
            .all(|entry| entry.quality_warnings == ["overlap_partial"]));
    }

    #[test]
    fn r02_near_limit_legacy_retention_deletes_and_updates_without_expansion() {
        let _dir = TempConfigDir::new("retention-legacy-capacity");
        set_enabled(true).unwrap();
        let mut snap = snapshot(1000);
        snap.rows.truncate(1);
        checkpoint(&snap).unwrap();
        let template = load().unwrap().entries.remove(0);
        let mut entries = vec![template; MAX_ENTRIES];
        for (index, entry) in entries.iter_mut().enumerate() {
            let row = &mut entry.rows[0];
            row.session_id = format!("old-{index}");
            row.model = "m".into();
            row.client_id.clear();
            entry.id = legacy_id(
                &entry.period_key,
                &row.source_id,
                &row.tool,
                &row.session_id,
            )
            .unwrap();
            entry.quality_evidence_recorded = false;
            entry.quality_warnings.clear();
        }
        // Schema 1 historically contains both original four-part IDs and newer
        // five-part IDs. Keep one small known session to exercise an update.
        let current = &mut entries[1];
        current.rows[0].client_id = snap.rows[0].client_id.clone();
        current.id = id(
            &current.period_key,
            &current.rows[0].source_id,
            &current.rows[0].tool,
            &current.rows[0].client_id,
            &current.rows[0].session_id,
        )
        .unwrap();
        let updated_id = current.id.clone();
        // Old nonempty evidence is exposed as recorded but must not grow every
        // persisted legacy entry during an unrelated deletion.
        for entry in &mut entries[2..] {
            entry.quality_warnings = vec!["overlap_partial".into()];
        }
        crate::local_archive::fill_legacy_fixture(&mut entries, MAX_BYTES - 128);
        let remove = entries.last().unwrap().id.clone();
        let survivor = entries[0].id.clone();
        let current_row = entries[1].rows[0].clone();
        let bytes = serde_json::to_vec(&Store {
            schema_version: 1,
            entries,
        })
        .unwrap();
        assert_eq!(bytes.len(), MAX_BYTES - 128);
        assert!(!std::str::from_utf8(&bytes)
            .unwrap()
            .contains("qualityEvidenceRecorded"));
        fs::write(store_path().unwrap(), &bytes).unwrap();
        assert_eq!(list().unwrap().len(), MAX_ENTRIES);
        delete(&remove).expect("deleting a small old session must not grow every survivor");
        let after_delete = fs::read(store_path().unwrap()).unwrap();
        assert!(!std::str::from_utf8(&after_delete)
            .unwrap()
            .contains("qualityEvidenceRecorded"));
        assert!(read(&survivor)
            .unwrap()
            .rows
            .iter()
            .all(|row| row.client_id.is_empty()));
        assert!(!read(&survivor).unwrap().quality_evidence_recorded);
        snap.rows[0].session_id = current_row.session_id;
        snap.rows[0].model = current_row.model;
        snap.rows[0].input = Some(7);
        snap.rows[0].total_tokens = Some(37);
        snap.collected_at = 2000;
        snap.quality_evidence_recorded = true;
        let outcome = checkpoint(&snap).unwrap();
        assert_eq!(outcome.written, 1);
        assert_eq!(outcome.skipped_bytes, 0);
        assert!(!outcome.failed);
        let updated = read(&updated_id).unwrap();
        assert_eq!(updated.rows[0].input, Some(7));
        assert!(updated.quality_evidence_recorded);
        assert_eq!(list().unwrap().len(), MAX_ENTRIES - 1);
        assert!(fs::metadata(store_path().unwrap()).unwrap().len() <= MAX_BYTES as u64);
    }
}
