//! 同步会话的线性化点：取消与凭据提交共用一把锁。
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

/// One native window's revocation signal. Its callback must never wait for the
/// session mutex or depend on lock/dispatch ordering during window creation.
/// The signal is checked inside commit's guarded admission instead.
#[derive(Clone, Default)]
pub struct LoginWindowLifetime(Arc<AtomicBool>);

impl LoginWindowLifetime {
    pub fn close(&self) -> bool {
        !self.0.swap(true, Ordering::AcqRel)
    }

    fn is_closed(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

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
pub struct ApiKeySession(SyncSession);

impl ApiKeySession {
    /// Use the same tombstone protocol as Token sync, but on a separate lock and
    /// request set. A delayed Key command cannot invalidate a newer Key owner or
    /// close/cancel the platform login window.
    pub fn begin(
        &self,
        request_id: String,
        superseded_request_ids: &[String],
    ) -> Result<u64, String> {
        self.0
            .begin_usage(
                request_id,
                superseded_request_ids,
                UsageSyncKind::Manual,
                || (),
            )
            .map(|status| status.generation)
    }

    pub fn commit<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.0.commit(generation, action)
    }

    pub fn clear<T>(
        &self,
        cancelled_request_ids: &[String],
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.0.clear_usage(cancelled_request_ids, action)
    }
}

#[derive(Default)]
struct SessionState {
    generation: u64,
    active: bool,
    clearing: bool,
    request_id: Option<String>,
    kind: UsageSyncKind,
    window_lifetime: LoginWindowLifetime,
    cancelled_requests: std::collections::HashSet<String>,
}

impl SessionState {
    fn cancel_queued_usage(&mut self, request_ids: &[String]) -> Result<(), String> {
        if request_ids.iter().any(|id| id.is_empty() || id.len() > 128) {
            return Err("无效的同步请求标识".into());
        }
        self.cancelled_requests.extend(request_ids.iter().cloned());
        if let Some(request_id) = &self.request_id {
            self.cancelled_requests.insert(request_id.clone());
        }
        Ok(())
    }

    fn status(&self) -> UsageSyncStatus {
        UsageSyncStatus {
            generation: self.generation,
            request_id: self.request_id.clone(),
            active: self.active && !self.window_lifetime.is_closed(),
            kind: self.kind,
        }
    }
}

impl SyncSession {
    /// Replace the old login and capture its window under the same lock. Native
    /// close operations happen after this method returns; retain the specific
    /// old handle, never look up the shared window label again after releasing
    /// the lock. Native callbacks publish their lifetime signal without it.
    pub fn begin_usage(
        &self,
        request_id: String,
        superseded_request_ids: &[String],
        kind: UsageSyncKind,
        capture_previous: impl FnOnce(),
    ) -> Result<UsageSyncStatus, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.clearing {
            return Err("网页登录数据正在清理，请稍后再试".into());
        }
        if request_id.is_empty()
            || request_id.len() > 128
            || superseded_request_ids.contains(&request_id)
        {
            return Err("无效的同步请求标识".into());
        }
        if state.cancelled_requests.contains(&request_id)
            || state.request_id.as_ref() == Some(&request_id)
        {
            return Err("同步已取消或已被新的操作替代".into());
        }
        // Check this request before revoking anything: a stale start must not
        // cancel the newer owner that already superseded it.
        state.cancel_queued_usage(superseded_request_ids)?;
        state.generation += 1;
        state.active = true;
        state.window_lifetime = LoginWindowLifetime::default();
        state.request_id = Some(request_id);
        state.kind = kind;
        capture_previous();
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
        capture_current: impl FnOnce(),
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
        capture_current();
        Some(state.status())
    }

    /// Capture ownership before building the native window, without re-entering
    /// the lock from with_current's builder callback.
    pub fn login_window_lifetime(&self, generation: u64) -> Result<LoginWindowLifetime, String> {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.active
            || state.generation != generation
            || state.window_lifetime.is_closed()
            || !matches!(state.kind, UsageSyncKind::Web)
        {
            return Err("同步已取消或已被新的操作替代".into());
        }
        Ok(state.window_lifetime.clone())
    }

