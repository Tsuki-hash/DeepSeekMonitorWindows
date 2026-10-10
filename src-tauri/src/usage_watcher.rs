//! 用量登录同步：登录窗、缓存候选验证与后台 watcher。
//!
//! 从 lib.rs 拆出（评审 F-22）。三条捕获路径汇聚到 `capture_usage_token`：
//! 1. 注入脚本经 IPC 命中 `usage_token_captured` 命令（commands 模块转发）；
//! 2. 点击同步时的缓存预扫描（`prescan_cached_token`，异步）；
//! 3. 后台 watcher 的周期扫描（`spawn_title_watcher`，独立线程）。
//!
//! 验证策略（评审 F-24/F-25）：缓存候选**先收集后验证**，单个候选的网络校验
//! 不再卡住扫描循环；试调月用东八区当前月 + 上月，不再用固定历史月
//! （平台归档旧数据后固定月会恒失败）。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::cache_watch;
use crate::config::{to_app_config, AppConfig};
use crate::deepseek_api::{verify_usage_token, VerifyFailure};
use crate::sync_script::USAGE_SYNC_POLL_JS;
use crate::sync_session::SyncSession;
use crate::token_sync::{
    collect_webview_cached_usage_tokens_while, mark_seen, webview_cache_dir, CacheScanState,
    CachedCandidate,
};

/// 仅用于识别并清除历史 title 通道残留，不再解析其中的 token。
pub(crate) const USAGE_TOKEN_TITLE_PREFIX: &str = "DSM_USAGE_TOKEN:";

/// watcher 轮次上限（每轮最多等 4s；实际多由登录窗口关闭提前退出）。
const MAX_WATCH_ROUNDS: u32 = 1200;
/// 登录初期快扫节奏；连续空转后放慢，配合目录事件即时唤醒。
const FAST_POLL_MS: u64 = 1500;
const SLOW_POLL_MS: u64 = 4000;
const FAST_POLL_ROUNDS: u32 = 20;

/// 东八区当前 (月, 年)。平台按北京时间记账，试调月不能用本机时区：
/// 海外机器在月初会把「北京时间的新月」错算成上个月。
pub(crate) fn cst_month(now: SystemTime) -> (u32, u32) {
    const CST_OFFSET_SECS: i64 = 8 * 3600;
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
        + CST_OFFSET_SECS;
    let days = secs.div_euclid(86_400);
    let (year, month, _) = civil_from_days(days);
    (month, year as u32)
}

/// 天数 → (年, 月, 日)。Howard Hinnant 的 civil_from_days 算法，公历无歧义、
/// 不引入 chrono 依赖（整个项目只用这一处历法换算）。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

/// 校验试调月：东八区当前月在前、上月兜底。
///
/// 当月月初可能还没有任何请求（接口对空月份未必返回 200），上月兜底；
/// 旧实现固定用 2026-01，平台一旦归档历史数据就会恒失败（评审 F-24）。
fn verify_probe_months(now: SystemTime) -> Vec<(u32, u32)> {
    let (month, year) = cst_month(now);
    let previous = if month == 1 {
        (12, year - 1)
    } else {
        (month - 1, year)
    };
    vec![(month, year), previous]
}

/// 探针结果：通过 / 明确拒绝（401/403，与探针月份无关）/ 暂不可用（网络、
/// 服务端或路由类失败，值得换探针月或稍后重试）。
enum ProbeOutcome {
    Passed,
    Rejected,
    Unavailable,
}

async fn probe_token(token: &str, probes: &[(u32, u32)]) -> ProbeOutcome {
    for (month, year) in probes {
        match verify_usage_token(token, *month, *year).await {
            Ok(()) => return ProbeOutcome::Passed,
            // 对凭据本身的拒绝与查询月份无关，无需再试其他探针月
            Err(VerifyFailure::Definitive) => return ProbeOutcome::Rejected,
            Err(VerifyFailure::Transient) => {}
        }
    }
    ProbeOutcome::Unavailable
}

async fn while_current<T>(
    future: impl std::future::Future<Output = T>,
    is_current: impl Fn() -> bool,
) -> Option<T> {
    if !is_current() {
        return None;
    }
    tokio::select! {
        _ = async {
            while is_current() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        } => None,
        value = future => is_current().then_some(value),
    }
}

