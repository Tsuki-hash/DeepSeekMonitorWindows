//! ZCode SQLite metadata adapter. Normalization follows pinned Tokscale
//! d5e8ad9b sessions/zcode.rs; no transcript/title/agent/credential query.
//! Adapted normalization: Copyright (c) 2025 Junho Yeo, MIT.
//! Bundled notice: resources/local-usage/LICENSE-tokscale.txt.
use crate::local_usage::{normalize_report, LocalSnapshot};
use chrono::{Datelike, Local, TimeZone};
use rusqlite::{config::DbConfig, limits::Limit, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_ROWS: usize = 50000;
const MAX_METADATA: usize = 16 * 1024 * 1024;
const READ_ERROR: &str = "ZCode数据库读取失败，请检查文件、结构和占用状态";
pub const ADAPTER_VERSION: &str = "d5e8ad9b+zcode-sqlite-v1";
fn reader_slot() -> &'static Arc<tokio::sync::Semaphore> {
    static SLOT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
pub async fn collect(path: PathBuf) -> Result<LocalSnapshot, String> {
    let permit = reader_slot()
        .clone()
        .try_acquire_owned()
        .map_err(|_| "ZCode上次读取尚未结束，请稍后重试")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟异常")?
        .as_millis() as u64;
    let task = tokio::task::spawn_blocking(move || {
        // Keep the single reader slot until the actual worker exits, even if
        // timeout/cancellation drops the caller while an OS read is blocked.
        let _permit = permit;
        read(
            &path,
            now,
            cancelled,
            Instant::now() + Duration::from_secs(30),
        )
    });
    tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .map_err(|_| "ZCode读取超时，已请求停止")?
        .map_err(|_| "ZCode读取任务不可用")?
}
fn checked_add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a.zip(b)
        .and_then(|(a, b)| a.checked_add(b))
        .filter(|value| *value <= SAFE)
}
fn token(value: Option<i64>) -> Option<u64> {
    value
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value <= SAFE)
}
fn text(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("ZCode元数据字段过长或不可用".into());
    }
    Ok(Some(value.trim().to_owned()))
}
fn schema(conn: &Connection, table: &str) -> Result<BTreeSet<String>, String> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )
        .map_err(|_| "ZCode用量表结构不兼容")?;
    if sql.to_ascii_uppercase().contains("VIRTUAL TABLE") {
        return Err("不支持虚拟ZCode用量表".into());
    }
    // table is one of two constants from this module, never user text.
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| READ_ERROR)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| READ_ERROR)?;
    let mut fields = BTreeSet::new();
    for row in rows {
        fields.insert(row.map_err(|_| READ_ERROR)?);
        if fields.len() > 128 {
            return Err("ZCode用量表字段过多".into());
        }
    }
    Ok(fields)
}
fn month_range(now: u64) -> Result<(i64, i64), String> {
    let date =
        chrono::DateTime::from_timestamp_millis(i64::try_from(now).map_err(|_| "采集时间不可用")?)
            .ok_or("采集时间不可用")?
            .with_timezone(&Local);
    let start = Local
        .with_ymd_and_hms(date.year(), date.month(), 1, 0, 0, 0)
        .single()
        .ok_or("本地月份起点不明确")?;
    let (year, month) = if date.month() == 12 {
        (date.year() + 1, 1)
    } else {
        (date.year(), date.month() + 1)
    };
    let end = Local
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .ok_or("本地月份终点不明确")?;
    Ok((start.timestamp_millis(), end.timestamp_millis()))
}
#[derive(Default)]
struct Group {
    fields: [Option<u64>; 5],
    count: u64,
    timed_tokens: Option<u64>,
    duration: Option<u64>,
    project: Option<String>,
    has_timed: bool,
}
fn read(
    path: &Path,
    now: u64,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
) -> Result<LocalSnapshot, String> {
    if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
        return Err("ZCode读取已取消或超时".into());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| READ_ERROR)?;
    conn.busy_timeout(Duration::from_millis(500))
        .map_err(|_| READ_ERROR)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|_| READ_ERROR)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(|_| READ_ERROR)?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, 128 * 1024)
        .map_err(|_| READ_ERROR)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
        .map_err(|_| READ_ERROR)?;
    let stop = cancelled.clone();
    conn.progress_handler(
        1000,
        Some(move || stop.load(Ordering::Relaxed) || Instant::now() >= deadline),
    )
    .map_err(|_| READ_ERROR)?;
    conn.execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED;")
        .map_err(|_| READ_ERROR)?;
    let columns = schema(&conn, "model_usage")?;
    if [
        "id",
        "session_id",
        "model_id",
        "started_at",
        "completed_at",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .any(|field| !columns.contains(*field))
    {
        return Err("ZCode用量表结构不兼容".into());
    }
    let has_total = columns.contains("computed_total_tokens");
    // Missing session metadata must never change modern vs legacy token rules.
    let session_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| READ_ERROR)?;
    let (join, project) = if session_exists {
        let fields = schema(&conn, "session")?;
        if fields.contains("id") && fields.contains("directory") && fields.contains("path") {
            (
                "LEFT JOIN session s ON s.id=mu.session_id",
                "COALESCE(NULLIF(s.directory,''),NULLIF(s.path,''))",
            )
        } else {
            ("", "NULL")
        }
    } else {
        ("", "NULL")
    };
    let fallback = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|time| i64::try_from(time.as_millis()).ok())
        .ok_or("ZCode文件时间不可用")?;
    let anchor="CASE WHEN mu.started_at>0 THEN mu.started_at WHEN mu.completed_at IS NOT NULL THEN CASE WHEN mu.duration_ms>0 AND mu.completed_at-mu.duration_ms>0 THEN mu.completed_at-mu.duration_ms ELSE mu.completed_at END ELSE ?1 END";
    let query=format!("SELECT mu.session_id,mu.model_id,{project},mu.input_tokens,mu.output_tokens,mu.cache_read_input_tokens,mu.cache_creation_input_tokens,mu.reasoning_tokens,{},mu.duration_ms,{anchor},mu.id FROM model_usage mu {join} WHERE ({anchor})>=?2 AND ({anchor})<?3 LIMIT 50001",if has_total {"mu.computed_total_tokens"}else{"NULL"});
    let mut stmt = conn.prepare(&query).map_err(|_| READ_ERROR)?;
    let (start, end) = month_range(now)?;
    let mut rows = stmt
        .query(rusqlite::params![fallback, start, end])
        .map_err(|_| READ_ERROR)?;
    let mut groups: BTreeMap<(String, String, Option<String>), Group> = BTreeMap::new();
    let mut session_times: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut read_rows = 0;
    let mut metadata_size = 0;
    while let Some(row) = rows.next().map_err(|_| READ_ERROR)? {
        read_rows += 1;
        if read_rows > MAX_ROWS {
            return Err("ZCode本月记录超过5万条，请缩小来源".into());
        }
        if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
            return Err("ZCode读取已取消或超时".into());
        }
        let session =
            text(row.get(0).map_err(|_| READ_ERROR)?)?.unwrap_or_else(|| "unknown".into());
        let model = text(row.get(1).map_err(|_| READ_ERROR)?)?
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase();
        if model.len() > 2048 {
            return Err("ZCode模型字段过长".into());
        }
        let project = text(row.get(2).map_err(|_| READ_ERROR)?)?;
        let mut fields = [None; 5];
        for (index, field) in fields.iter_mut().enumerate() {
            *field = token(row.get(index + 3).map_err(|_| READ_ERROR)?);
        }
        let total = token(row.get(8).map_err(|_| READ_ERROR)?);
        let overlap = checked_add(fields[2], fields[3]);
        let inclusive = checked_add(fields[0], fields[1]);
        let exclusive = checked_add(checked_add(inclusive, overlap), fields[4]);
        if !has_total
            || (total.is_some() && total == inclusive && total != exclusive && exclusive.is_some())
        {
            fields[0] = fields[0]
                .zip(overlap)
                .map(|(value, overlap)| value.saturating_sub(overlap));
            fields[1] = fields[1]
                .zip(fields[4])
                .map(|(value, overlap)| value.saturating_sub(overlap));
        }
        if fields.iter().all(|field| *field == Some(0)) {
            continue;
        }
        // Bound output metadata, not transcript bodies. Repeated key text is
        // deliberately counted conservatively to keep total decoding bounded.
        let identity =
            text(row.get(11).map_err(|_| READ_ERROR)?)?.ok_or("ZCode记录缺少稳定标识")?;
        metadata_size += identity.len()
            + session.len()
            + model.len()
            + project.as_ref().map_or(0, String::len)
            + 256;
        if metadata_size > MAX_METADATA {
            return Err("ZCode用量元数据超过16MiB限制".into());
        }
        // A malformed session table can duplicate joined rows; reject rather
        // than turn a many-to-one join into doubled usage.
        if !seen.insert(identity) {
            return Err("ZCode记录标识重复或会话关联不唯一，未接收重复结果".into());
        }
        let duration = token(row.get(9).map_err(|_| READ_ERROR)?).filter(|value| *value > 0);
        let timestamp: u64 = u64::try_from(row.get::<_, i64>(10).map_err(|_| READ_ERROR)?)
            .map_err(|_| "ZCode记录时间不可用")?;
        session_times
            .entry(session.clone())
            .and_modify(|times| {
                times.0 = times.0.min(timestamp);
                times.1 = times.1.max(timestamp);
            })
            .or_insert((timestamp, timestamp));
        let project_key = project.as_ref().map(|path| {
            let path = path.replace('\\', "/").trim_end_matches('/').to_string();
            if path.starts_with('/') && !path.starts_with("//") {
                path
            } else {
                path.to_lowercase()
            }
        });
        let group = groups
            .entry((session, model, project_key))
            .or_insert_with(|| Group {
                fields: [Some(0); 5],
                timed_tokens: Some(0),
                duration: Some(0),
                project,
                ..Default::default()
            });
        group.count += 1;
        for (aggregate, value) in group.fields.iter_mut().zip(fields) {
            *aggregate = checked_add(*aggregate, value);
        }
        let sum = fields.into_iter().fold(Some(0), checked_add);
        if let (Some(sum), Some(duration)) = (sum, duration) {
            group.has_timed = true;
            group.timed_tokens = checked_add(group.timed_tokens, Some(sum));
            group.duration = checked_add(group.duration, Some(duration));
        }
    }
    let mut workspaces = BTreeMap::new();
    let mut entries = Vec::new();
    for ((session, model, project_key), group) in groups {
        let workspace = project_key
            .as_ref()
            .map(|path| format!("zcode-{:x}", Sha256::digest(path.as_bytes())));
        if let (Some(key), Some(path)) = (&workspace, group.project) {
            workspaces.insert(key.clone(), json!({"workspaceKey":key,"path":path}));
        }
        entries.push(json!({"client":"zcode","sessionId":session,"model":model,"workspaceKey":workspace,"input":group.fields[0],"output":group.fields[1],"cacheRead":group.fields[2],"cacheWrite":group.fields[3],"reasoning":group.fields[4],"messageCount":group.count,"performance":{"totalDurationMs":if group.has_timed {group.duration}else{None},"timedTokens":if group.has_timed {group.timed_tokens}else{None}}}));
    }
    let sessions=session_times.into_iter().map(|(session,(first,last))|json!({"client":"zcode","sessionId":session,"firstActiveMs":first,"lastActiveMs":last})).collect::<Vec<_>>();
    let report = json!({"entries":entries,"workspaces":workspaces.into_values().collect::<Vec<Value>>(),"sessions":sessions});
    if serde_json::to_vec(&report)
        .map_err(|_| "ZCode统计无法编码")?
        .len()
        > MAX_METADATA
    {
        return Err("ZCode用量元数据超过16MiB限制".into());
    }
    let mut snapshot = normalize_report(&report, now)?;
    snapshot.engine_version = ADAPTER_VERSION.into();
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempConfigDir;
    fn now() -> u64 {
        Local
            .with_ymd_and_hms(2026, 10, 9, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64
    }
    fn fixture(path: &Path, modern: bool, session: bool) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(&format!("CREATE TABLE model_usage(id TEXT PRIMARY KEY, session_id TEXT,turn_id TEXT,agent TEXT,mode TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER,reasoning_tokens INTEGER{});",if modern {",computed_total_tokens INTEGER"}else{""})).unwrap();
        if session {
            conn.execute_batch("CREATE TABLE session(id TEXT,directory TEXT,path TEXT,title TEXT); INSERT INTO session VALUES('s1','D:\\Private\\Repo',NULL,'SECRET TITLE');").unwrap();
        }
        conn
    }
    #[allow(clippy::too_many_arguments)] // explicit schema/count/time fixture cases
    fn insert(
        conn: &Connection,
        id: &str,
        input: Option<i64>,
        output: Option<i64>,
        total: Option<i64>,
        at: i64,
        duration: Option<i64>,
        modern: bool,
    ) {
        let mut values = vec![
            rusqlite::types::Value::Text(id.into()),
            at.into(),
            duration.into(),
            input.into(),
            output.into(),
        ];
        if modern {
            values.push(total.into());
        }
        conn.execute(&format!("INSERT INTO model_usage(id,session_id,model_id,started_at,completed_at,duration_ms,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,reasoning_tokens{})VALUES(?1,'s1','DeepSeek-V4',?2,?2+1000,?3,?4,?5,10,5,4{})",if modern {",computed_total_tokens"}else{""},if modern {",?6"}else{""}),rusqlite::params_from_iter(values)).unwrap();
    }
    fn parse(path: &Path) -> Result<LocalSnapshot, String> {
        read(
            path,
            now(),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
    }
    #[test]
    fn modern_inclusive_exclusive_null_and_missing_session_rules() {
        let dir = TempConfigDir::new("zcode-modern");
        for (index, input, output, total, expected) in [
            (0, 100, 20, Some(120), (85, 20, 120)),
            (1, 85, 16, Some(120), (85, 20, 120)),
            (2, 100, 20, None, (100, 24, 139)),
        ] {
            let path = dir.join(format!("{index}.sqlite"));
            let conn = fixture(&path, true, index != 2);
            insert(
                &conn,
                "u1",
                Some(input),
                Some(output),
                total,
                now() as i64,
                Some(1000),
                true,
            );
            drop(conn);
            let data = parse(&path).unwrap();
            let row = &data.rows[0];
            assert_eq!(
                (row.input, row.output, row.total_tokens),
                (Some(expected.0), Some(expected.1), Some(expected.2))
            );
            assert_eq!(row.token_accuracy, "unclassified");
            assert_eq!(
                row.timing_coverage,
                crate::local_usage::TimingCoverage::Matched
            );
            assert_eq!(row.project_path.is_some(), index != 2);
            assert!(!serde_json::to_string(&data)
                .unwrap()
                .contains("SECRET TITLE"));
        }
        // Modern schema with no session table must still honor inclusive totals.
        let path = dir.join("missing-session.sqlite");
        let conn = fixture(&path, true, false);
        insert(
            &conn,
            "u",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        drop(conn);
        assert_eq!(parse(&path).unwrap().rows[0].total_tokens, Some(120));
    }
    #[test]
    fn legacy_time_month_scope_and_partial_timing() {
        let dir = TempConfigDir::new("zcode-legacy");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, false, true);
        let (start, end) = month_range(now()).unwrap();
        insert(
            &conn,
            "previous",
            Some(100),
            Some(20),
            None,
            start - 1,
            Some(1000),
            false,
        );
        insert(
            &conn,
            "next",
            Some(100),
            Some(20),
            None,
            end,
            Some(1000),
            false,
        );
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            None,
            now() as i64,
            Some(1000),
            false,
        );
        insert(
            &conn,
            "u2",
            Some(100),
            Some(20),
            None,
            now() as i64 + 1,
            None,
            false,
        );
        insert(
            &conn,
            "back",
            Some(100),
            Some(20),
            None,
            now() as i64 + 2000,
            Some(1000),
            false,
        );
        conn.execute(
            "UPDATE model_usage SET started_at=NULL,completed_at=?1 WHERE id='back'",
            [now() as i64 + 4000],
        )
        .unwrap();
        drop(conn);
        let snapshot = parse(&path).unwrap();
        let row = &snapshot.rows[0];
        assert_eq!(row.message_count, Some(3));
        assert_eq!(row.total_tokens, Some(360));
        assert_eq!(row.first_active_ms, Some(now()));
        assert_eq!(row.last_active_ms, Some(now() + 3000));
        assert_eq!(
            row.timing_coverage,
            crate::local_usage::TimingCoverage::Partial
        );
        assert_eq!(row.timed_output_tokens, None);
        assert_eq!(snapshot.period_key, "2026-10");
    }
    #[test]
    fn unknown_and_overflow_are_not_zero_or_invalid_speed() {
        let dir = TempConfigDir::new("zcode-unknown");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        insert(
            &conn,
            "u1",
            None,
            Some(20),
            None,
            now() as i64,
            Some(1000),
            true,
        );
        insert(
            &conn,
            "u2",
            Some(SAFE as i64),
            Some(-1),
            None,
            now() as i64,
            Some(1000),
            true,
        );
        drop(conn);
        let snapshot = parse(&path).unwrap();
        let row = &snapshot.rows[0];
        assert_eq!(row.input, None);
        assert_eq!(row.output, None);
        assert_eq!(row.total_tokens, None);
        assert_eq!(row.timed_output_tokens, None);
        assert!(checked_add(Some(SAFE), Some(1)).is_none());
    }
    #[test]
    fn duplicate_join_corruption_missing_and_cancel_are_errors() {
        let dir = TempConfigDir::new("zcode-errors");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        conn.execute_batch("INSERT INTO session VALUES('s1','D:\\Other',NULL,'SECRET');")
            .unwrap();
        drop(conn);
        assert!(parse(&path).unwrap_err().contains("不唯一"));
        assert!(parse(&dir.join("missing.sqlite")).is_err());
        assert!(!dir.join("missing.sqlite").exists());
        assert!(read(
            &path,
            now(),
            Arc::new(AtomicBool::new(true)),
            Instant::now() + Duration::from_secs(5)
        )
        .is_err());
        assert!(read(
            &path,
            now(),
            Arc::new(AtomicBool::new(false)),
            Instant::now()
        )
        .is_err());
        let corrupt = dir.join("broken.sqlite");
        std::fs::write(&corrupt, b"broken").unwrap();
        assert!(parse(&corrupt).is_err());
    }
    #[test]
    fn readonly_wal_reads_committed_rows_without_changing_database() {
        let dir = TempConfigDir::new("zcode-wal");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        conn.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        let before = std::fs::read(&path).unwrap();
        let wal = path.with_file_name("db.sqlite-wal");
        let before_wal = std::fs::read(&wal).unwrap();
        assert_eq!(parse(&path).unwrap().rows[0].total_tokens, Some(120));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        insert(
            &conn,
            "u2",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        assert_eq!(parse(&path).unwrap().rows[0].message_count, Some(1));
        conn.execute_batch("ROLLBACK;").unwrap();
    }
    #[test]
    fn row_limit_and_long_metadata_reject_instead_of_truncating() {
        let dir = TempConfigDir::new("zcode-limits");
        let path = dir.join("db.sqlite");
        let mut conn = fixture(&path, true, false);
        let tx = conn.transaction().unwrap();
        tx.execute(&format!("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<{}) INSERT INTO model_usage(id,session_id,model_id,started_at,input_tokens,output_tokens,reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens) SELECT CAST(x AS TEXT),'s1','deepseek',?1,1,1,0,0,0 FROM n",MAX_ROWS+1),[now() as i64]).unwrap();
        tx.commit().unwrap();
        drop(conn);
        assert!(parse(&path).unwrap_err().contains("5万"));
        let long = dir.join("long.sqlite");
        let conn = fixture(&long, true, false);
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            None,
            true,
        );
        conn.execute("UPDATE model_usage SET model_id=?1", ["a".repeat(2049)])
            .unwrap();
        drop(conn);
        assert!(parse(&long).is_err());
    }
    #[tokio::test]
    async fn collector_local_database_scope_and_partial_failure() {
        let dir = TempConfigDir::new("zcode-collect");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        let today = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            today,
            Some(1000),
            true,
        );
        drop(conn);
        let options = crate::local_sources::SourceOptions {
            include_default: false,
            homes: vec![],
            tool_paths: vec![
                crate::local_sources::ToolPath {
                    tool: "zcode".into(),
                    path: path.to_string_lossy().into_owned(),
                },
                crate::local_sources::ToolPath {
                    tool: "claude".into(),
                    path: dir.join("missing").to_string_lossy().into_owned(),
                },
            ],
        };
        let data = crate::local_usage::collect_sources(
            Path::new("unused-engine"),
            &options,
            None,
            dir.join("cache"),
        )
        .await
        .unwrap();
        assert!(!data.complete);
        assert_eq!(data.engine_version, ADAPTER_VERSION);
        assert_eq!(data.rows.len(), 1);
        assert_eq!(data.rows[0].tool, "zcode");
        assert!(data.rows[0].source_id.starts_with("tool-"));
        assert_eq!(data.sources[1].state, "unavailable");
        std::fs::write(&path, b"broken").unwrap();
        let only_zcode = crate::local_sources::SourceOptions {
            tool_paths: vec![options.tool_paths[0].clone()],
            ..options
        };
        let error = crate::local_usage::collect_sources(
            Path::new("unused-engine"),
            &only_zcode,
            None,
            dir.join("cache"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("ZCode"));
    }
    #[tokio::test]
    #[ignore = "显式运行固定引擎，仅创建临时ZCode数据库，不读真实日志"]
    async fn pinned_engine_and_adapter_known_counts_match() {
        let dir = TempConfigDir::new("zcode-engine");
        let folder = dir.join(".zcode/cli/db");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("db.sqlite");
        let conn = fixture(&path, true, true);
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            at as i64,
            Some(1000),
            true,
        );
        insert(
            &conn,
            "u2",
            Some(85),
            Some(16),
            Some(120),
            at as i64 + 1,
            Some(1000),
            true,
        );
        drop(conn);
        let direct = read(
            &path,
            at,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        let engine =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/local-usage/tokscale.exe");
        let pinned = crate::local_usage::run_engine(&engine, Some(dir.path()))
            .await
            .unwrap();
        assert_eq!(direct.rows.len(), 1);
        assert_eq!(pinned.rows.len(), 1);
        let (a, b) = (&direct.rows[0], &pinned.rows[0]);
        assert_eq!(
            (
                &a.session_id,
                &a.model,
                a.input,
                a.output,
                a.cache_read,
                a.cache_write,
                a.reasoning,
                a.total_tokens,
                a.message_count,
                a.timed_output_tokens,
                a.timed_duration_ms
            ),
            (
                &b.session_id,
                &b.model,
                b.input,
                b.output,
                b.cache_read,
                b.cache_write,
                b.reasoning,
                b.total_tokens,
                b.message_count,
                b.timed_output_tokens,
                b.timed_duration_ms
            )
        );
    }
    #[test]
    fn multi_model_session_keeps_time_bounds_and_project_key() {
        let dir = TempConfigDir::new("zcode-groups");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        insert(
            &conn,
            "u2",
            Some(100),
            Some(20),
            Some(120),
            now() as i64 + 2000,
            Some(1000),
            true,
        );
        conn.execute(
            "UPDATE model_usage SET model_id='another-model' WHERE id='u2'",
            [],
        )
        .unwrap();
        drop(conn);
        let data = parse(&path).unwrap();
        assert_eq!(data.rows.len(), 2);
        assert!(data
            .rows
            .iter()
            .all(|row| row.first_active_ms == Some(now())
                && row.last_active_ms == Some(now() + 2000)));
        assert_eq!(
            data.rows
                .iter()
                .map(|row| &row.project_key)
                .collect::<BTreeSet<_>>()
                .len(),
            1
        );
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _guard = CancelOnDrop(flag.clone());
        }
        assert!(flag.load(Ordering::Relaxed));
    }
    #[test]
    fn exclusive_lock_is_a_bounded_error_then_recovers() {
        let dir = TempConfigDir::new("zcode-lock");
        let path = dir.join("db.sqlite");
        let conn = fixture(&path, true, true);
        insert(
            &conn,
            "u1",
            Some(100),
            Some(20),
            Some(120),
            now() as i64,
            Some(1000),
            true,
        );
        conn.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        let start = Instant::now();
        assert!(parse(&path).is_err());
        assert!(start.elapsed() < Duration::from_secs(3));
        conn.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(parse(&path).unwrap().rows[0].total_tokens, Some(120));
    }
}
