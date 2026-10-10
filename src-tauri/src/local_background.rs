//! Opt-in background metadata collection. Filesystem events are hints, never
//! usage records or deletion proof. One collector serves foreground/background.
use crate::local_sources::{HomeKind, SourceOptions};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub fn changed() -> &'static tokio::sync::Notify {
    static VALUE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    VALUE.get_or_init(tokio::sync::Notify::new)
}
fn preference_path() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()?.with_file_name("local-usage-background-enabled.json"))
}
pub fn enabled(state: &mut crate::local_usage::LocalState) -> Result<bool, String> {
    if let Some(value) = state.background_enabled {
        return Ok(value);
    }
    use std::io::Read;
    let value = match std::fs::File::open(preference_path()?) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(17)
                .read_to_end(&mut bytes)
                .map_err(|_| "后台采集设置无法读取")?;
            if bytes.len() > 16 {
                return Err("后台采集设置损坏，请关闭并重置".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "后台采集设置损坏，请关闭并重置")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("后台采集设置无法读取".into()),
    };
    state.background_enabled = Some(value);
    Ok(value)
}
pub fn save(state: &mut crate::local_usage::LocalState, value: bool) -> Result<(), String> {
    let path = preference_path()?;
    std::fs::create_dir_all(path.parent().ok_or("后台采集目录不可用")?)
        .map_err(|_| "后台采集设置无法保存")?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        if value {
            b"true".as_slice()
        } else {
            b"false".as_slice()
        },
    )
    .map_err(|_| "后台采集设置无法保存，原设置保留")?;
    std::fs::rename(temp, path).map_err(|_| "后台采集设置无法提交，原设置保留")?;
    state.background_enabled = Some(value);
    state.generation = state.generation.wrapping_add(1);
    if let Some(cancel) = state.cancel.take() {
        cancel.notify_one();
    }
    changed().notify_one();
    Ok(())
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub effective: bool,
    pub state: String,
    pub watched_roots: usize,
    pub last_attempt: Option<u64>,
    pub last_success: Option<u64>,
    pub error: Option<String>,
    pub watch_warning: Option<String>,
}
#[derive(Default)]
pub struct Runtime(pub Mutex<Status>);
pub fn status(app: &tauri::AppHandle) -> Result<Status, String> {
    let collector = app.state::<crate::local_usage::LocalCollector>();
    let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
    let local = crate::commands::local_enabled(&mut state)?;
    let background = enabled(&mut state)?;
    let mut value = app
        .state::<Runtime>()
        .0
        .lock()
        .map_err(|_| "后台状态不可用")?
        .clone();
    value.enabled = background;
    value.effective = background && local;
    if !value.effective {
        value.state = if background { "paused" } else { "off" }.into();
        value.watched_roots = 0;
        value.watch_warning = None;
        value.error = None;
    } else if value.state.is_empty() || matches!(value.state.as_str(), "off" | "paused") {
        value.state = "starting".into();
    }
    Ok(value)
}

