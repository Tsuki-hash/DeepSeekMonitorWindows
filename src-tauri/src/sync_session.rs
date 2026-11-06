//! 同步会话的线性化点：取消与凭据提交共用一把锁。
use std::sync::Mutex;

#[derive(Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSyncKind {
    #[default]
    Web,
    Manual,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSyncStatus {
    pub generation: u64,
    pub request_id: Option<String>,
    pub active: bool,
    pub kind: UsageSyncKind,
}

#[derive(Default)]
pub struct SyncSession(Mutex<SessionState>);

/// API Key 操作使用独立会话，不能与网页登录的取消/清理相互作废。
#[derive(Default)]
pub struct ApiKeySession(pub SyncSession);

#[derive(Default)]
struct SessionState {
    generation: u64,
    active: bool,
    clearing: bool,
    request_id: Option<String>,
    kind: UsageSyncKind,
    cancelled_requests: std::collections::HashSet<String>,
}

impl SessionState {
    fn status(&self) -> UsageSyncStatus {
        UsageSyncStatus {
            generation: self.generation,
            request_id: self.request_id.clone(),
            active: self.active,
            kind: self.kind,
        }
    }
}

impl SyncSession {
    /// Replace the old login and close its window under the same lock. A slow
    /// caller cannot close a newer generation's window after begin returns.
    pub fn begin_usage(
        &self,
        request_id: String,
        kind: UsageSyncKind,
        close_previous: impl FnOnce(),
    ) -> Result<UsageSyncStatus, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.clearing {
            return Err("网页登录数据正在清理，请稍后再试".into());
        }
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("无效的同步请求标识".into());
        }
        if state.cancelled_requests.contains(&request_id) {
            return Err("同步已取消或已被新的操作替代".into());
        }
        state.generation += 1;
        state.active = true;
        state.request_id = Some(request_id);
        state.kind = kind;
        close_previous();
        Ok(state.status())
    }

    pub fn status(&self) -> UsageSyncStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).status()
    }

    /// Cancellation owns a particular request even before start's slow response.
    /// A stale cancel is a no-op, never a cancellation of the latest generation.
    pub fn cancel_usage(
        &self,
        request_id: &str,
        generation: Option<u64>,
        close_current: impl FnOnce(),
    ) -> Option<UsageSyncStatus> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !request_id.is_empty() && request_id.len() <= 128 {
            // Cancellation can reach IPC before a queued start is polled.
            state.cancelled_requests.insert(request_id.to_string());
        }
        if !state.active
            || state.request_id.as_deref() != Some(request_id)
            || generation.is_some_and(|generation| generation != state.generation)
        {
            return None;
        }
        state.active = false;
        close_current();
        Some(state.status())
    }

    pub fn begin(&self) -> Result<u64, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.clearing {
            return Err("网页登录数据正在清理，请稍后再试".into());
        }
        state.generation += 1;
        state.active = true;
        Ok(state.generation)
    }

    pub fn is_current(&self, generation: u64) -> bool {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active && state.generation == generation
    }

    pub fn active_generation(&self) -> Option<u64> {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active.then_some(state.generation)
    }

    pub fn commit<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.perform(generation, true, action)
    }

    pub fn with_current<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.perform(generation, false, action)
    }

    fn perform<T>(
        &self,
        generation: u64,
        finish: bool,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.active || state.generation != generation {
            return Err("同步已取消或已被新的操作替代".to_string());
        }
        let value = action()?;
        if finish {
            state.active = false;
        }
        Ok(value)
    }

    pub fn cancel<T>(&self, action: impl FnOnce() -> T) -> T {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.generation += 1;
        state.active = false;
        action()
    }

    pub fn start_clear<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.clearing {
            return Err("网页登录数据仍在清理，请等待完成".into());
        }
        state.generation += 1;
        state.active = false;
        let value = action()?;
        state.clearing = true;
        Ok(value)
    }

    pub fn finish_clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clearing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n10_manual_failure_ends_only_its_generation_and_preserves_newer_login() {
        let session = SyncSession::default();
        let web = session.begin_usage("web-one".into(), UsageSyncKind::Web, || ()).unwrap();
        let manual = session.begin_usage("manual-two".into(), UsageSyncKind::Manual, || ()).unwrap();
        assert!(!session.is_current(web.generation));
        session.commit(manual.generation, || Ok(())).unwrap();
        assert!(!session.status().active);
        let latest = session.begin_usage("web-three".into(), UsageSyncKind::Web, || ()).unwrap();
        assert!(session.commit::<()>(manual.generation, || panic!("old failure must not close new window")).is_err());
        assert!(session.is_current(latest.generation));
        assert!(session.cancel_usage("web-one", Some(web.generation), || panic!("stale cancel")).is_none());
        assert!(session.is_current(latest.generation));
    }

    #[test]
    fn n10_cancel_before_start_rejects_the_queued_request() {
        let session = SyncSession::default();
        assert!(session.cancel_usage("queued", None, || panic!("no window yet")).is_none());
        assert!(session.begin_usage("queued".into(), UsageSyncKind::Web, || panic!("cancelled start")).is_err());
        let next = session.begin_usage("next".into(), UsageSyncKind::Web, || ()).unwrap();
        assert!(session.cancel_usage("next", Some(next.generation + 1), || panic!("wrong generation")).is_none());
        assert!(session.is_current(next.generation));
        assert!(!session.cancel_usage("next", Some(next.generation), || ()).unwrap().active);
    }

    #[test]
    fn key清除拒绝迟到保存_新保存优先_不影响用量同步() {
        let key = ApiKeySession::default();
        let usage = SyncSession::default();
        let usage_generation = usage.begin().unwrap();
        let old = key.0.begin().unwrap();
        let mut stored = Some("original");
        key.0.cancel(|| stored = None);
        assert!(key
            .0
            .commit(old, || {
                stored = Some("late");
                Ok(())
            })
            .is_err());
        assert_eq!(stored, None);
        let first = key.0.begin().unwrap();
        let second = key.0.begin().unwrap();
        key.0
            .commit(second, || {
                stored = Some("new");
                Ok(())
            })
            .unwrap();
        assert!(key
            .0
            .commit(first, || {
                stored = Some("old");
                Ok(())
            })
            .is_err());
        assert_eq!(stored, Some("new"));
        assert!(usage.is_current(usage_generation));
    }

    #[test]
    fn 取消与新会话拒绝旧提交_成功只能提交一次() {
        let session = SyncSession::default();
        let first = session.begin().unwrap();
        session.cancel(|| ());
        assert!(session.commit(first, || Ok(())).is_err());
        let second = session.begin().unwrap();
        let third = session.begin().unwrap();
        assert!(session.commit(second, || Ok(())).is_err());
        assert_eq!(session.commit(third, || Ok("saved")).unwrap(), "saved");
        assert!(session.commit(third, || Ok(())).is_err());
    }

    #[test]
    fn 保存失败允许重试_取消后不执行保存回调() {
        let session = SyncSession::default();
        let generation = session.begin().unwrap();
        assert!(session
            .commit::<()>(generation, || Err("disk".into()))
            .is_err());
        assert!(session.is_current(generation));
        session.cancel(|| ());
        assert!(session
            .commit::<()>(generation, || {
                panic!("过期提交不能运行");
            })
            .is_err());
    }

    #[test]
    fn 清理期间禁止新同步_旧提交失效_完成后可重新登录() {
        let session = SyncSession::default();
        let old = session.begin().unwrap();
        session.start_clear(|| Ok(())).unwrap();
        assert!(session.begin().is_err());
        assert!(session.commit(old, || Ok(())).is_err());
        session.finish_clear();
        assert!(session.begin().is_ok());
    }
}
