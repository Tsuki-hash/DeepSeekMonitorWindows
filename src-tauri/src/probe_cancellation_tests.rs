//! R24/R25：手动保存、登录 IPC 共用的生产多月校验与会话取消链及预算优先级。
//! 仅替换单月 HTTP 请求与预算时钟；不访问网络或创建原生窗口。以下源码尚未运行，
//! Windows / WebView2 的实际命令派发与窗口事件仍须维护者验收。

use super::*;
use crate::sync_session::{LoginWindowLifetime, UsageSyncKind};
use std::{
    cell::{Cell, RefCell},
    future::{poll_fn, Future},
    task::Poll,
};

const MONTHS: [(u32, u32); 2] = [(11, 2026), (10, 2026)];
const CANCELLED: &str = "同步已取消或已被新的操作替代";

fn begin(session: &SyncSession, kind: UsageSyncKind) -> u64 {
    session
        .begin_usage("old".into(), &[], kind, || ())
        .unwrap()
        .generation
}

fn revoke(
    session: &SyncSession,
    generation: u64,
    lifetime: Option<&LoginWindowLifetime>,
    mode: &str,
) {
    match mode {
        "cancel" => {
            assert!(session
                .cancel_usage("old", Some(generation), || ())
                .is_some());
        }
        "close" => {
            // 只发布原生 lifetime 信号，故意不运行延迟会话收尾。
            assert!(lifetime.unwrap().close());
        }
        "replace-web" | "replace-manual" => {
            let kind = if mode == "replace-web" {
                UsageSyncKind::Web
            } else {
                UsageSyncKind::Manual
            };
            let new = session.begin_usage("new".into(), &[], kind, || ()).unwrap();
            assert!(session.is_current(new.generation));
        }
        _ => panic!("未知取消模式"),
    }
    assert!(!session.is_current(generation));
}

