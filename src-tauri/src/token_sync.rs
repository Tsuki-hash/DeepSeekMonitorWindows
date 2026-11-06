//! 用量 Token 的抓取与解析。
//!
//! 从 WebView2 磁盘缓存里把网页登录态解析出来，是整条同步链路里最容易悄悄坏掉的一环：
//! 缓存文件是二进制混杂文本，标记串一旦变化（平台前端改动）就会静默抓不到 token，
//! 表现为「点了同步但一直没反应」。这类解析逻辑必须能被测试直接喂样本。

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// 单文件读取上限。WebView2 的缓存文件绝大多数远小于此，设上限是为了避免
/// 偶发的巨型文件把整个 watcher 循环卡住。
const MAX_CACHE_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_SCAN_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_SCAN_FILES: usize = 250;
const MAX_SCAN_ENTRIES: usize = 5000;
const MAX_SCAN_DURATION: Duration = Duration::from_millis(250);

/// 以共享方式读取一个可能正被 WebView2 占用的文件。
///
/// Windows 上 WebView2 以独占写句柄持有缓存文件，普通 `fs::read` 会拿到
/// 「另一个程序正在使用此文件」。这里用 `share_mode` 显式允许读写删除共享，
/// 拿到快照即可；读到的内容不完整也无妨，解析函数会自行判断。
pub fn read_shared_text(path: &Path) -> Option<String> {
    read_shared_text_while(path, MAX_CACHE_FILE_BYTES, &mut || true)
}

fn read_shared_text_while(
    path: &Path,
    reserved_bytes: u64,
    keep_scanning: &mut impl FnMut() -> bool,
) -> Option<String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.share_mode(0x1 | 0x2 | 0x4);
    let mut file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if metadata.len() == 0
        || metadata.len() > MAX_CACHE_FILE_BYTES
        || metadata.len() > reserved_bytes
    {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if !keep_scanning() {
            return None;
        }
        let remaining = metadata.len().saturating_sub(bytes.len() as u64);
        if remaining == 0 {
            break;
        }
        let count = file
            .read(&mut chunk[..remaining.min(64 * 1024) as usize])
            .ok()?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    // 不追读增长中的尾部，实际读取量始终不超过已预留的预算；后续遍历再试。
    if file.metadata().ok()?.len() > metadata.len() {
        return None;
    }
    // 缓存文件里夹着 NUL 填充，先剔掉再交给字符串匹配
    Some(String::from_utf8_lossy(&bytes).replace('\0', ""))
}

/// 从缓存文本里提取全部满足登录态上下文特征的 token（按出现顺序）。
///
/// 匹配策略：找 `"token":"..."`，并检查其后 1800 字符内同时出现 `id_profile` 与
/// `feature_gates` 两个上下文特征。这两个字段是登录态用户对象的组成部分，
/// 用来把真正的用户 token 和平台前端里其它同名短字符串区分开。
pub fn extract_user_api_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut search_from = 0;
    let marker = "\"token\":\"";
    while let Some(relative_index) = text[search_from..].find(marker) {
        let token_start = search_from + relative_index + marker.len();
        // 未闭合的候选（缓存截断）要跳过继续找，不能整函数放弃——后面可能还有完整 token
        let Some(close_quote) = text[token_start..].find('"') else {
            break;
        };
        let token_end = token_start + close_quote;
        let token = &text[token_start..token_end];
        let mut context_end = (token_end + 1800).min(text.len());
        while !text.is_char_boundary(context_end) {
            context_end -= 1;
        }
        let context = &text[token_end..context_end];
        if token.len() > 20
            && context.contains("\"id_profile\"")
            && context.contains("\"feature_gates\"")
        {
            tokens.push(token.to_string());
        }
        search_from = token_end + 1;
    }
    tokens
}

/// 提取第一个满足上下文特征的 token。
pub fn extract_user_api_token(text: &str) -> Option<String> {
    extract_user_api_tokens(text).into_iter().next()
}