    /// Finish the generation whose native callback has already revoked its
    /// lifetime. Run off the UI thread so native dispatch never waits for
    /// ongoing session work, including window creation. CloseRequested + Destroyed,
    /// old-window events and successful programmatic closes are idempotent.
    pub fn close_web_window(&self, generation: u64) -> Option<UsageSyncStatus> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.active
            || state.generation != generation
            || !matches!(state.kind, UsageSyncKind::Web)
        {
            return None;
        }
        state.window_lifetime.close();
        state.active = false;
        Some(state.status())
    }

    pub fn begin(&self) -> Result<u64, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.clearing {
            return Err("网页登录数据正在清理，请稍后再试".into());
        }
        state.generation += 1;
        state.active = true;
        state.window_lifetime = LoginWindowLifetime::default();
        Ok(state.generation)
    }

    pub fn is_current(&self, generation: u64) -> bool {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active && state.generation == generation && !state.window_lifetime.is_closed()
    }

    pub fn active_generation(&self) -> Option<u64> {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        (state.active && !state.window_lifetime.is_closed()).then_some(state.generation)
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
        // Admission is the linearization point. A native close that publishes
        // first rejects this action, even before its notification task obtains
        // the mutex. Once admission wins, persistence owns the lock through its
        // result; a later close cannot turn a successful commit into cancellation.
        if !state.active || state.generation != generation || state.window_lifetime.is_closed() {
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

    /// Clear's cancellation receipt includes frontend requests that have not
    /// reached begin_usage yet. Tombstones and the credential mutation share
    /// the same lock, so neither IPC polling order can revive the old login.
    pub fn clear_usage<T>(
        &self,
        request_ids: &[String],
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel_queued_usage(request_ids)?;
        state.generation += 1;
        state.active = false;
        action()
    }

    pub fn start_clear<T>(
        &self,
        request_ids: &[String],
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel_queued_usage(request_ids)?;
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
    fn r14_clear_revokes_all_queued_starts_in_every_backend_polling_order() {
        // Both web and manual IPC can still be queued when Clear reaches Rust.
        // Enumerate all reachable orderings of their two starts and Clear.
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let session = SyncSession::default();
            let pending = ["old-web".to_string(), "old-manual".to_string()];
            let cached_token = "retained-web-session";
            let mut stored = Some("original-token");
            let mut accepted = Vec::new();
            for operation in order {
                if operation == 2 {
                    session
                        .clear_usage(&pending, || {
                            stored = None;
                            Ok(())
                        })
                        .unwrap();
                } else {
                    let kind = if operation == 0 {
                        UsageSyncKind::Web
                    } else {
                        UsageSyncKind::Manual
                    };
                    if let Ok(status) = session.begin_usage(
                        pending[operation].clone(),
                        &pending[..operation],
                        kind,
                        || (),
                    ) {
                        accepted.push(status.generation);
                    }
                }
            }
            assert!(!session.status().active);
            for generation in accepted {
                assert!(session
                    .with_current::<()>(generation, || panic!("old window must not reopen"))
                    .is_err());
                assert!(session
                    .commit::<()>(generation, || panic!("old token must not be saved"))
                    .is_err());
            }
            assert_eq!(stored, None);
            for request_id in &pending {
                assert!(session
                    .begin_usage(request_id.clone(), &[], UsageSyncKind::Web, || panic!(
                        "cancelled request replay"
                    ))
                    .is_err());
            }
            // Clear is not Forget: a new explicit login can still use the cache.
            let new = session
                .begin_usage("new-web".into(), &[], UsageSyncKind::Web, || ())
                .unwrap();
            assert!(session
                .cancel_usage("old-web", None, || panic!(
                    "old cancel must not close new login"
                ))
                .is_none());
            assert!(session.is_current(new.generation));
            session
                .commit(new.generation, || {
                    stored = Some(cached_token);
                    Ok(())
                })
                .unwrap();
            assert_eq!(stored, Some(cached_token));
        }
    }

    #[test]
    fn r14_manual_replacement_rejects_old_web_before_or_after_backend_admission() {
        for web_entered in [false, true] {
            for manual_succeeds in [false, true] {
                let session = SyncSession::default();
                let old = if web_entered {
                    Some(
                        session
                            .begin_usage("old-web".into(), &[], UsageSyncKind::Web, || ())
                            .unwrap(),
                    )
                } else {
                    None
                };
                let manual = session
                    .begin_usage(
                        "new-manual".into(),
                        &["old-web".into()],
                        UsageSyncKind::Manual,
                        || (),
                    )
                    .unwrap();
                let mut stored = "original";
                // A failure ends only this generation, without overwriting the
                // stored Token. Either outcome still supersedes the old start.
                session
                    .commit(manual.generation, || {
                        if manual_succeeds {
                            stored = "manual";
                        }
                        Ok(())
                    })
                    .unwrap();
                assert!(session
                    .begin_usage("old-web".into(), &[], UsageSyncKind::Web, || panic!(
                        "old cache scan must not begin"
                    ))
                    .is_err());
                if let Some(old) = old {
                    assert!(session
                        .commit::<()>(old.generation, || panic!(
                            "old cached token must not overwrite manual"
                        ))
                        .is_err());
                }
                assert_eq!(
                    stored,
                    if manual_succeeds {
                        "manual"
                    } else {
                        "original"
                    }
                );
                let newest = session
                    .begin_usage("next-web".into(), &[], UsageSyncKind::Web, || ())
                    .unwrap();
                assert!(session
                    .commit::<()>(manual.generation, || panic!(
                        "old manual completion must not close new login"
                    ))
                    .is_err());
                assert!(session.is_current(newest.generation));
            }
        }
    }

    #[test]
    fn r14_clear_after_capture_removes_token_but_failed_clear_keeps_error_and_revocation() {
        let session = SyncSession::default();
        let old = session
            .begin_usage("already-entered".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        let mut stored = None;
        session
            .commit(old.generation, || {
                stored = Some("captured");
                Ok(())
            })
            .unwrap();
        session
            .clear_usage(&[], || {
                stored = None;
                Ok(())
            })
            .unwrap();
        assert_eq!(stored, None);
        assert!(session
            .begin_usage(
                "already-entered".into(),
                &[],
                UsageSyncKind::Web,
                || panic!("old replay")
            )
            .is_err());

        stored = Some("existing");
        let error = session.clear_usage::<()>(&["queued-before-failure".into()], || {
            Err("synthetic disk error".into())
        });
        assert_eq!(error.unwrap_err(), "synthetic disk error");
        assert_eq!(stored, Some("existing"));
        assert!(session
            .begin_usage(
                "queued-before-failure".into(),
                &[],
                UsageSyncKind::Web,
                || panic!("failed clear still revokes old intent")
            )
            .is_err());
        assert!(session
            .begin_usage("explicit-retry".into(), &[], UsageSyncKind::Web, || ())
            .is_ok());
    }

    #[test]
    fn r14_forget_keeps_queued_requests_revoked_after_browsing_data_finishes() {
        let session = SyncSession::default();
        let old = session
            .begin_usage("running".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        session
            .start_clear(&["not-yet-polled".into()], || Ok(()))
            .unwrap();
        assert!(session
            .commit::<()>(old.generation, || panic!("old capture after forget"))
            .is_err());
        assert!(session
            .begin_usage("new-login".into(), &[], UsageSyncKind::Web, || panic!(
                "browsing data still clearing"
            ))
            .is_err());
        session.finish_clear();
        for request_id in ["running", "not-yet-polled"] {
            assert!(session
                .begin_usage(request_id.into(), &[], UsageSyncKind::Web, || panic!(
                    "old start after forget"
                ))
                .is_err());
        }
        let new = session
            .begin_usage("new-login".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        assert!(session
            .cancel_usage("not-yet-polled", None, || panic!("old cancellation"))
            .is_none());
        assert!(session.is_current(new.generation));
    }

    #[test]
    fn n10_manual_failure_ends_only_its_generation_and_preserves_newer_login() {
        let session = SyncSession::default();
        let web = session
            .begin_usage("web-one".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        let manual = session
            .begin_usage("manual-two".into(), &[], UsageSyncKind::Manual, || ())
            .unwrap();
        assert!(!session.is_current(web.generation));
        session.commit(manual.generation, || Ok(())).unwrap();
        assert!(!session.status().active);
        let latest = session
            .begin_usage("web-three".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        assert!(session
            .commit::<()>(manual.generation, || panic!(
                "old failure must not close new window"
            ))
            .is_err());
        assert!(session.is_current(latest.generation));
        assert!(session
            .cancel_usage("web-one", Some(web.generation), || panic!("stale cancel"))
            .is_none());
        assert!(session.is_current(latest.generation));
    }

    #[test]
    fn n10_cancel_before_start_rejects_the_queued_request() {
        let session = SyncSession::default();
        assert!(session
            .cancel_usage("queued", None, || panic!("no window yet"))
            .is_none());
        assert!(session
            .begin_usage("queued".into(), &[], UsageSyncKind::Web, || panic!(
                "cancelled start"
            ))
            .is_err());
        let next = session
            .begin_usage("next".into(), &[], UsageSyncKind::Web, || ())
            .unwrap();
        assert!(session
            .cancel_usage("next", Some(next.generation + 1), || panic!(
                "wrong generation"
            ))
            .is_none());
        assert!(session.is_current(next.generation));
        assert!(
            !session
                .cancel_usage("next", Some(next.generation), || ())
                .unwrap()
                .active
        );
    }

    #[test]
    fn key清除拒绝迟到保存_新保存优先_不影响用量同步() {
        let key = ApiKeySession::default();
        let usage = SyncSession::default();
        let usage_generation = usage.begin().unwrap();
        let old = key.begin("old-key".into(), &[]).unwrap();
        let mut stored = Some("original");
        key.clear(&[], || {
            stored = None;
            Ok(())
        })
        .unwrap();
        assert!(key
            .commit(old, || {
                stored = Some("late");
                Ok(())
            })
            .is_err());
        assert_eq!(stored, None);
        let first = key.begin("first-key".into(), &[]).unwrap();
        let second = key
            .begin("second-key".into(), &["first-key".into()])
            .unwrap();
        key.commit(second, || {
            stored = Some("new");
            Ok(())
        })
        .unwrap();
        assert!(key
            .commit(first, || {
                stored = Some("old");
                Ok(())
            })
            .is_err());
        assert_eq!(stored, Some("new"));
        assert!(usage.is_current(usage_generation));
    }

    #[test]
    fn r15_key_clear_revokes_all_queued_saves_in_every_admission_order() {
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let key = ApiKeySession::default();
            let token = SyncSession::default();
            let login = token
                .begin_usage("web-owner".into(), &[], UsageSyncKind::Web, || ())
                .unwrap();
            let ids = ["old-key".to_string(), "replacement-key".to_string()];
            let mut stored = Some("original-key");
            let mut admitted = Vec::new();
            for operation in order {
                if operation == 2 {
                    key.clear(&ids, || {
                        stored = None;
                        Ok(())
                    })
                    .unwrap();
                } else if let Ok(generation) = key.begin(ids[operation].clone(), &ids[..operation])
                {
                    admitted.push(generation);
                }
            }
            for generation in admitted {
                assert!(key
                    .commit::<()>(generation, || panic!("old key must not reach persistence"))
                    .is_err());
            }
            for request in &ids {
                assert!(key.begin(request.clone(), &[]).is_err());
            }
            assert_eq!(stored, None);
            let latest = key.begin("explicit-new-key".into(), &[]).unwrap();
            // Old replay carries its own supersession list. Reject it before
            // touching the new owner, not just before writing the old value.
            assert!(key.begin(ids[1].clone(), &ids[..1]).is_err());
            key.commit(latest, || {
                stored = Some("new-key");
                Ok(())
            })
            .unwrap();
            assert_eq!(stored, Some("new-key"));
            assert!(token.is_current(login.generation));
        }
    }

    #[test]
    fn r15_failed_key_clear_keeps_revocation_and_allows_explicit_retry() {
        let key = ApiKeySession::default();
        let old = key.begin("entered-key".into(), &[]).unwrap();
        let result = key.clear::<()>(
            &["queued-key".into()],
            || Err("synthetic disk error".into()),
        );
        assert_eq!(result.unwrap_err(), "synthetic disk error");
        assert!(key.begin("queued-key".into(), &[]).is_err());
        assert!(key
            .commit::<()>(old, || panic!("failed clear still invalidates old save"))
            .is_err());
        let new = key.begin("explicit-retry".into(), &[]).unwrap();
        assert!(key.commit(new, || Ok(())).is_ok());
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
        session.start_clear(&[], || Ok(())).unwrap();
        assert!(session.begin().is_err());
        assert!(session.commit(old, || Ok(())).is_err());
        session.finish_clear();
        assert!(session.begin().is_ok());
    }
}