/// 收集到的候选逐一验证：
/// - 通过 → 返回该 token，来源文件保持未标记（成功即同步结束，状态随之丢弃）；
/// - 明确拒绝 → 回写已读标记，后续轮次不再弹出；
/// - 瞬时失败 → 保持未标记，下一轮自动重试（否则一次网络抖动会把有效
///   Token 静默压制到文件内容变化为止）。
///
/// 日志只落计数，token 本身与缓存原文绝不进日志。
async fn verify_candidates(
    scan: &mut CacheScanState,
    candidates: Vec<CachedCandidate>,
    is_current: impl Fn() -> bool,
) -> Option<String> {
    if candidates.is_empty() {
        return None;
    }
    let probes = verify_probe_months(SystemTime::now());
    let mut rejected = 0usize;
    let mut unavailable = 0usize;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut files: std::collections::HashMap<_, (crate::token_sync::Stamp, bool)> =
        std::collections::HashMap::new();
    for candidate in candidates {
        if !is_current() {
            return None;
        }
        let file = files
            .entry(candidate.path.clone())
            .or_insert((candidate.stamp, true));
        if Instant::now() >= deadline {
            file.1 = false;
            continue;
        }
        let outcome = while_current(
            tokio::time::timeout(
                deadline.saturating_duration_since(Instant::now()),
                probe_token(&candidate.token, &probes),
            ),
            &is_current,
        )
        .await?
        .unwrap_or(ProbeOutcome::Unavailable);
        match outcome {
            ProbeOutcome::Passed => return Some(candidate.token),
            ProbeOutcome::Rejected => {
                rejected += 1;
            }
            ProbeOutcome::Unavailable => {
                unavailable += 1;
                file.1 = false;
            }
        }
    }
    for (path, (stamp, all_rejected)) in files {
        if all_rejected {
            mark_seen(scan, path, stamp);
        }
    }
    if unavailable > 0 {
        log::warn!(
            "缓存的 {unavailable} 个候选用量 Token 因网络/服务端原因暂未验证成功，下轮自动重试"
        );
    }
    if rejected > 0 {
        log::warn!("缓存的 {rejected} 个候选用量 Token 已被明确拒绝，请重新同步或手动粘贴");
    }
    None
}

/// 收集 + 验证的完整一轮（两者分离，见 token_sync 的收集语义）。
async fn collect_and_verify(
    scan: &mut CacheScanState,
    app: &tauri::AppHandle,
    generation: u64,
) -> Option<String> {
    let is_current = || app.state::<SyncSession>().is_current(generation);
    let candidates = collect_webview_cached_usage_tokens_while(scan, is_current);
    verify_candidates(scan, candidates, is_current).await
}

/// 缓存预扫描（点击同步时先跑一次）：收集候选并逐个验证，命中即返回。
/// 收集在 spawn_blocking（同步 IO），验证是异步请求，不占 runtime 工作线程。
pub(crate) async fn prescan_cached_token(
    app: &tauri::AppHandle,
    generation: u64,
) -> Option<String> {
    let scan_app = app.clone();
    let (candidates, mut scan) = tauri::async_runtime::spawn_blocking(move || {
        let mut scan = CacheScanState::default();
        let candidates = collect_webview_cached_usage_tokens_while(&mut scan, || {
            scan_app.state::<SyncSession>().is_current(generation)
        });
        (candidates, scan)
    })
    .await
    .ok()?;
    verify_candidates(&mut scan, candidates, || {
        app.state::<SyncSession>().is_current(generation)
    })
    .await
}

/// IPC 捕获路径的统一校验：与预扫描/后台 watcher 一样走东八区探针月，
/// 不依赖登录窗口本地时区给出的月份（海外时区在月初边界会错拿月份，
/// 可能把有效 Token 误判失效）。
pub(crate) async fn verify_token_with_probes(token: &str) -> Result<(), String> {
    let probes = verify_probe_months(SystemTime::now());
    for (month, year) in probes {
        match verify_usage_token(token, month, year).await {
            Ok(()) => return Ok(()),
            Err(VerifyFailure::Definitive) => return Err(VerifyFailure::Definitive.message()),
            Err(VerifyFailure::Transient) => {}
        }
    }
    Err(VerifyFailure::Transient.message())
}

