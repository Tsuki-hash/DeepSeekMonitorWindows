//! R18 source regressions for the production lifetime + session admission gate.
//! These tests do not create a native window or contact DeepSeek. Windows event
//! delivery and native handle identity still require the documented UI matrix.

use super::while_current;
use crate::sync_session::{SyncSession, UsageSyncKind};
use std::{future::Future, task::Poll, time::Duration};

fn begin_web(session: &SyncSession, request_id: &str) -> u64 {
    session
        .begin_usage(request_id.into(), &[], UsageSyncKind::Web, || ())
        .unwrap()
        .generation
}

#[test]
fn r18_native_close_revokes_commit_before_deferred_cleanup_runs() {
    let session = SyncSession::default();
    let generation = begin_web(&session, "native-close");
    let lifetime = session.login_window_lifetime(generation).unwrap();
    assert!(lifetime.close());

    // The UI callback has not run its deferred state/notification task yet.
    assert!(!session.is_current(generation));
    assert!(!session.status().active);
    assert_eq!(session.active_generation(), None);
    assert!(session
        .commit::<()>(generation, || panic!("closed login must not persist"))
        .is_err());
    assert!(session
        .with_current::<()>(generation, || panic!("closed login must not reopen"))
        .is_err());
    assert!(session.login_window_lifetime(generation).is_err());

    let ended = session.close_web_window(generation).unwrap();
    assert!(!ended.active);
    assert_eq!(ended.generation, generation);
    assert_eq!(ended.request_id.as_deref(), Some("native-close"));
    // CloseRequested followed by Destroyed must not emit a second ended event.
    assert!(!lifetime.close());
    assert!(session.close_web_window(generation).is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn r18_ipc_and_watcher_wait_gate_discards_late_verification_after_close() {
    // Both production paths use while_current, followed by the same commit gate.
    for source in ["ipc", "watcher"] {
        let session = SyncSession::default();
        let generation = begin_web(&session, source);
        let lifetime = session.login_window_lifetime(generation).unwrap();
        let (release, blocked) = tokio::sync::oneshot::channel();
        let mut waiting = Box::pin(while_current(async { blocked.await.unwrap() }, || {
            session.is_current(generation)
        }));
        std::future::poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        // Native close wins before the pending network response becomes ready.
        lifetime.close();
        release.send("SYNTHETIC_LATE_TOKEN").unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("closed login must stop waiting")
            .is_none());
        assert!(session
            .commit::<()>(generation, || panic!("late verification must not save"))
            .is_err());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r18_native_close_drops_a_verification_that_never_responds() {
    let session = SyncSession::default();
    let generation = begin_web(&session, "pending-network");
    let lifetime = session.login_window_lifetime(generation).unwrap();
    let (release, blocked) = tokio::sync::oneshot::channel::<()>();
    let mut waiting = Box::pin(while_current(async { blocked.await.unwrap() }, || {
        session.is_current(generation)
    }));
    std::future::poll_fn(|cx| {
        assert!(waiting.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    lifetime.close();
    assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("no network response is required to cancel")
        .is_none());
    assert!(
        release.is_closed(),
        "the old request future must be dropped"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r18_close_between_verified_result_and_commit_still_rejects_persistence() {
    let session = SyncSession::default();
    let generation = begin_web(&session, "verified-before-close");
    let lifetime = session.login_window_lifetime(generation).unwrap();
    let token = while_current(async { "SYNTHETIC_VERIFIED_TOKEN" }, || {
        session.is_current(generation)
    })
    .await
    .unwrap();
    lifetime.close();
    let mut saved = "original";
    assert!(session
        .commit(generation, || {
            saved = token;
            Ok(())
        })
        .is_err());
    assert_eq!(saved, "original");
}

#[test]
fn r18_delayed_old_window_close_preserves_new_web_and_manual_owners() {
    for kind in [UsageSyncKind::Web, UsageSyncKind::Manual] {
        let session = SyncSession::default();
        let old = begin_web(&session, "old-window");
        let old_lifetime = session.login_window_lifetime(old).unwrap();
        let new = session
            .begin_usage("new-owner".into(), &[], kind, || ())
            .unwrap();
        // Simulates an old handle's late Destroyed after the new owner exists.
        old_lifetime.close();
        assert!(session.close_web_window(old).is_none());
        assert!(session.is_current(new.generation));
        if matches!(kind, UsageSyncKind::Manual) {
            assert!(session.login_window_lifetime(new.generation).is_err());
            assert!(session.close_web_window(new.generation).is_none());
        }
        assert_eq!(
            session.commit(new.generation, || Ok("new-token")).unwrap(),
            "new-token"
        );
        assert!(session
            .commit::<()>(old, || panic!("old token cannot overwrite new owner"))
            .is_err());
    }
}

#[test]
fn r18_native_signal_never_reenters_a_builder_or_commit_holding_the_session_lock() {
    let session = SyncSession::default();
    let building = begin_web(&session, "building");
    let building_lifetime = session.login_window_lifetime(building).unwrap();
    session
        .with_current(building, || {
            // A UI callback must be able to publish close while another thread
            // owns this lock and waits for native window creation to finish.
            assert!(building_lifetime.close());
            Ok(())
        })
        .unwrap();
    assert!(!session.is_current(building));
    assert!(session.close_web_window(building).is_some());

    let saving = begin_web(&session, "saving");
    let saving_lifetime = session.login_window_lifetime(saving).unwrap();
    let mut stored = "original";
    session
        .commit(saving, || {
            // Commit admission won first. A later close cannot undo the write
            // or produce a false ended/cancel event after successful capture.
            assert!(saving_lifetime.close());
            stored = "captured";
            Ok(())
        })
        .unwrap();
    assert_eq!(stored, "captured");
    assert!(session.close_web_window(saving).is_none());
    assert!(!session.status().active);
}

#[test]
fn r18_successful_programmatic_close_does_not_report_cancellation() {
    let session = SyncSession::default();
    let generation = begin_web(&session, "successful");
    let lifetime = session.login_window_lifetime(generation).unwrap();
    assert_eq!(
        session.commit(generation, || Ok("captured")).unwrap(),
        "captured"
    );
    // Production closes the captured handle only after commit releases its lock.
    lifetime.close();
    assert!(session.close_web_window(generation).is_none());
    assert!(session.commit(generation, || Ok(())).is_err());
}

#[test]
fn r18_failed_commit_closed_during_persistence_cannot_retry_the_old_token() {
    let session = SyncSession::default();
    let generation = begin_web(&session, "failed-save");
    let lifetime = session.login_window_lifetime(generation).unwrap();
    assert_eq!(
        session
            .commit::<()>(generation, || {
                lifetime.close();
                Err("synthetic disk failure".into())
            })
            .unwrap_err(),
        "synthetic disk failure"
    );
    assert!(session
        .commit::<()>(generation, || panic!("a closed window cannot retry"))
        .is_err());
    assert!(session.close_web_window(generation).is_some());
    let next = begin_web(&session, "explicit-retry");
    assert!(session.commit(next, || Ok(())).is_ok());
}

#[test]
fn r18_cancel_clear_and_forget_tolerate_their_old_windows_late_events() {
    for operation in ["cancel", "clear", "forget"] {
        let session = SyncSession::default();
        let generation = begin_web(&session, "old-window");
        let lifetime = session.login_window_lifetime(generation).unwrap();
        match operation {
            "cancel" => {
                assert!(session
                    .cancel_usage("old-window", Some(generation), || ())
                    .is_some());
            }
            "clear" => session.clear_usage(&[], || Ok(())).unwrap(),
            "forget" => session.start_clear(&[], || Ok(())).unwrap(),
            _ => unreachable!(),
        }
        lifetime.close();
        assert!(session.close_web_window(generation).is_none());
        assert!(session.commit(generation, || Ok(())).is_err());
        if operation == "forget" {
            assert!(session
                .begin_usage("blocked".into(), &[], UsageSyncKind::Web, || ())
                .is_err());
            session.finish_clear();
        }
        let next = begin_web(&session, "next-window");
        assert!(session.close_web_window(generation).is_none());
        assert!(session.is_current(next));
    }
}

#[cfg(windows)]
#[test]
fn r18_closed_login_cannot_change_encrypted_config_or_credential_revisions() {
    use crate::config::{edit_validated_credential, read_stored_config, ValidatedCredential};
    use crate::test_support::TempConfigDir;

    let dir = TempConfigDir::new("r18-closed-login");
    edit_validated_credential(ValidatedCredential::ApiKey, "SYNTHETIC_KEY".into()).unwrap();
    edit_validated_credential(ValidatedCredential::UsageToken, "SYNTHETIC_ORIGINAL".into())
        .unwrap();
    let bytes = std::fs::read(dir.join("config.json")).unwrap();
    let before = read_stored_config().unwrap();
    let session = SyncSession::default();
    let generation = begin_web(&session, "closed-before-persist");
    session.login_window_lifetime(generation).unwrap().close();
    // Use the exact credential-write operation used by capture_usage_token.
    assert!(session
        .commit(generation, || {
            edit_validated_credential(ValidatedCredential::UsageToken, "SYNTHETIC_LATE".into())
        })
        .is_err());
    let after = read_stored_config().unwrap();
    assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), bytes);
    assert_eq!(after.api_key, before.api_key);
    assert_eq!(after.usage_token, before.usage_token);
    assert_eq!(after.config_revision, before.config_revision);
    assert_eq!(after.api_key_revision, before.api_key_revision);
    assert_eq!(after.usage_token_revision, before.usage_token_revision);
}