/// 轮询缓存目录的去重状态：path -> (文件大小, 修改时间)。
/// watcher 周期扫一次，而缓存目录里绝大多数文件在两次轮询之间并没有变化。
/// 只比对元数据即可判断「读过且没变」，避免反复整读。
///
/// 淘汰采用惰性 LRU：`seen` 每个表项带一个递增的代际号，`order` 只是触碰历史
/// 的排队记录，出队时代际对不上说明同一路径后来又被触碰过，这条记录已过期、
/// 直接跳过。好处有二：出队均摊 O(1)（没有 `Vec::remove(0)` 的整段搬移）；
/// 内容频繁变动的热文件每次重读都会挪到队尾——FIFO 恰好相反，最先入表的
/// 热文件会最先被淘汰，逼着 watcher 反复重读最活跃的那批文件。
#[derive(Default)]
pub struct CacheScanState {
    seen: HashMap<PathBuf, (Stamp, u64)>,
    order: VecDeque<(PathBuf, u64)>,
    next_generation: u64,
    // 保存枚举位置，预算耗尽后下一轮继续，避免总从目录开头扫而饿死后部文件。
    entries: Option<fs::ReadDir>,
    pending_entry: Option<fs::DirEntry>,
}

/// 表项内容指纹：文件大小 + 修改时间。
pub(crate) type Stamp = (u64, Option<std::time::SystemTime>);

/// `seen` 表项上限。超过后按 LRU 淘汰到 3/4，保留近期文件的去重信息。
const MAX_SEEN_ENTRIES: usize = 50_000;

/// `order` 相对 `seen` 的膨胀上限。超出说明积累了大量过期排队记录（同一路径
/// 被反复触碰），重建一次队列清掉，防止极端热点文件把队列撑得比表还大。
const ORDER_BLOAT_FACTOR: usize = 2;
const ORDER_BLOAT_SLACK: usize = 64;

/// 记录「该路径本轮已处理过」。已有表项且内容指纹变化（刚被重读）视为一次
/// LRU 触碰，换新代际号挪到队尾。
pub(crate) fn mark_seen(scan: &mut CacheScanState, path: PathBuf, stamp: Stamp) {
    match scan.seen.get_mut(&path) {
        Some(entry) => {
            if entry.0 != stamp {
                scan.next_generation += 1;
                let generation = scan.next_generation;
                entry.1 = generation;
                entry.0 = stamp;
                scan.order.push_back((path, generation));
            }
        }
        None => {
            scan.next_generation += 1;
            let generation = scan.next_generation;
            scan.seen.insert(path.clone(), (stamp, generation));
            scan.order.push_back((path, generation));
        }
    }
    let order_cap = scan.seen.len() * ORDER_BLOAT_FACTOR + ORDER_BLOAT_SLACK;
    if scan.order.len() > order_cap {
        compact_order(scan);
    }
}

/// 重建触碰队列：只保留每个路径当前代际的记录，过期排队记录全部丢弃。
fn compact_order(scan: &mut CacheScanState) {
    scan.order = scan
        .seen
        .iter()
        .map(|(path, (_, generation))| (path.clone(), *generation))
        .collect();
}

/// 把 `seen` 淘汰到 `keep` 项以内：从触碰历史最旧的一端出队，代际对不上的
/// 过期记录直接跳过，对得上的才真正移除。
fn evict_lru(scan: &mut CacheScanState, keep: usize) {
    while scan.seen.len() > keep {
        let Some((path, generation)) = scan.order.pop_front() else {
            // 触碰历史意外耗尽（不应发生）：宁可整体放弃去重重读一轮，
            // 也不能让 watcher 卡死在这里
            scan.seen.clear();
            return;
        };
        if scan
            .seen
            .get(&path)
            .is_some_and(|(_, generation_now)| *generation_now == generation)
        {
            scan.seen.remove(&path);
        }
    }
}

