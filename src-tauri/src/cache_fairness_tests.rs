//! R22：实际缓存收集 → 生产批调度 → 生产多月探针 → 取消/seen 的回归。
//! 只注入单月请求、合成时钟与 deadline 等待，不访问网络、不等待真实 15/30 秒。
//! 本文件是待本机执行的测试源码，不是测试通过记录。

use super::*;
use crate::{
    sync_session::{SyncSession, UsageSyncKind},
    test_support::TempConfigDir,
    token_sync::collect_cached_usage_tokens_in,
};
use std::{
    cell::{Cell, RefCell},
    future::{poll_fn, Future},
    path::Path,
    rc::Rc,
    task::Poll,
};

const A: &str = "synthetic-r22-session-token-A";
const B: &str = "synthetic-r22-session-token-B";
const C: &str = "synthetic-r22-session-token-new-C";
const MONTHS: [(u32, u32); 2] = [(11, 2026), (10, 2026)];

#[derive(Clone)]
struct Clock {
    base: Instant,
    elapsed: Rc<Cell<Duration>>,
}

impl Clock {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            elapsed: Rc::new(Cell::new(Duration::ZERO)),
        }
    }

    fn now(&self) -> Instant {
        self.base + self.elapsed.get()
    }

    fn wait_until(&self, deadline: Instant) -> impl Future<Output = ()> + 'static {
        let clock = self.clone();
        poll_fn(move |_| {
            if clock.now() >= deadline {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
    }
}

#[derive(Clone, Copy)]
struct Step {
    seconds: u64,
    result: Option<Result<(), VerifyFailure>>,
}

fn response(seconds: u64, result: Result<(), VerifyFailure>) -> Step {
    Step {
        seconds,
        result: Some(result),
    }
}

#[derive(Clone)]
struct Network {
    clock: Clock,
    steps: Rc<RefCell<HashMap<(String, u32), VecDeque<Step>>>>,
    visited: Rc<RefCell<Vec<(String, u32, u32)>>>,
    default_transient: bool,
}

impl Network {
    fn new() -> Self {
        Self {
            clock: Clock::new(),
            steps: Rc::default(),
            visited: Rc::default(),
            default_transient: false,
        }
    }

    fn add(&self, token: &str, month: u32, step: Step) {
        self.steps
            .borrow_mut()
            .entry((token.to_string(), month))
            .or_default()
            .push_back(step);
    }

    fn slow(&self, token: &str) {
        self.add(token, 11, response(15, Err(VerifyFailure::Transient)));
        // 上月请求已发出，在批 deadline 到达时仍未完成，生产 select 必须丢弃它。
        self.add(
            token,
            10,
            Step {
                seconds: 15,
                result: None,
            },
        );
    }

    fn request(
        &self,
        token: String,
        month: u32,
        year: u32,
    ) -> impl Future<Output = Result<(), VerifyFailure>> + 'static {
        let network = self.clone();
        async move {
            let step = network
                .steps
                .borrow_mut()
                .get_mut(&(token.clone(), month))
                .and_then(VecDeque::pop_front)
                .or_else(|| {
                    network
                        .default_transient
                        .then_some(response(0, Err(VerifyFailure::Transient)))
                })
                .expect("发生未配置的单月请求");
            network.visited.borrow_mut().push((token, month, year));
            let mut advance = true;
            poll_fn(move |cx| {
                if advance {
                    advance = false;
                    network
                        .clock
                        .elapsed
                        .set(network.clock.elapsed.get() + Duration::from_secs(step.seconds));
                    // 先推进时间并让生产 deadline 再 poll，然后才交付响应。
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                match step.result {
                    Some(result) => Poll::Ready(result),
                    None => Poll::Pending,
                }
            })
            .await
        }
    }
}

fn write_cache(path: &Path, tokens: &[&str]) {
    let text: String = tokens
        .iter()
        .map(|token| format!(r#"{{"token":"{token}","id_profile":{{}},"feature_gates":[]}}"#))
        .collect();
    std::fs::write(path, text).unwrap();
}

async fn verify_collected(
    scan: &mut CacheScanState,
    state: &mut CandidateVerificationState,
    candidates: Vec<CachedCandidate>,
    network: &Network,
) -> Option<String> {
    verify_candidates_with(
        scan,
        state,
        candidates,
        &MONTHS,
        || true,
        || network.clock.now(),
        |deadline| network.clock.wait_until(deadline),
        |token, month, year| network.request(token, month, year),
    )
    .await
}

async fn round(
    scan: &mut CacheScanState,
    state: &mut CandidateVerificationState,
    dir: &Path,
    network: &Network,
) -> Option<String> {
    let candidates = state.collect_for_round(scan, |scan| {
        collect_cached_usage_tokens_in(scan, dir, || true)
    });
    verify_collected(scan, state, candidates, network).await
}

#[tokio::test(flavor = "current_thread")]
async fn r22_单文件_A两月占满30秒_B下轮先试并成功短路() {
    let dir = TempConfigDir::new("r22-slow-a-fast-b");
    write_cache(&dir.join("sessions"), &[A, B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let network = Network::new();
    network.slow(A);
    network.add(B, 11, response(0, Ok(())));

    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    assert_eq!(network.clock.elapsed.get(), Duration::from_secs(30));
    assert_eq!(
        *network.visited.borrow(),
        vec![(A.into(), 11, 2026), (A.into(), 10, 2026)]
    );
    assert_eq!(
        state.pending.len(),
        1,
        "驻留快照按来源分组而非逐 Token 克隆路径"
    );
    assert_eq!(
        collect_cached_usage_tokens_in(&mut scan, &dir, || true).len(),
        2
    );

    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(B)
    );
    assert_eq!(network.visited.borrow().last(), Some(&(B.into(), 11, 2026)));
    assert_eq!(
        network.visited.borrow().len(),
        3,
        "B 成功后不请求上月，也不重试 A"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r22_多个来源_未试文件优先于旧文件的Transient重试() {
    let dir = TempConfigDir::new("r22-many-sources");
    write_cache(&dir.join("one"), &[A]);
    write_cache(&dir.join("two"), &[B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let candidates = collect_cached_usage_tokens_in(&mut scan, &dir, || true);
    let first = candidates[0].token.clone();
    let second = candidates[1].token.clone();
    let network = Network::new();
    network.slow(&first);
    network.add(&second, 11, response(0, Ok(())));
    assert!(
        verify_collected(&mut scan, &mut state, candidates, &network)
            .await
            .is_none()
    );
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network).await,
        Some(second)
    );
    assert_eq!(network.visited.borrow().len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn r22_首批仍有未试候选时继续扫描后批_不堵住第251来源() {
    let dir = TempConfigDir::new("r22-next-scan-batch");
    for i in 0..=crate::token_sync::MAX_SCAN_FILES {
        write_cache(
            &dir.join(format!("f_{i:03}")),
            &[&format!("synthetic-r22-next-batch-token-{i:03}")],
        );
    }
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let initial = state.collect_for_round(&mut scan, |scan| {
        collect_cached_usage_tokens_in(scan, &dir, || true)
    });
    assert!(initial.len() > 1 && initial.len() <= crate::token_sync::MAX_SCAN_FILES);
    let mut network = Network::new();
    network.default_transient = true;
    network.slow(&initial[0].token);
    network.slow(&initial[1].token);
    assert!(verify_collected(&mut scan, &mut state, initial, &network)
        .await
        .is_none());
    assert!(!state.pending.is_empty());
    let mut next_token = None;
    let candidates = state.collect_for_round(&mut scan, |scan| {
        let fresh = collect_cached_usage_tokens_in(scan, &dir, || true);
        let token = fresh
            .first()
            .expect("首批文件预算之后必须继续后部目录")
            .token
            .clone();
        network.add(&token, 11, response(0, Ok(())));
        next_token = Some(token);
        fresh
    });
    assert!(
        next_token.is_some(),
        "容量未满时不能被首批慢候选挡住目录游标"
    );
    // 交替先给旧批第二个慢来源一次机会，随后新批的有效来源必须能完成。
    assert!(
        verify_collected(&mut scan, &mut state, candidates, &network)
            .await
            .is_none()
    );
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network).await,
        next_token
    );
    assert_eq!(network.clock.elapsed.get(), Duration::from_secs(60));
}

#[tokio::test(flavor = "current_thread")]
async fn r22_跨文件同值A不提前seen_第二来源的B仍可验证() {
    let dir = TempConfigDir::new("r22-duplicate-sources");
    write_cache(&dir.join("one"), &[A]);
    write_cache(&dir.join("two"), &[A, B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let mut candidates = collect_cached_usage_tokens_in(&mut scan, &dir, || true);
    // read_dir 不保证路径顺序；明确选择“单候选来源在前”的生产输入排列。
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    let network = Network::new();
    network.slow(A);
    network.slow(A);
    network.add(B, 11, response(0, Ok(())));
    assert!(
        verify_collected(&mut scan, &mut state, candidates, &network)
            .await
            .is_none()
    );
    assert_eq!(
        collect_cached_usage_tokens_in(&mut scan, &dir, || true).len(),
        3
    );
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(B)
    );
    assert_eq!(network.visited.borrow().len(), 5);
}

#[tokio::test(flavor = "current_thread")]
async fn r22_跨轮全拒绝才seen_跳过已拒绝_未完成请求不算拒绝() {
    let dir = TempConfigDir::new("r22-all-rejected");
    write_cache(&dir.join("sessions"), &[A, B, C]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let network = Network::new();
    for token in [A, B, C, C] {
        network.add(token, 11, response(11, Err(VerifyFailure::Definitive)));
    }
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    // A/B 在 11/22 秒拒绝；C 的响应因批 deadline 丢弃，不能提前标记整个文件。
    assert_eq!(
        collect_cached_usage_tokens_in(&mut scan, &dir, || true).len(),
        3
    );
    assert_eq!(state.files.values().next().unwrap().rejected_count, 2);
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    assert!(collect_cached_usage_tokens_in(&mut scan, &dir, || true).is_empty());
    assert!(state.files.is_empty());
    assert_eq!(
        *network.visited.borrow(),
        vec![
            (A.into(), 11, 2026),
            (B.into(), 11, 2026),
            (C.into(), 11, 2026),
            (C.into(), 11, 2026),
        ],
        "已拒绝的 A/B 不重试，也不请求上月"
    );
    write_cache(&dir.join("sessions"), &[C]);
    network.add(C, 11, response(0, Ok(())));
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(C),
        "旧 stamp 的 seen 不能遮蔽新版本文件"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r22_全部暂不可用不seen_网络恢复可再次成功() {
    let dir = TempConfigDir::new("r22-transient-recovery");
    write_cache(&dir.join("session"), &[A]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let network = Network::new();
    network.add(A, 11, response(0, Err(VerifyFailure::Transient)));
    network.add(A, 10, response(0, Err(VerifyFailure::Transient)));
    network.add(A, 11, response(0, Ok(())));
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    assert!(
        state.pending.is_empty(),
        "所有候选已试过一遍后允许目录继续扫描"
    );
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(A)
    );
    assert_eq!(network.visited.borrow().len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn r22_保留批次期间文件更新_新快照替换旧游标且不漏新候选() {
    let dir = TempConfigDir::new("r22-file-change");
    let path = dir.join("sessions");
    write_cache(&path, &[A, B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let network = Network::new();
    network.slow(A);
    network.add(B, 11, response(0, Err(VerifyFailure::Definitive)));
    network.add(A, 11, response(0, Err(VerifyFailure::Definitive)));
    network.add(C, 11, response(0, Ok(())));
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    write_cache(&path, &[C]); // 大小必变，不依赖文件系统修改时间精度。
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(C)
    );
    assert!(state.pending.is_empty());
    assert_eq!(
        network.visited.borrow().len(),
        3,
        "新快照替换后不再请求旧快照 A/B"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r22_元数据相同而快照不同_不能继承旧拒绝或游标() {
    let dir = TempConfigDir::new("r22-snapshot-change");
    write_cache(&dir.join("sessions"), &[A, B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let network = Network::new();
    network.add(A, 11, response(0, Err(VerifyFailure::Definitive)));
    network.slow(B);
    assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
    let mut candidates = collect_cached_usage_tokens_in(&mut scan, &dir, || true);
    assert_eq!(candidates.len(), 2);
    candidates[0].token = C.into(); // 模拟相同大小/mtime 下读取到不同快照。
    network.add(C, 11, response(0, Ok(())));
    assert_eq!(
        verify_collected(&mut scan, &mut state, candidates, &network)
            .await
            .as_deref(),
        Some(C)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn r22_预扫描与watcher独立_仅重复一次A而非每轮重新开始() {
    let dir = TempConfigDir::new("r22-independent-lifetimes");
    write_cache(&dir.join("sessions"), &[A, B]);
    let network = Network::new();
    network.slow(A);
    network.slow(A);
    network.add(B, 11, response(0, Ok(())));
    {
        let mut prescan = CacheScanState::default();
        let mut progress = CandidateVerificationState::default();
        assert!(round(&mut prescan, &mut progress, &dir, &network)
            .await
            .is_none());
    }
    let mut watcher = CacheScanState::default();
    let mut progress = CandidateVerificationState::default();
    assert!(round(&mut watcher, &mut progress, &dir, &network)
        .await
        .is_none());
    assert_eq!(
        round(&mut watcher, &mut progress, &dir, &network)
            .await
            .as_deref(),
        Some(B)
    );
    assert_eq!(network.visited.borrow().len(), 5);
    assert_eq!(network.clock.elapsed.get(), Duration::from_secs(60));
}

#[tokio::test(flavor = "current_thread")]
async fn r22_4096来源饱和后_未试候选仍保留席位_序号回绕不破坏上限() {
    let dir = TempConfigDir::new("r22-capacity");
    let count = MAX_VERIFICATION_FILES + 3;
    for i in 0..count {
        write_cache(
            &dir.join(format!("f_{i:05}")),
            &[&format!("synthetic-r22-capacity-token-{i:05}")],
        );
    }
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let mut network = Network::new();
    network.default_transient = true;
    let mut observed = std::collections::HashSet::new();
    for _ in 0..count {
        assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
        observed.extend(
            network
                .visited
                .borrow()
                .iter()
                .map(|(token, _, _)| token.clone()),
        );
        assert!(state.files.len() <= MAX_VERIFICATION_FILES);
        assert!(
            state
                .files
                .values()
                .map(|p| p.rejected.len())
                .sum::<usize>()
                <= MAX_REJECTION_WORDS
        );
        if observed.len() == count {
            break;
        }
    }
    assert_eq!(observed.len(), count, "实际目录分页必须遍历全部来源");
    // 已达到容量上限，再让目录中的一个来源变成 [A 慢, B 快]。
    write_cache(&dir.join("f_00000"), &[A, B]);
    network.slow(A);
    network.add(B, 11, response(0, Ok(())));
    state.sequence = u64::MAX;
    for _ in 0..count {
        assert!(round(&mut scan, &mut state, &dir, &network).await.is_none());
        if network
            .visited
            .borrow()
            .iter()
            .any(|(token, _, _)| token == A)
        {
            break;
        }
    }
    assert!(network
        .visited
        .borrow()
        .iter()
        .any(|(token, _, _)| token == A));
    assert!(!state.pending.is_empty());
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(B)
    );
    assert!(state.files.len() <= MAX_VERIFICATION_FILES);
    assert!(state.sequence < u64::MAX);
}

#[tokio::test(flavor = "current_thread")]
async fn r22_首请求前预算耗尽_不置拒绝位且下轮仍从未试候选开始() {
    let dir = TempConfigDir::new("r22-no-budget");
    write_cache(&dir.join("sessions"), &[A, B]);
    let mut scan = CacheScanState::default();
    let mut state = CandidateVerificationState::default();
    let candidates = collect_cached_usage_tokens_in(&mut scan, &dir, || true);
    let base = Instant::now();
    let ticks = Cell::new(0);
    let requests = Cell::new(0);
    assert!(verify_candidates_with(
        &mut scan,
        &mut state,
        candidates,
        &MONTHS,
        || true,
        || {
            let previous = ticks.replace(ticks.get() + 1);
            base + if previous == 0 {
                Duration::ZERO
            } else {
                CANDIDATE_BATCH_BUDGET
            }
        },
        |_| std::future::pending::<()>(),
        |_, _, _| {
            requests.set(requests.get() + 1);
            std::future::ready(Ok(()))
        },
    )
    .await
    .is_none());
    assert_eq!(requests.get(), 0);
    let progress = state.files.values().next().unwrap();
    assert_eq!(progress.untried, 2);
    assert_eq!(progress.rejected_count, 0);
    let network = Network::new();
    network.add(A, 11, response(0, Err(VerifyFailure::Definitive)));
    network.add(B, 11, response(0, Ok(())));
    assert_eq!(
        round(&mut scan, &mut state, &dir, &network)
            .await
            .as_deref(),
        Some(B)
    );
    assert_eq!(
        network.visited.borrow().first(),
        Some(&(A.into(), 11, 2026))
    );
}

#[test]
fn r22_拒绝位图总预算有界_旧批次淘汰不误标seen() {
    let mut state = CandidateVerificationState::default();
    state.files.insert(
        PathBuf::from("old"),
        FileVerificationProgress {
            stamp: (1, None),
            fingerprint: [0; 32],
            next_candidate: 0,
            untried: 0,
            rejected: vec![0; MAX_REJECTION_WORDS],
            rejected_count: 0,
            first_observed: 1,
            last_attempt: 1,
            last_observed: 2,
        },
    );
    state.sequence = 2;
    state.prepare(vec![CachedCandidate {
        token: A.into(),
        path: PathBuf::from("new"),
        stamp: (2, None),
    }]);
    assert!(!state.files.contains_key(Path::new("old")));
    assert!(state.files.contains_key(Path::new("new")));
    assert!(
        state
            .files
            .values()
            .map(|progress| progress.rejected.len())
            .sum::<usize>()
            <= MAX_REJECTION_WORDS
    );
}

#[test]
fn r22_无效UTF8膨胀按解码后最坏字节预留_来源与载荷均有硬边界() {
    let dir = TempConfigDir::new("r22-lossy-utf8-budget");
    let mut bytes = br#"{"token":""#.to_vec();
    bytes.extend(std::iter::repeat_n(0xff, 256 * 1024));
    bytes.extend_from_slice(br#"","id_profile":{},"feature_gates":[]}"#);
    let input_bytes = bytes.len() as u64;
    std::fs::write(dir.join("binary-cache"), bytes).unwrap();
    let candidates = collect_cached_usage_tokens_in(&mut CacheScanState::default(), &dir, || true);
    assert_eq!(candidates.len(), 1);
    let decoded = candidates[0].token.len() as u64;
    assert!(decoded > input_bytes * 2, "必须确实经过生产有损 UTF-8 解码");
    assert!(decoded <= input_bytes * 3);
    assert_eq!(
        MAX_COLLECTED_TOKEN_BYTES,
        3 * crate::token_sync::MAX_SCAN_BYTES
    );
    assert!(can_collect_more(
        0,
        MAX_PENDING_TOKEN_BYTES - MAX_COLLECTED_TOKEN_BYTES
    ));
    assert!(!can_collect_more(
        0,
        MAX_PENDING_TOKEN_BYTES - MAX_COLLECTED_TOKEN_BYTES + 1
    ));
    assert!(can_collect_more(
        MAX_VERIFICATION_FILES - crate::token_sync::MAX_SCAN_FILES,
        0
    ));
    assert!(!can_collect_more(
        MAX_VERIFICATION_FILES - crate::token_sync::MAX_SCAN_FILES + 1,
        0
    ));
    assert!(!can_collect_more(usize::MAX, u64::MAX));

    let mut state = CandidateVerificationState::default();
    state.pending = (0..MAX_VERIFICATION_FILES)
        .map(|i| CandidateFile {
            path: PathBuf::from(format!("pending-{i}")),
            stamp: (1, None),
            tokens: vec![A.into()],
            remaining_this_round: 1,
        })
        .collect();
    let retained = state.collect_for_round(&mut CacheScanState::default(), |_| {
        panic!("没有预留下一整批来源容量时不得继续扫描或逐出未试来源")
    });
    assert_eq!(retained.len(), MAX_VERIFICATION_FILES);
}

#[tokio::test(flavor = "current_thread")]
async fn r22_批校验挂起时窗口关闭或新代际_丢弃迟到成功且不seen() {
    for mode in ["close-late", "new-generation", "close-no-response"] {
        let dir = TempConfigDir::new("r22-cancel-chain");
        write_cache(&dir.join("sessions"), &[A, B]);
        let session = SyncSession::default();
        let generation = session
            .begin_usage("old".into(), &[], UsageSyncKind::Web, || ())
            .unwrap()
            .generation;
        let lifetime = session.login_window_lifetime(generation).unwrap();
        let mut scan = CacheScanState::default();
        let mut state = CandidateVerificationState::default();
        let candidates = collect_cached_usage_tokens_in(&mut scan, &dir, || true);
        let clock = Clock::new();
        let (release, blocked) = tokio::sync::oneshot::channel();
        let mut blocked = Some(blocked);
        let started = Cell::new(0);
        let mut waiting = Box::pin(verify_candidates_with(
            &mut scan,
            &mut state,
            candidates,
            &MONTHS,
            || session.is_current(generation),
            || clock.now(),
            |deadline| clock.wait_until(deadline),
            |_, _, _| {
                started.set(started.get() + 1);
                let blocked = blocked.take().expect("取消后不能启动 B 或上月请求");
                async move { blocked.await.unwrap() }
            },
        ));
        poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(started.get(), 1);
        if mode == "new-generation" {
            session
                .begin_usage("new".into(), &[], UsageSyncKind::Web, || ())
                .unwrap();
        } else {
            lifetime.close();
        }
        if mode == "close-no-response" {
            assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .expect("原生关闭不能等候选30秒预算耗尽")
                .is_none());
            assert!(release.is_closed(), "实际批校验必须丢弃仍未完成的单月请求");
        } else {
            release.send(Ok(())).unwrap();
            assert!(waiting.await.is_none());
        }
        assert_eq!(
            collect_cached_usage_tokens_in(&mut scan, &dir, || true).len(),
            2
        );
        assert!(state.pending.is_empty());
        assert_eq!(state.files.values().next().unwrap().rejected_count, 0);
        assert_eq!(state.files.values().next().unwrap().next_candidate, 0);
        assert!(session
            .commit::<()>(generation, || panic!("迟到候选不能落库"))
            .is_err());
    }
}