/// 三条捕获路径共用的落库动作：写配置、置成功标志、关登录窗、广播事件。
pub(crate) fn capture_usage_token(
    app: &tauri::AppHandle,
    token: String,
    generation: u64,
) -> Result<AppConfig, String> {
    let value = token.trim().to_string();
    if value.is_empty() {
        return Err("用量 Token 为空".to_string());
    }
    app.state::<SyncSession>().commit(generation, || {
        let app_config = to_app_config(crate::config::edit_validated_credential(
            crate::config::ValidatedCredential::UsageToken,
            value,
        )?)?;

        if let Some(window) = app.get_webview_window("login-sync") {
            // 防御：确保标题不含历史 title 通道残留后再关窗
            let _ = window.eval("try { document.title = 'DeepSeek 账号登录'; } catch (e) {}");
            let _ = window.close();
        }

        let _ = app.emit("usage-token-captured", &app_config);
        Ok(app_config)
    })
}

/// 打开登录窗口（只允许 DeepSeek 站内导航，降低钓鱼/任意站点套壳风险）。
pub(crate) fn open_login_window(app: &tauri::AppHandle, generation: u64) -> Result<(), String> {
    let url = WebviewUrl::External("https://platform.deepseek.com".parse().unwrap());
    WebviewWindowBuilder::new(app, "login-sync", url)
        .title("DeepSeek 账号登录")
        .inner_size(480.0, 720.0)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .center()
        .visible(true)
        .initialization_script(USAGE_SYNC_POLL_JS.replace(
            "token: token",
            &format!("token: token, generation: {generation}"),
        ))
        .on_navigation(|nav_url| {
            nav_url.scheme() == "https"
                && nav_url.port_or_known_default() == Some(443)
                && nav_url
                    .host_str()
                    .is_some_and(|host| host == "deepseek.com" || host.ends_with(".deepseek.com"))
        })
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && payload
                    .url()
                    .host_str()
                    .is_some_and(|host| host == "platform.deepseek.com")
            {
                // 双保险：万一 initialization_script 未注入，页面加载完再装一次 hook
                let _ = window.eval(USAGE_SYNC_POLL_JS.replace(
                    "token: token",
                    &format!("token: token, generation: {generation}"),
                ));
            }
        })
        .build()
        .map(|_| ())
        .map_err(|error| format!("打开登录窗口失败：{error}"))
}