// Same bounded tool roots as the pinned reference, never a recursive user-home
// watch. Native environment overrides may be missed here; periodic scans still
// use the engine's complete discovery. WSL roots are never opened by the watcher.
fn candidates(options: &SourceOptions, home: Option<&Path>) -> Vec<PathBuf> {
    const ROOTS: &[&str] = &[
        ".claude/projects",
        ".claude/transcripts",
        ".local/share/opencode",
        ".openclaw/agents",
        ".clawdbot/agents",
        ".moltbot/agents",
        ".moldbot/agents",
        ".hermes",
        ".dsh/sessions",
        ".zcode/projects",
        ".zcode/cli/db",
    ];
    let mut result = BTreeSet::new();
    let mut homes = Vec::new();
    if options.include_default {
        if let Some(home) = home {
            homes.push(home.to_path_buf());
        }
    }
    for value in &options.homes {
        if matches!(
            crate::local_sources::clean_home(value),
            Ok((_, HomeKind::Native))
        ) {
            homes.push(value.into());
        }
    }
    for home in homes {
        for root in ROOTS {
            result.insert(home.join(root));
        }
    }
    for entry in &options.tool_paths {
        if matches!(
            crate::local_sources::clean_tool_path(&entry.path),
            Ok((_, HomeKind::Native))
        ) {
            let path = PathBuf::from(&entry.path);
            // Keep DB file identity: watch_roots chooses its parent nonrecursively.
            // Passing the parent as a directory would watch unrelated subtrees.
            result.insert(path);
        }
    }
    result.into_iter().take(64).collect()
}
fn watch_roots(paths: &[PathBuf]) -> BTreeMap<PathBuf, bool> {
    let mut roots = BTreeMap::new();
    for requested in paths {
        let mut path = requested.as_path();
        while !path.is_dir() {
            let Some(parent) = path.parent().filter(|p| p.parent().is_some()) else {
                break;
            };
            path = parent;
        }
        if !path.is_dir() || path.parent().is_none() {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let text = canonical.to_string_lossy();
        if text.starts_with("\\\\") && !text.starts_with("\\\\?\\") {
            continue;
        }
        if text.starts_with("\\\\?\\UNC\\") {
            continue;
        }
        let recursive = path == requested;
        roots
            .entry(canonical)
            .and_modify(|r| *r |= recursive)
            .or_insert(recursive);
    }
    roots
}
#[derive(Clone, Default)]
struct WatchState {
    count: usize,
    warning: Option<String>,
}
struct Signals {
    plan: Mutex<Option<Vec<PathBuf>>>,
    epoch: AtomicU64,
    dirty: AtomicBool,
    stop: AtomicBool,
    state: Mutex<WatchState>,
}
struct WatchControl(Arc<Signals>);
fn change_hint(event: &notify::Result<notify::Event>) -> bool {
    match event {
        Err(_) => true, // dropped/invalid notifications still require a bounded refresh
        Ok(event) => {
            !matches!(event.kind, notify::EventKind::Access(_))
                && (event.paths.is_empty()
                    || event.paths.iter().any(|path| {
                        !path.file_name().is_some_and(|name| {
                            name.to_string_lossy()
                                .to_ascii_lowercase()
                                .ends_with("-shm")
                        })
                    }))
        }
    }
}
impl WatchControl {
    fn start() -> Self {
        let signal = Arc::new(Signals {
            plan: Mutex::new(None),
            epoch: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            state: Mutex::new(WatchState::default()),
        });
        let thread_signal = signal.clone();
        std::thread::spawn(move || {
            let mut epoch = u64::MAX;
            let mut refreshed = Instant::now();
            let mut watcher = None;
            while !thread_signal.stop.load(Ordering::Acquire) {
                let next = thread_signal.epoch.load(Ordering::Acquire);
                if next != epoch || refreshed.elapsed() >= Duration::from_secs(60) {
                    watcher.take();
                    epoch = next;
                    refreshed = Instant::now();
                    let plan = thread_signal.plan.lock().ok().and_then(|p| p.clone());
                    let mut state = WatchState::default();
                    if let Some(plan) = plan {
                        let event_signal = thread_signal.clone();
                        let created = notify::recommended_watcher(
                            move |event: notify::Result<notify::Event>| {
                                if event_signal.epoch.load(Ordering::Acquire) != epoch {
                                    return;
                                }
                                if !change_hint(&event) {
                                    return;
                                }
                                if event.is_err() {
                                    if let Ok(mut state) = event_signal.state.lock() {
                                        state.warning =
                                            Some("目录监听中断，定时采集仍可继续".into());
                                    }
                                }
                                event_signal.dirty.store(true, Ordering::Release);
                                changed().notify_one();
                            },
                        );
                        if let Ok(mut active) = created {
                            for (path, recursive) in watch_roots(&plan) {
                                if thread_signal.epoch.load(Ordering::Acquire) != epoch {
                                    break;
                                }
                                if active
                                    .watch(
                                        &path,
                                        if recursive {
                                            RecursiveMode::Recursive
                                        } else {
                                            RecursiveMode::NonRecursive
                                        },
                                    )
                                    .is_ok()
                                {
                                    state.count += 1;
                                } else {
                                    state.warning = Some("部分目录无法监听，定时采集兜底".into());
                                }
                            }
                            watcher = Some(active);
                        } else {
                            state.warning = Some("目录监听无法启动，使用定时采集".into());
                        }
                    }
                    if thread_signal.epoch.load(Ordering::Acquire) == epoch {
                        if let Ok(mut value) = thread_signal.state.lock() {
                            *value = state;
                        }
                    } else {
                        watcher.take();
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Self(signal)
    }
    fn configure(&self, paths: Option<Vec<PathBuf>>) {
        if let Ok(mut plan) = self.0.plan.lock() {
            if *plan != paths {
                *plan = paths;
                self.0.epoch.fetch_add(1, Ordering::AcqRel);
                self.0.dirty.store(false, Ordering::Release);
                if let Ok(mut state) = self.0.state.lock() {
                    *state = WatchState::default();
                }
            }
        }
    }
}
impl Drop for WatchControl {
    fn drop(&mut self) {
        self.0.stop.store(true, Ordering::Release);
    }
}

// Event bursts never starve the fallback. Scan starts at least 5s apart; quiet
// events coalesce for 1.5s, sustained activity is sampled by the 60s fallback.
#[derive(Default)]
struct Schedule {
    last: Option<Instant>,
    event: Option<Instant>,
    failures: u32,
}
impl Schedule {
    fn due(&self, now: Instant) -> bool {
        let Some(last) = self.last else {
            return true;
        };
        let elapsed = now.saturating_duration_since(last);
        if elapsed < Duration::from_secs(5) {
            return false;
        }
        if self.failures > 0 {
            return elapsed >= Duration::from_secs((60 * 2u64.pow(self.failures.min(4))).min(600));
        }
        elapsed >= Duration::from_secs(60)
            || self.event.is_some_and(|event| {
                now.saturating_duration_since(event) >= Duration::from_millis(1500)
            })
    }
    fn finish(&mut self, started: Instant, success: bool) {
        self.last = Some(started);
        self.event = None;
        self.failures = if success {
            0
        } else {
            self.failures.saturating_add(1)
        };
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let watch = WatchControl::start();
        let mut owner = None;
        let mut schedule = Schedule::default();
        loop {
            let settings = (|| {
                let collector = app.state::<crate::local_usage::LocalCollector>();
                let mut state = collector.inner.lock().map_err(|_| "采集状态不可用")?;
                if !crate::commands::local_enabled(&mut state)? || !enabled(&mut state)? {
                    return Ok(None);
                }
                if state.sources.is_none() {
                    state.sources = Some(crate::local_sources::load()?);
                }
                Ok::<_, String>(Some((state.generation, state.sources.clone().unwrap())))
            })();
            match settings {
                Ok(Some((generation, options))) => {
                    if owner != Some(generation) {
                        owner = Some(generation);
                        schedule = Schedule::default();
                        watch.configure(Some(candidates(
                            &options,
                            app.path().home_dir().ok().as_deref(),
                        )));
                    }
                    if watch.0.dirty.swap(false, Ordering::AcqRel) {
                        schedule.event = Some(Instant::now());
                    }
                    if let Ok(mut status) = app.state::<Runtime>().0.lock() {
                        let watched = watch.0.state.lock().map(|v| v.clone()).unwrap_or_default();
                        status.state = if watched.count > 0 {
                            "watching"
                        } else {
                            "polling"
                        }
                        .into();
                        status.watched_roots = watched.count;
                        status.watch_warning = watched.warning;
                    }
                    if schedule.due(Instant::now()) {
                        let started = Instant::now();
                        let timestamp = now_ms();
                        // Background policy is checked again while claiming the shared collector.
                        let result = crate::commands::collect_local_usage(&app, true).await;
                        let current = app
                            .state::<crate::local_usage::LocalCollector>()
                            .inner
                            .lock()
                            .is_ok_and(|state| state.generation == generation);
                        if !current {
                            continue;
                        }
                        match result {
                            Ok(Some(_)) => {
                                schedule.finish(started, true);
                                if let Ok(mut status) = app.state::<Runtime>().0.lock() {
                                    status.last_attempt = Some(timestamp);
                                    status.last_success = Some(now_ms());
                                    status.error = None;
                                }
                            }
                            Ok(None) => {} // foreground owns it, or policy changed
                            Err(error) => {
                                schedule.finish(started, false);
                                if let Ok(mut status) = app.state::<Runtime>().0.lock() {
                                    status.last_attempt = Some(timestamp);
                                    status.error = Some(error);
                                }
                            }
                        }
                    }
                }
                Ok(None) => {
                    owner = None;
                    schedule = Schedule::default();
                    watch.configure(None);
                }
                Err(error) => {
                    owner = None;
                    watch.configure(None);
                    if let Ok(mut status) = app.state::<Runtime>().0.lock() {
                        status.error = Some(error);
                    }
                }
            }
            tokio::select! { _ = changed().notified() => {}, _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempConfigDir;
    #[test]
    fn policy_defaults_off_persists_and_failure_preserves_memory() {
        let dir = TempConfigDir::new("background-policy");
        let mut state = crate::local_usage::LocalState::default();
        assert!(!enabled(&mut state).unwrap());
        save(&mut state, true).unwrap();
        assert!(enabled(&mut crate::local_usage::LocalState::default()).unwrap());
        let generation = state.generation;
        let temp = preference_path().unwrap().with_extension("tmp");
        std::fs::create_dir(&temp).unwrap();
        assert!(save(&mut state, false).is_err());
        assert_eq!(state.background_enabled, Some(true));
        assert_eq!(state.generation, generation);
        std::fs::remove_dir(temp).unwrap();
        std::fs::write(preference_path().unwrap(), b"corrupt").unwrap();
        assert!(enabled(&mut crate::local_usage::LocalState::default()).is_err());
        save(&mut state, false).unwrap();
        assert!(!enabled(&mut crate::local_usage::LocalState::default()).unwrap());
        assert!(dir.path().exists());
    }
    #[test]
    fn debounce_fallback_backoff_and_reset() {
        let now = Instant::now();
        let mut poll = Schedule::default();
        assert!(poll.due(now));
        poll.finish(now, true);
        poll.event = Some(now + Duration::from_secs(1));
        assert!(!poll.due(now + Duration::from_secs(4)));
        assert!(poll.due(now + Duration::from_secs(5)));
        poll.event = Some(now + Duration::from_secs(59));
        assert!(poll.due(now + Duration::from_secs(60)));
        poll.finish(now, false);
        assert!(!poll.due(now + Duration::from_secs(119)));
        assert!(poll.due(now + Duration::from_secs(120)));
        for _ in 0..9 {
            poll.finish(now, false);
        }
        assert!(!poll.due(now + Duration::from_secs(599)));
        assert!(poll.due(now + Duration::from_secs(600)));
        poll.finish(now, true);
        assert!(poll.due(now + Duration::from_secs(60)));
    }
    #[test]
    fn roots_are_tool_scoped_wsl_never_watched_and_db_parent() {
        let options = SourceOptions {
            include_default: true,
            homes: vec![
                "D:\\Other".into(),
                "\\\\wsl.localhost\\Ubuntu\\home\\u".into(),
            ],
            tool_paths: vec![
                crate::local_sources::ToolPath {
                    tool: "zcode".into(),
                    path: "D:\\Custom\\data.db".into(),
                },
                crate::local_sources::ToolPath {
                    tool: "claude".into(),
                    path: "\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude\\projects".into(),
                },
            ],
        };
        let roots = candidates(&options, Some(Path::new("D:\\Synthetic")));
        assert!(roots.contains(&PathBuf::from("D:\\Custom\\data.db")));
        assert!(roots
            .iter()
            .all(|p| !p.to_string_lossy().contains("wsl.localhost")));
        assert!(!roots.contains(&PathBuf::from("D:\\Synthetic")));
        assert!(roots.len() <= 64);
    }
    #[test]
    fn missing_tool_root_uses_nonrecursive_existing_parent() {
        let dir = TempConfigDir::new("background-roots");
        let requested = dir.path().join("missing-tool").join("sessions");
        let roots = watch_roots(&[requested]);
        assert_eq!(roots.get(&dir.path().canonicalize().unwrap()), Some(&false));
        let existing = dir.path().join("tool");
        std::fs::create_dir(&existing).unwrap();
        assert_eq!(
            watch_roots(std::slice::from_ref(&existing)).get(&existing.canonicalize().unwrap()),
            Some(&true)
        );
        let database = dir.path().join("usage.db");
        std::fs::write(&database, b"synthetic placeholder").unwrap();
        assert_eq!(
            watch_roots(&[database]).get(&dir.path().canonicalize().unwrap()),
            Some(&false)
        );
    }
    #[tokio::test]
    async fn disabling_policy_invalidates_and_cancels_without_deleting_snapshot() {
        let _dir = TempConfigDir::new("background-cancel");
        let cancel = Arc::new(tokio::sync::Notify::new());
        let mut state = crate::local_usage::LocalState {
            generation: 7,
            busy: true,
            cancel: Some(cancel.clone()),
            ..Default::default()
        };
        state.snapshot = Some(
            crate::local_usage::normalize_report(&serde_json::json!({"entries":[]}), 1000).unwrap(),
        );
        save(&mut state, false).unwrap();
        assert_eq!(state.generation, 8);
        assert!(state.cancel.is_none());
        assert!(state.busy);
        assert!(state.snapshot.is_some());
        tokio::time::timeout(Duration::from_millis(100), cancel.notified())
            .await
            .unwrap();
    }
    #[test]
    fn synthetic_native_event_and_disabled_watcher_lifecycle() {
        let dir = TempConfigDir::new("background-watch");
        let control = WatchControl::start();
        control.configure(Some(vec![dir.path().to_path_buf()]));
        let limit = Instant::now() + Duration::from_secs(5);
        while control.0.state.lock().unwrap().count == 0 && Instant::now() < limit {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(control.0.state.lock().unwrap().count, 1);
        control.0.dirty.store(false, Ordering::Release);
        std::fs::write(dir.path().join("session.jsonl"), b"synthetic metadata").unwrap();
        while !control.0.dirty.load(Ordering::Acquire) && Instant::now() < limit {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(control.0.dirty.load(Ordering::Acquire));
        control.configure(None);
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(
            dir.path().join("session.jsonl"),
            b"changed synthetic metadata",
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!control.0.dirty.load(Ordering::Acquire));
        assert_eq!(control.0.state.lock().unwrap().count, 0);
    }
    #[test]
    fn sqlite_shared_memory_and_access_do_not_trigger_self_refresh() {
        use notify::event::{AccessKind, ModifyKind};
        assert!(!change_hint(&Ok(notify::Event::new(
            notify::EventKind::Access(AccessKind::Any)
        ))));
        let shm = notify::Event::new(notify::EventKind::Modify(ModifyKind::Any))
            .add_path("D:\\Tool\\usage.db-shm".into());
        assert!(!change_hint(&Ok(shm.clone())));
        assert!(change_hint(&Ok(
            shm.add_path("D:\\Tool\\usage.db-wal".into())
        )));
        assert!(change_hint(&Ok(notify::Event::new(notify::EventKind::Any))));
        assert!(change_hint(&Err(notify::Error::generic(
            "synthetic watch failure"
        ))));
    }
}