/// WebView2 缓存目录（登录同步窗口使用本应用标识符下的 WebView 数据目录）。
/// 缓存目录变更监听（见 `cache_watch`）与扫描共用这一个定位，避免两处路径
/// 漂移后出现「监听了 A 目录、扫描 B 目录」的静默失配。
pub fn webview_cache_dir() -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local_app_data)
            .join("com.deepseek.monitor.windows")
            .join("EBWebView")
            .join("Default")
            .join("Cache")
            .join("Cache_Data"),
    )
}

/// 收集到的候选 token 及其来源文件。验证方在「明确拒绝」时用它回写已读标记，
/// 在「瞬时失败」时保持不标记，让下一轮扫描自动重试。
#[derive(Debug, Clone)]
pub struct CachedCandidate {
    pub token: String,
    pub path: PathBuf,
    pub stamp: Stamp,
}

/// 分轮收集缓存目录里通过上下文校验的候选 token（按文件遍历顺序，文件内按值去重）。
///
/// 「收集」与「验证」分离（评审 F-25）：本函数只负责收集，token 的网络验证由
/// 调用方在扫描完成后统一进行——单个候选的验证（HTTP 超时上限 15s）不再卡住
/// 其余文件的扫描。
///
/// 已读标记的语义（评审 F-07 实测加固）：
/// - 无候选或超出单文件上限的文件 → 立即记入 `seen`；
/// - 不可读、增长中或因取消中止的文件 → 不标记，后续遍历重新尝试；
/// - 含候选的每个来源文件**暂不标记**，由验证方决定：全部明确拒绝（401/403）才
///   回写标记；跨文件重复候选也不能未经验证提前标记。瞬时失败保持未标记——否则一次
///   网络抖动就会把有效 Token 静默压制到文件内容变化为止。
pub fn collect_webview_cached_usage_tokens(scan: &mut CacheScanState) -> Vec<CachedCandidate> {
    collect_webview_cached_usage_tokens_while(scan, || true)
}

pub fn collect_webview_cached_usage_tokens_while(
    scan: &mut CacheScanState,
    keep_scanning: impl FnMut() -> bool,
) -> Vec<CachedCandidate> {
    let Some(cache_dir) = webview_cache_dir() else {
        return Vec::new();
    };
    collect_cached_usage_tokens_in(scan, &cache_dir, keep_scanning)
}

pub(crate) fn collect_cached_usage_tokens_in(
    scan: &mut CacheScanState,
    cache_dir: &Path,
    keep_scanning: impl FnMut() -> bool,
) -> Vec<CachedCandidate> {
    collect_cached_usage_tokens_in_with_clock(scan, cache_dir, keep_scanning, Instant::now)
}