/// 启动后台 watcher：周期扫缓存 + 目录事件即时唤醒，直到捕获成功、窗口关闭、
/// 代际更替或轮次上限。每条退出路径都落日志（评审 F-23），内容不含任何凭据。
pub(crate) fn spawn_title_watcher(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        // 登录页加载并触发平台 API 请求需要时间，等待后再开始扫缓存
        std::thread::sleep(Duration::from_secs(3));
        let mut scan = CacheScanState::default();
        // 缓存目录可能尚未创建（首次登录时 WebView2 还没落盘），每轮空闲时
        // 检查监听存活、失效就重新拉起；拉起失败自然退回定时轮询
        let cache_dir = webview_cache_dir();
        let mut change_signal = cache_dir.as_deref().and_then(cache_watch::spawn);
        let mut watch_unavailable_logged = false;
        let mut idle_rounds = 0u32;
        let deadline = Instant::now() + Duration::from_secs(300);
        for _ in 0..MAX_WATCH_ROUNDS {
            // 新一轮同步已开始：本 watcher 作废
            if !app.state::<SyncSession>().is_current(generation) {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            if app.get_webview_window("login-sync").is_none() {
                let _ = app.state::<SyncSession>().commit(generation, || {
                    let _ = app.emit("usage-sync-ended", ());
                    Ok(())
                });
                return;
            }
            if let Some(token) =
                tauri::async_runtime::block_on(collect_and_verify(&mut scan, &app, generation))
            {
                if !app.state::<SyncSession>().is_current(generation) {
                    return;
                }
                if let Err(error) = capture_usage_token(&app, token, generation) {
                    log::warn!("用量 Token 捕获后保存失败：{error}");
                    let _ = app.state::<SyncSession>().commit(generation, || {
                        let _ = app.emit("usage-sync-ended", ());
                        Ok(())
                    });
                }
                return;
            }
            idle_rounds = idle_rounds.saturating_add(1);

            let Some(window) = app.get_webview_window("login-sync") else {
                // 窗口已关闭：若不是因成功捕获而关闭，才通知前端结束等待
                let _ = app.state::<SyncSession>().commit(generation, || {
                    let _ = app.emit("usage-sync-ended", ());
                    Ok(())
                });
                return;
            };

            // 旧版 title 通道已移除：完整 Bearer 不再写入窗口标题。
            // 兼容：若外部工具仍写过 title，读到后立刻抹掉，避免凭据留在标题栏。
            if let Ok(title) = window.title() {
                if title.starts_with(USAGE_TOKEN_TITLE_PREFIX) {
                    let _ =
                        window.eval("try { document.title = 'DeepSeek 账号登录'; } catch (e) {}");
                }
            }

            // 有目录变更 → 去抖后立刻扫（WebView2 落盘后数百毫秒内即可命中）；
            // 无变更 → 维持 1.5s→4s 的退避节奏兜底轮询，防通知丢失或目录重建
            let wait_ms = if idle_rounds < FAST_POLL_ROUNDS {
                FAST_POLL_MS
            } else {
                SLOW_POLL_MS
            };
            let changed = match change_signal.as_mut() {
                Some(signal) if signal.is_alive() => signal.wait(Duration::from_millis(wait_ms)),
                _ => {
                    if !watch_unavailable_logged {
                        watch_unavailable_logged = true;
                        log::debug!("缓存目录监听不可用，退回 {wait_ms}ms 定时轮询");
                    }
                    std::thread::sleep(Duration::from_millis(wait_ms));
                    false
                }
            };
            if !change_signal
                .as_ref()
                .is_some_and(|signal| signal.is_alive())
            {
                change_signal = cache_dir.as_deref().and_then(cache_watch::spawn);
            }
            if changed {
                // WebView2 一次页面加载会写一批缓存文件，稍等写入平息再扫
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        log::warn!("登录同步等待超时（{MAX_WATCH_ROUNDS} 轮），未捕获到用量 Token；可重试同步或改用手动粘贴");
        let _ = app.state::<SyncSession>().commit(generation, || {
            let _ = app.emit("usage-sync-ended", ());
            Ok(())
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn 取消同步中止挂起校验_无需等网络超时() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let active = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&active);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            flag.store(false, Ordering::Release);
        });
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            while_current(std::future::pending::<()>(), || {
                active.load(Ordering::Acquire)
            }),
        )
        .await
        .expect("取消后不能继续等30秒候选预算");
        assert!(result.is_none());
    }

    fn at(epoch_secs: i64) -> SystemTime {
        if epoch_secs >= 0 {
            UNIX_EPOCH + Duration::from_secs(epoch_secs as u64)
        } else {
            UNIX_EPOCH - Duration::from_secs((-epoch_secs) as u64)
        }
    }

    #[test]
    fn 东八区月份_纪元边界() {
        // 1970-01-01 00:00 UTC → 北京时间 08:00，同日
        assert_eq!(cst_month(at(0)), (1, 1970));
        // 1969-12-31 23:59:59 UTC → 北京时间 1970-01-01 07:59:59，已跨日
        assert_eq!(cst_month(at(-1)), (1, 1970));
    }

    #[test]
    fn 东八区月份_跨年边界() {
        // 2025-12-31 15:59:59 UTC → 北京时间 23:59:59，仍是 2025-12
        assert_eq!(cst_month(at(1_767_225_600 - 8 * 3600 - 1)), (12, 2025));
        // 2026-01-01 00:00 UTC → 北京时间 08:00，进入 2026-01
        assert_eq!(cst_month(at(1_767_225_600)), (1, 2026));
    }

    #[test]
    fn 东八区月份_年内日期() {
        // 2027-01-15 08:00 UTC → 北京时间 16:00
        assert_eq!(cst_month(at(1_800_000_000)), (1, 2027));
        // 2026-03-01 00:00 UTC → 北京时间 08:00
        assert_eq!(cst_month(at(1_772_323_200)), (3, 2026));
    }

    #[test]
    fn 试调月_当前月在前往上个月兜底() {
        // 2026-01-01 08:00 北京时间：当月 2026-01，兜底 2025-12
        assert_eq!(
            verify_probe_months(at(1_767_225_600)),
            vec![(1, 2026), (12, 2025)]
        );
        // 2026-03-01：当月 2026-03，兜底 2026-02
        assert_eq!(
            verify_probe_months(at(1_772_323_200)),
            vec![(3, 2026), (2, 2026)]
        );
    }
}