#[tokio::test(flavor = "current_thread")]
async fn r25_每月准入分别检查deadline_预算耗尽不是取消() {
    for allowed_checks in [0, 2] {
        let base = Instant::now();
        let deadline = base + CANDIDATE_BATCH_BUDGET;
        let checks = Cell::new(0);
        let visited = RefCell::new(Vec::new());
        let result = probe_token_with(
            &MONTHS,
            || true,
            || {
                let check = checks.replace(checks.get() + 1);
                if check < allowed_checks {
                    base
                } else {
                    deadline
                }
            },
            Some(deadline),
            |month, year| {
                visited.borrow_mut().push((month, year));
                std::future::ready(Err(VerifyFailure::Transient))
            },
        )
        .await;
        assert_eq!(result, ProbeOutcome::BudgetExpired);
        assert_eq!(checks.get(), allowed_checks + 1);
        let expected_count = if allowed_checks == 0 { 0 } else { 1 };
        assert_eq!(visited.borrow().as_slice(), &MONTHS[..expected_count]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r25_响应后取消与deadline先后_取消优先于预算和HTTP结果() {
    for deadline_first in [false, true] {
        for response in [
            Ok(()),
            Err(VerifyFailure::Definitive),
            Err(VerifyFailure::Transient),
        ] {
            let base = Instant::now();
            let deadline = base + CANDIDATE_BATCH_BUDGET;
            let now = Cell::new(base);
            let active = Cell::new(true);
            let visited = RefCell::new(Vec::new());
            let result = probe_token_with(
                &MONTHS,
                || active.get(),
                || now.get(),
                Some(deadline),
                |month, year| {
                    let now = &now;
                    let active = &active;
                    let visited = &visited;
                    async move {
                        visited.borrow_mut().push((month, year));
                        if deadline_first {
                            now.set(deadline);
                        }
                        active.set(false);
                        if !deadline_first {
                            now.set(deadline);
                        }
                        response
                    }
                },
            )
            .await;
            assert_eq!(result, ProbeOutcome::Cancelled);
            assert_eq!(*visited.borrow(), vec![MONTHS[0]]);
        }
    }

    assert_eq!(
        probe_token_with(
            &MONTHS,
            || false,
            || panic!("准入已取消时连预算检查也不需要"),
            Some(Instant::now()),
            |_, _| -> std::future::Ready<Result<(), VerifyFailure>> {
                panic!("已取消时不得发请求")
            },
        )
        .await,
        ProbeOutcome::Cancelled
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r25_未设置批deadline不读取缓存时钟_手动IPC保持HTTP探针语义() {
    for current in [
        Ok(()),
        Err(VerifyFailure::Definitive),
        Err(VerifyFailure::Transient),
    ] {
        let visited = RefCell::new(Vec::new());
        let result = probe_token_with(
            &MONTHS,
            || true,
            || panic!("未设置deadline的共享探针不得读取批时钟"),
            None,
            |month, year| {
                visited.borrow_mut().push((month, year));
                std::future::ready(if month == 11 { current } else { Ok(()) })
            },
        )
        .await;
        let expected = if current == Err(VerifyFailure::Definitive) {
            ProbeOutcome::Rejected
        } else {
            ProbeOutcome::Passed
        };
        assert_eq!(result, expected);
        let expected_count = if current == Err(VerifyFailure::Transient) {
            2
        } else {
            1
        };
        assert_eq!(visited.borrow().as_slice(), &MONTHS[..expected_count]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r24_每月准入前检查取消_不依赖50毫秒唤醒() {
    let checks = Cell::new(0);
    let visited = RefCell::new(Vec::new());
    let result = probe_token_with(
        &MONTHS,
        || {
            let call = checks.get();
            checks.set(call + 1);
            // 当前月准入与响应后仍有效，到上月准入时恰好撤销。
            call < 2
        },
        Instant::now,
        None,
        |month, year| {
            visited.borrow_mut().push((month, year));
            std::future::ready(Err(VerifyFailure::Transient))
        },
    )
    .await;
    assert_eq!(result, ProbeOutcome::Cancelled);
    assert_eq!(*visited.borrow(), vec![MONTHS[0]]);
    assert_eq!(checks.get(), 3);

    let result = probe_token_with(
        &MONTHS,
        || false,
        Instant::now,
        None,
        |_, _| -> std::future::Ready<Result<(), VerifyFailure>> {
            panic!("准入已撤销时不得构造第一个请求")
        },
    )
    .await;
    assert_eq!(result, ProbeOutcome::Cancelled);
}

#[tokio::test(flavor = "current_thread")]
async fn r24_单月响应前撤销_成功拒绝暂时失败均返回独立取消() {
    for response in [
        Ok(()),
        Err(VerifyFailure::Definitive),
        Err(VerifyFailure::Transient),
    ] {
        let active = Cell::new(true);
        let visited = RefCell::new(Vec::new());
        let result = probe_token_with(
            &MONTHS,
            || active.get(),
            Instant::now,
            None,
            |month, year| {
                visited.borrow_mut().push((month, year));
                let active = &active;
                async move {
                    active.set(false);
                    response
                }
            },
        )
        .await;
        assert_eq!(result, ProbeOutcome::Cancelled);
        assert_eq!(*visited.borrow(), vec![MONTHS[0]]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r24_手动和IPC当前月Transient前取消关窗换代_不发上月不提交() {
    for kind in [UsageSyncKind::Manual, UsageSyncKind::Web] {
        for mode in ["cancel", "close", "replace-web", "replace-manual"] {
            if matches!(kind, UsageSyncKind::Manual) && mode == "close" {
                continue; // 手动操作没有自己的登录窗口，不能借旧窗口撤销它。
            }
            let session = SyncSession::default();
            let generation = begin(&session, kind);
            let lifetime = session.login_window_lifetime(generation).ok();
            let visited = RefCell::new(Vec::new());
            let result = verify_session_token_with(&session, generation, &MONTHS, |month, year| {
                let session = &session;
                let lifetime = lifetime.as_ref();
                let visited = &visited;
                async move {
                    visited.borrow_mut().push((month, year));
                    assert_eq!((month, year), MONTHS[0], "撤销后不得启动上月请求");
                    // 在同一次 poll 内先撤销，再交付当前月 Transient，不让计时器介入。
                    revoke(session, generation, lifetime, mode);
                    Err(VerifyFailure::Transient)
                }
            })
            .await;
            assert_eq!(result, Err(CANCELLED.to_string()));
            assert_eq!(*visited.borrow(), vec![MONTHS[0]]);

            // 命令校验失败不会到达保存；即使迟到代码尝试提交，真实 commit 仍拒绝。
            let commits = Cell::new(0);
            assert!(result
                .and_then(|()| {
                    session.commit(generation, || {
                        commits.set(commits.get() + 1);
                        Ok(())
                    })
                })
                .is_err());
            assert!(session
                .commit(generation, || {
                    commits.set(commits.get() + 1);
                    Ok(())
                })
                .is_err());
            assert_eq!(commits.get(), 0);
            if mode.starts_with("replace") {
                assert!(session.status().active, "旧校验不得结束新所有者");
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r24_手动和IPC取消主动drop挂起的当前月或上月请求() {
    for kind in [UsageSyncKind::Manual, UsageSyncKind::Web] {
        for mode in ["cancel", "close", "replace-web", "replace-manual"] {
            if matches!(kind, UsageSyncKind::Manual) && mode == "close" {
                continue;
            }
            for pending_month in [11, 10] {
                let session = SyncSession::default();
                let generation = begin(&session, kind);
                let lifetime = session.login_window_lifetime(generation).ok();
                let visited = RefCell::new(Vec::new());
                let (release, blocked) = tokio::sync::oneshot::channel();
                let mut blocked = Some(blocked);
                let mut waiting = Box::pin(verify_session_token_with(
                    &session,
                    generation,
                    &MONTHS,
                    |month, year| {
                        visited.borrow_mut().push((month, year));
                        let blocked = if month == pending_month {
                            Some(blocked.take().expect("只能发出一次挂起请求"))
                        } else {
                            None
                        };
                        async move {
                            if let Some(blocked) = blocked {
                                blocked.await.unwrap()
                            } else {
                                Err(VerifyFailure::Transient)
                            }
                        }
                    },
                ));
                poll_fn(|cx| {
                    assert!(waiting.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                revoke(&session, generation, lifetime.as_ref(), mode);
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(1), waiting)
                        .await
                        .expect("撤销不得继续等待HTTP超时"),
                    Err(CANCELLED.to_string())
                );
                assert!(release.is_closed(), "必须drop实际生产校验中的在途请求");
                let expected_count = if pending_month == 11 { 1 } else { 2 };
                assert_eq!(visited.borrow().as_slice(), &MONTHS[..expected_count]);
                assert!(session
                    .commit::<()>(generation, || panic!("挂起请求撤销后不得提交"))
                    .is_err());
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r24_手动和IPC保留上月成功与明确拒绝短路() {
    for kind in [UsageSyncKind::Manual, UsageSyncKind::Web] {
        for current in [
            Ok(()),
            Err(VerifyFailure::Transient),
            Err(VerifyFailure::Definitive),
        ] {
            let session = SyncSession::default();
            let generation = begin(&session, kind);
            let visited = RefCell::new(Vec::new());
            let result = verify_session_token_with(&session, generation, &MONTHS, |month, year| {
                visited.borrow_mut().push((month, year));
                std::future::ready(if month == 11 { current } else { Ok(()) })
            })
            .await;
            let expected_count = if current == Err(VerifyFailure::Transient) {
                2
            } else {
                1
            };
            assert_eq!(visited.borrow().as_slice(), &MONTHS[..expected_count]);
            if current == Err(VerifyFailure::Definitive) {
                assert_eq!(result, Err(VerifyFailure::Definitive.message()));
            } else {
                assert_eq!(result, Ok(()));
                assert_eq!(session.commit(generation, || Ok("saved")).unwrap(), "saved");
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn r24_旧登录窗口关闭不撤销新手动探针所有权() {
    let session = SyncSession::default();
    let old = begin(&session, UsageSyncKind::Web);
    let old_lifetime = session.login_window_lifetime(old).unwrap();
    let manual = session
        .begin_usage("manual".into(), &[], UsageSyncKind::Manual, || ())
        .unwrap()
        .generation;
    let visited = RefCell::new(Vec::new());
    let result = verify_session_token_with(&session, manual, &MONTHS, |month, year| {
        visited.borrow_mut().push((month, year));
        if month == 11 {
            assert!(old_lifetime.close());
            assert!(session.close_web_window(old).is_none());
            std::future::ready(Err(VerifyFailure::Transient))
        } else {
            std::future::ready(Ok(()))
        }
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(visited.borrow().as_slice(), &MONTHS);
    assert!(session.commit(manual, || Ok(())).is_ok());
    assert!(session.commit(old, || Ok(())).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn r24_校验成功后手动取消或IPC关窗_最终commit仍拒绝() {
    for kind in [UsageSyncKind::Manual, UsageSyncKind::Web] {
        let session = SyncSession::default();
        let generation = begin(&session, kind);
        let lifetime = session.login_window_lifetime(generation).ok();
        verify_session_token_with(&session, generation, &MONTHS, |_, _| {
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        let mode = if matches!(kind, UsageSyncKind::Manual) {
            "cancel"
        } else {
            "close"
        };
        revoke(&session, generation, lifetime.as_ref(), mode);
        assert!(session
            .commit::<()>(generation, || panic!("校验结果不能替代最终提交守卫"))
            .is_err());
    }
}