/// 与生产完全共用的读取/解析/分页路径；回归只固定扫描时钟，避免慢磁盘随机把
/// 250 文件边界提前切成另一批。生产仍执行原来的 250ms 扫描预算。
pub(crate) fn collect_cached_usage_tokens_in_with_clock(
    scan: &mut CacheScanState,
    cache_dir: &Path,
    mut keep_scanning: impl FnMut() -> bool,
    now: impl Fn() -> Instant,
) -> Vec<CachedCandidate> {
    let mut candidates: Vec<CachedCandidate> = Vec::new();
    let mut entries = match scan.entries.take().or_else(|| fs::read_dir(cache_dir).ok()) {
        Some(entries) => entries,
        None => return candidates,
    };
    let mut read_files = 0usize;
    let mut read_bytes = 0u64;
    let mut visited_entries = 0usize;
    let start = now();
    loop {
        if !keep_scanning()
            || read_files >= MAX_SCAN_FILES
            || visited_entries >= MAX_SCAN_ENTRIES
            || now().saturating_duration_since(start) >= MAX_SCAN_DURATION
        {
            scan.entries = Some(entries);
            break;
        }
        let Some(entry) = scan
            .pending_entry
            .take()
            .or_else(|| entries.find_map(Result::ok))
        else {
            break;
        };
        visited_entries += 1;
        let path = entry.path();
        // 取一次元数据同时完成「是否普通文件」与「是否变动」两项判断，比 is_file()
        // 后再取一次少一次系统调用。
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let stamp = (metadata.len(), metadata.modified().ok());
        if scan.seen.len() >= MAX_SEEN_ENTRIES {
            evict_lru(scan, MAX_SEEN_ENTRIES * 3 / 4);
        }
        if scan
            .seen
            .get(&path)
            .is_some_and(|(seen_stamp, _)| *seen_stamp == stamp)
        {
            // 上次已经读过且文件未变动，跳过整读
            continue;
        }
        if metadata.len() == 0 || metadata.len() > MAX_CACHE_FILE_BYTES {
            mark_seen(scan, path, stamp);
            continue;
        }
        if read_bytes + metadata.len() > MAX_SCAN_BYTES {
            scan.pending_entry = Some(entry);
            scan.entries = Some(entries);
            break;
        }
        read_bytes += metadata.len();
        read_files += 1;
        let Some(text) = read_shared_text_while(&path, metadata.len(), &mut keep_scanning) else {
            if !keep_scanning() {
                scan.pending_entry = Some(entry);
                scan.entries = Some(entries);
                break;
            }
            // 不标记读取失败或增长中的文件，下一次完整遍历时重新尝试。
            continue;
        };
        // 同一个缓存文件可能同时保留旧会话与新会话，不能只试第一个。
        // 只在本文件内去重：另一来源的同值候选尚未通过/明确拒绝时，不应让
        // 当前文件进入 seen；也不让前一文件的重复值改变本文件跨轮候选游标。
        let mut known_tokens = std::collections::HashSet::new();
        let new_tokens: Vec<_> = extract_user_api_tokens(&text)
            .into_iter()
            .filter(|token| known_tokens.insert(token.clone()))
            .collect();
        if new_tokens.is_empty() {
            mark_seen(scan, path, stamp);
        } else {
            for token in new_tokens {
                candidates.push(CachedCandidate {
                    token,
                    path: path.clone(),
                    stamp,
                });
            }
        }
    }
    log::debug!(
        "缓存扫描：读取 {read_files} 个新/变更文件、{read_bytes} 字节，候选 token {} 个",
        candidates.len()
    );
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempConfigDir;

    #[test]
    fn 分轮文件预算保留游标_后部候选不会饿死() {
        let dir = TempConfigDir::new("scan-file-budget");
        for i in 0..520 {
            fs::write(
                dir.path().join(format!("f_{i:04}")),
                cache_text_with(&format!("synthetic-session-token-{i:04}")),
            )
            .unwrap();
        }
        let mut scan = CacheScanState::default();
        let mut found = std::collections::HashSet::new();
        for _ in 0..20 {
            let batch = collect_cached_usage_tokens_in(&mut scan, dir.path(), || true);
            assert!(batch.len() <= MAX_SCAN_FILES);
            found.extend(batch.into_iter().map(|candidate| candidate.token));
            if found.len() == 520 {
                break;
            }
        }
        assert_eq!(found.len(), 520);
    }

    #[test]
    fn 总读取预算耗尽后继续_不丢待处理文件() {
        let dir = TempConfigDir::new("scan-byte-budget");
        for i in 0..5 {
            let mut bytes =
                cache_text_with(&format!("synthetic-large-session-token-{i}")).into_bytes();
            bytes.resize(8 * 1024 * 1024, b'x');
            fs::write(dir.path().join(format!("f_{i}")), bytes).unwrap();
        }
        let mut scan = CacheScanState::default();
        let mut found = std::collections::HashSet::new();
        for _ in 0..10 {
            let batch = collect_cached_usage_tokens_in(&mut scan, dir.path(), || true);
            assert!(batch.len() <= 4, "每轮最多读取32 MiB");
            found.extend(batch.into_iter().map(|candidate| candidate.token));
            if found.len() == 5 {
                break;
            }
        }
        assert_eq!(found.len(), 5);
    }

    #[test]
    fn 读取中取消不标记已读_下次可重新取得候选() {
        let dir = TempConfigDir::new("scan-cancel");
        fs::write(
            dir.path().join("f_1"),
            cache_text_with("synthetic-cancel-session-token-12345"),
        )
        .unwrap();
        let mut scan = CacheScanState::default();
        let mut checks = 0;
        let found = collect_cached_usage_tokens_in(&mut scan, dir.path(), || {
            checks += 1;
            checks < 3
        });
        assert!(found.is_empty());
        assert!(scan.seen.is_empty());
        let resumed = collect_cached_usage_tokens_in(&mut scan, dir.path(), || true);
        assert_eq!(resumed.len(), 1);
    }

    #[test]
    fn 超大文件拒绝读取() {
        let dir = TempConfigDir::new("scan-oversize");
        let path = dir.path().join("oversize");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_CACHE_FILE_BYTES + 1)
            .unwrap();
        assert!(read_shared_text(&path).is_none());
    }

    #[test]
    fn collect_同一文件多个会话均为候选() {
        let dir = TempConfigDir::new("collect-multiple-sessions");
        let cache = dir
            .path()
            .join("com.deepseek.monitor.windows/EBWebView/Default/Cache/Cache_Data");
        fs::create_dir_all(&cache).unwrap();
        fs::write(
            cache.join("f_1"),
            format!(
                "{}{}",
                cache_text_with("old-synthetic-session-token-12345"),
                cache_text_with("new-synthetic-session-token-12345")
            ),
        )
        .unwrap();
        let previous = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", dir.path());
        let found = collect_webview_cached_usage_tokens(&mut CacheScanState::default());
        match previous {
            Some(value) => std::env::set_var("LOCALAPPDATA", value),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].path, found[1].path);
    }

    #[test]
    fn 上下文截取_中文与emoji边界不恐慌() {
        for character in ["界", "😀"] {
            for padding in 0..4 {
                let text = format!(
                    "\"token\":\"{}\"{}{}",
                    "a".repeat(21),
                    "x".repeat(padding),
                    character.repeat(700)
                );
                assert!(extract_user_api_tokens(&text).is_empty());
            }
        }
    }

    /// 构造一段带完整登录态上下文的缓存文本
    fn cache_text_with(token: &str) -> String {
        format!(
            "{{\"id\":123,\"token\":\"{token}\",\"user\":{{\"id_profile\":{{\"name\":\"x\"}},\
             \"feature_gates\":[\"a\",\"b\"]}}}}"
        )
    }

    #[test]
    fn 提取_标准登录态() {
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        let text = cache_text_with(token);
        assert_eq!(extract_user_api_token(&text).as_deref(), Some(token));
    }

    #[test]
    fn 提取_前面有其它同名短字符串时会跳过它() {
        // 平台前端可能先出现一个短的 "token"（如 CSRF 片段），必须跳过继续找
        let real = "real-token-value-that-is-long-enough-123456";
        let text = format!("{{\"token\":\"short\",\"x\":1}}{}", cache_text_with(real));
        assert_eq!(extract_user_api_token(&text).as_deref(), Some(real));
    }

    #[test]
    fn 缺少_id_profile_则不识别() {
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        let text = format!("{{\"token\":\"{token}\",\"feature_gates\":[]}}");
        assert_eq!(extract_user_api_token(&text), None);
    }

    #[test]
    fn 缺少_feature_gates_则不识别() {
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        let text = format!("{{\"token\":\"{token}\",\"id_profile\":{{}}}}");
        assert_eq!(extract_user_api_token(&text), None);
    }

    #[test]
    fn 过短的_token_不识别() {
        // 打断在 20 字符边界内的短串不可能是真 token
        let text = "{\"token\":\"12345678901234567890\",\"id_profile\":{},\"feature_gates\":[]}";
        assert_eq!(extract_user_api_token(text), None, "恰好 20 字符应被拒绝");
        let text21 = "{\"token\":\"123456789012345678901\",\"id_profile\":{},\"feature_gates\":[]}";
        assert_eq!(
            extract_user_api_token(text21).as_deref(),
            Some("123456789012345678901"),
            "21 字符应被接受"
        );
    }

    #[test]
    fn 上下文超出_1800_字符窗口_则不识别() {
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        // 把 id_profile / feature_gates 推到 1800 字符之外
        let filler = "x".repeat(1900);
        let text = format!("{{\"token\":\"{token}\"}}{filler}\"id_profile\"\"feature_gates\"");
        assert_eq!(extract_user_api_token(&text), None);
    }

    #[test]
    fn 无标记_返回_none() {
        assert_eq!(extract_user_api_token(""), None);
        assert_eq!(extract_user_api_token("{\"foo\":\"bar\"}"), None);
    }

    #[test]
    fn 未闭合的_token_不_panic() {
        // 缓存被截断时可能只剩半个标记，不能因此崩溃 watcher 线程
        assert_eq!(extract_user_api_token("{\"token\":\""), None);
        assert_eq!(extract_user_api_token("{\"token\":"), None);
        assert_eq!(extract_user_api_token("\"token\":\"abc"), None);
    }

    #[test]
    fn 前面有未闭合候选_仍能提取后面完整_token() {
        // 回归：find('\"') 失败曾用 ? 直接返回，导致后面合法 token 扫不到
        let real = "real-token-value-that-is-long-enough-123456";
        let text = format!("{{\"token\":\"unclosed-no-end{}", cache_text_with(real));
        assert_eq!(extract_user_api_token(&text).as_deref(), Some(real));
    }

    #[test]
    fn 多字节内容_不_panic() {
        // 缓存里混有中文时按字节查找仍须落在字符边界上
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        let text = format!("中文前缀✅{}中文后缀✅", cache_text_with(token));
        assert_eq!(extract_user_api_token(&text).as_deref(), Some(token));
    }

    #[test]
    fn extract_全部_按顺序取出多个候选() {
        let a = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        let b = "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
        let text = format!("{}{}", cache_text_with(a), cache_text_with(b));
        assert_eq!(
            extract_user_api_tokens(&text),
            vec![a.to_string(), b.to_string()]
        );
        assert_eq!(extract_user_api_token(&text).as_deref(), Some(a));
    }

    #[test]
    fn collect_在缓存目录缺失时_返回空表() {
        // 未登录过（缓存目录不存在）不应 panic，只返回空候选。
        // TempConfigDir 持有全局锁：与下面的写入用例串行，避免 LOCALAPPDATA 互踩
        let _dir = TempConfigDir::new("collect-missing-localappdata");
        let mut scan = CacheScanState::default();
        let previous = std::env::var_os("LOCALAPPDATA");
        std::env::set_var(
            "LOCALAPPDATA",
            std::env::temp_dir().join("dsm-test-no-such-localappdata"),
        );
        let found = collect_webview_cached_usage_tokens(&mut scan);
        match previous {
            Some(value) => std::env::set_var("LOCALAPPDATA", value),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        assert!(found.is_empty());
    }

    #[test]
    fn collect_命中候选_重复来源保持未读且只有无候选文件记入已读() {
        // 借 TempConfigDir 的全局锁串行化 LOCALAPPDATA 操作，并借它的路径当根目录
        let dir = TempConfigDir::new("collect-candidates");
        let cache = dir
            .path()
            .join("com.deepseek.monitor.windows/EBWebView/Default/Cache/Cache_Data");
        std::fs::create_dir_all(&cache).unwrap();
        let token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
        std::fs::write(cache.join("f_000001"), cache_text_with(token)).unwrap();
        std::fs::write(cache.join("f_000002"), cache_text_with(token)).unwrap();
        std::fs::write(cache.join("f_000003"), b"no token here").unwrap();

        let previous = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", dir.path());
        let mut scan = CacheScanState::default();
        let found = collect_webview_cached_usage_tokens(&mut scan);
        match previous {
            Some(value) => std::env::set_var("LOCALAPPDATA", value),
            None => std::env::remove_var("LOCALAPPDATA"),
        }

        // 同 Token 的两个来源均等待自己的验证结果，不依赖 read_dir 的枚举顺序。
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|candidate| candidate.token == token));
        assert!(found
            .iter()
            .any(|candidate| candidate.path == cache.join("f_000001")));
        assert!(found
            .iter()
            .any(|candidate| candidate.path == cache.join("f_000002")));
        assert_eq!(scan.seen.len(), 1, "所有候选来源都应保持未标记");
    }

    // —— CacheScanState 惰性 LRU（白盒：直接操作内部状态） ——

    /// 用编号路径构造已填充的扫描状态，插入顺序即编号顺序
    fn filled_state(count: u64) -> CacheScanState {
        let mut scan = CacheScanState::default();
        for i in 0..count {
            mark_seen(&mut scan, PathBuf::from(format!("f_{i:05}")), (i, None));
        }
        scan
    }

    #[test]
    fn 淘汰_最旧先出() {
        let mut scan = filled_state(10);
        evict_lru(&mut scan, 5);
        assert_eq!(scan.seen.len(), 5);
        for i in 0..5u64 {
            assert!(
                !scan.seen.contains_key(&PathBuf::from(format!("f_{i:05}"))),
                "f_{i:05} 是最旧的一批，应被淘汰"
            );
        }
        for i in 5..10u64 {
            assert!(scan.seen.contains_key(&PathBuf::from(format!("f_{i:05}"))));
        }
    }

    #[test]
    fn 淘汰_被触碰的热文件优先保留() {
        // 区分 LRU 与 FIFO 的关键用例：f_00000 最早插入，FIFO 会先淘汰它；
        // 但它刚被重读（内容变化）是热文件，LRU 应改为淘汰 f_00001
        let mut scan = filled_state(10);
        mark_seen(&mut scan, PathBuf::from("f_00000"), (100, None));
        evict_lru(&mut scan, 9);
        assert!(scan.seen.contains_key(&PathBuf::from("f_00000")));
        assert!(!scan.seen.contains_key(&PathBuf::from("f_00001")));
    }

    #[test]
    fn 淘汰_过期排队记录不会误删活表项() {
        let mut scan = filled_state(4);
        // 同一路径连续触碰多次，队列里留下大量过期代际记录
        for version in 10..30 {
            mark_seen(&mut scan, PathBuf::from("f_00000"), (version, None));
        }
        evict_lru(&mut scan, 0);
        assert!(scan.seen.is_empty());
        assert!(scan.order.is_empty());
        // 状态仍可复用：重新填充后淘汰照常工作
        let mut scan = filled_state(3);
        evict_lru(&mut scan, 1);
        assert_eq!(scan.seen.len(), 1);
    }

    #[test]
    fn 触碰_热点文件不会把触碰队列撑大() {
        let mut scan = CacheScanState::default();
        for version in 0..500u64 {
            mark_seen(&mut scan, PathBuf::from("hot"), (version, None));
        }
        assert_eq!(scan.seen.len(), 1);
        assert!(
            scan.order.len() <= ORDER_BLOAT_SLACK + ORDER_BLOAT_FACTOR,
            "反复触碰应触发队列压缩，长度 {} 超过上限",
            scan.order.len()
        );
    }

    #[test]
    fn 同一指纹重复记录_不会新增触碰() {
        // 内容未变化的重读（例如 accept 拒收后的重扫）不应挤占触碰历史
        let mut scan = CacheScanState::default();
        for _ in 0..100 {
            mark_seen(&mut scan, PathBuf::from("stable"), (7, None));
        }
        assert_eq!(scan.seen.len(), 1);
        assert_eq!(scan.order.len(), 1);
    }
}
