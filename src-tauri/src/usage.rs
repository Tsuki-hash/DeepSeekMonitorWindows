//! 用量口径。
//!
//! 这是全项目最该被测试保护的模块：README 明确写着「改模型或加模型从 `model_slot()` 入手」，
//! 而历史 bug（v1.2.1 修的归并漏统计）恰恰落在这里。这些函数原先嵌在 `lib.rs` 的 `run()`
//! 内部，测试无从下手，只能靠人工打开应用对数。
//!
//! 本模块只做纯计算，不碰网络与文件——拉到响应后的原始条目由调用方反序列化后传进来。

use serde::{Deserialize, Serialize};

pub const FLASH_SLOT: &str = "flash";
pub const PRO_SLOT: &str = "pro";
/// 前端 JS 安全整数上界；超过它的计数无法在界面里无损表示，按未知处理。
pub const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;

/// 平台响应里的单条用量记录：`{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"1234.0"}`
#[derive(Debug, Clone, Deserialize)]
pub struct Entry {
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: String,
}

/// 模型名映射。2026-09-10 DeepSeek 上线 V4.1 Flash，模型名改为 `deepseek-flash`。
/// 旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 对应的模型已下线，但出于
/// 兼容仍被路由到 V4.1 Flash，因此迁移期内平台可能同时返回新旧名字，必须归并到同一槽位。
/// `deepseek-v4-pro`（V4 Pro）继续作为独立模型提供，单独占 pro 槽位。
///
/// 返回 `(槽位 key, 界面显示名)`；未知模型返回 `None`（调用方打 warn 并跳过）。
pub fn model_slot(model: &str) -> Option<(&'static str, &'static str)> {
    match model {
        "deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp" => {
            Some((FLASH_SLOT, "V4.1 Flash"))
        }
        "deepseek-v4-pro" => Some((PRO_SLOT, "V4 Pro")),
        _ => None,
    }
}

/// 平台计数字段的唯一解析入口。Token/请求数只接受**合法非负整数**：
/// `"100.0"` 这类全零小数可接受，`"1.5"` 会被判为未知，而不是静默四舍五入成 2。
/// 与 `usage_history` 共用同一套规则，避免主面板与历史对同一响应得出不同结论。
pub fn count(value: &str) -> Option<u64> {
    let value = value.trim();
    let (integer, fractional) = value.split_once('.').unwrap_or((value, ""));
    if integer.is_empty()
        || !integer.bytes().all(|c| c.is_ascii_digit())
        || !fractional.bytes().all(|c| c == b'0')
    {
        return None;
    }
    integer
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_COUNT)
}

/// 金额字段解析：保持合法小数，拒绝 NaN/∞/负数/超范围。
pub fn amount(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0 && *value < u64::MAX as f64)
}

/// 可空计数相加：任一未知即未知，溢出即未知，不把缺失补成零。
fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a?.checked_add(b?).filter(|value| *value <= MAX_SAFE_COUNT)
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TokenBreakdown {
    /// 总 token = 缓存命中 + 缓存未命中 + 输出 + 未归类
    pub total: Option<u64>,
    /// 请求数是计次而非计 token，不参与 total 累加
    pub request: Option<u64>,
    pub cache_hit: Option<u64>,
    pub cache_miss: Option<u64>,
    pub response: Option<u64>,
    /// V4.1 Flash 原生多模态后，平台可能返回当前未归类的 token 类型（如图片输入）。
    /// 保守计入 total，宁可多算也不静默丢数据；单独记录便于前端提示。
    pub other: Option<u64>,
}

/// 把一组原始条目归并成结构化的 token 明细。
///
/// `PROMPT_TOKEN` 表示输入总量，缓存命中 + 未命中通常就是输入总量。若两者并存还累加
/// 会把输入量算两遍。**定稿口径（保守）**：有缓存明细时不用 `PROMPT_TOKEN` 兜底；
/// 只有平台只给了 `PROMPT_TOKEN` 时才计入 total。与明细数值不一致时打 warn 便于排障，
/// 不改变归并规则。该规则由单测锁定，改动前先改测试。
pub fn token_breakdown(usage: &[Entry]) -> TokenBreakdown {
    // 每个分段各自记录「是否出现过无法解析的数值」：一个字段坏掉只让该字段为未知，
    // 有效兄弟字段仍保留（与 usage_history 的逐字段规则一致）。
    let mut result = TokenBreakdown {
        total: Some(0),
        request: Some(0),
        cache_hit: Some(0),
        cache_miss: Some(0),
        response: Some(0),
        other: Some(0),
    };
    let mut prompt_total = Some(0u64);
    let mut prompt_seen = false;
    let mut prompt_valid = true;
    for entry in usage {
        let value = count(&entry.amount);
        match entry.kind.as_str() {
            "REQUEST" => result.request = add(result.request, value),
            "PROMPT_CACHE_HIT_TOKEN" => {
                result.cache_hit = add(result.cache_hit, value);
                result.total = add(result.total, value);
            }
            "PROMPT_CACHE_MISS_TOKEN" => {
                result.cache_miss = add(result.cache_miss, value);
                result.total = add(result.total, value);
            }
            "RESPONSE_TOKEN" => {
                result.response = add(result.response, value);
                result.total = add(result.total, value);
            }
            "PROMPT_TOKEN" => {
                prompt_seen = true;
                prompt_valid &= value.is_some();
                prompt_total = add(prompt_total, value);
            }
            kind => {
                result.other = add(result.other, value);
                result.total = add(result.total, value);
                log::warn!("未归类的用量类型 {kind}，已计入 other token：{value:?}");
            }
        }
    }
    // 「缓存明细缺失」与「缓存明细为零」是两回事：前者不能用 PROMPT_TOKEN 兜底，
    // 否则解析失败的明细会被伪装成一次正常归并。
    let detailed = result.cache_hit.is_some() && result.cache_miss.is_some();
    let known_hit = result.cache_hit.unwrap_or(0);
    let known_miss = result.cache_miss.unwrap_or(0);
    // 复评 F05：只有 REQUEST 没有任何 token 种类时，total 不是「0」而是**未知**
    //（有请求数据不等于 token 明确为零）。与 usage_history 的 has_tokens 规则一致。

    if !detailed {
        // 明细缺失：总量与「未归类」都无法完整重建，保留其余有效分段。
        result.total = None;
        result.other = None;
    } else if prompt_valid && known_hit == 0 && known_miss == 0 {
        // 平台只给了输入总量：兜底计入 total，与历史口径保持一致。
        // 复评 F05：`prompt_total` 为 None（累加溢出）时必须传播 None，
        // 不能 `unwrap_or(0)` 把溢出变成「零」。
        if prompt_seen && prompt_total.is_none() {
            result.total = None;
            result.other = None;
        } else {
            let prompt = prompt_total.unwrap_or(0);
            result.total = add(result.total, Some(prompt));
            result.other = add(result.other, Some(prompt));
        }
    } else if prompt_valid && prompt_total.unwrap_or(0) > 0 {
        let prompt = prompt_total.unwrap_or(0);
        let detail_sum = known_hit + known_miss;
        if detail_sum != prompt {
            log::warn!(
                "PROMPT_TOKEN({prompt}) 与缓存明细({detail_sum})不一致，已按明细口径计入 total"
            );
        }
    } else if prompt_seen && !prompt_valid && known_hit == 0 && known_miss == 0 {
        // 唯一的输入来源坏掉，且明细为零：总量不可信，不能显示成零。
        result.total = None;
        result.other = None;
    }
    // 复评 F05：有条目但**全是 REQUEST**（没有任何 token 种类）时，total 不是
    // 「0」而是**未知**（有请求数据不等于 token 明确为零）。
    // 空输入仍保持全零 —— 没有条目就是没有用量，这是既有语义。
    let request_only = !usage.is_empty() && !usage.iter().any(|entry| entry.kind != "REQUEST");
    if request_only {
        result.total = None;
        result.other = None;
    }
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelSummary {
    pub key: String,
    pub name: String,
    /// 以下计数为 `None` 表示「平台没有给」或「给了但无法解析」，**不等于零**。
    pub total_tokens: Option<u64>,
    pub request_count: Option<u64>,
    pub cache_hit_tokens: Option<u64>,
    pub cache_miss_tokens: Option<u64>,
    pub response_tokens: Option<u64>,
    /// 平台返回的、当前未归类的 token 类型（如多模态图片输入），已计入 total_tokens
    pub other_tokens: Option<u64>,
    /// `None` 表示费用接口没有返回该模型/日期，不能回退成零。
    pub cost: Option<f64>,
}

impl UsageModelSummary {
    pub fn new(key: &str, name: &str, breakdown: &TokenBreakdown, cost: Option<f64>) -> Self {
        Self {
            key: key.to_string(),
            name: name.to_string(),
            total_tokens: breakdown.total,
            request_count: breakdown.request,
            cache_hit_tokens: breakdown.cache_hit,
            cache_miss_tokens: breakdown.cache_miss,
            response_tokens: breakdown.response,
            other_tokens: breakdown.other,
            cost,
        }
    }
}

/// 迁移期内同一模型可能有多个名字（`deepseek-flash` 与旧名并存），
/// 必须**累加**而非覆盖：前端只按槽位取一个汇总行，覆盖会让另一部分用量凭空消失。
/// 这正是 v1.2.1 修的 bug，本函数是它的回归防线。
///
/// 任一来源的费用未知时汇总费用未知（不做「部分已知就求和」的静默降级）。
pub fn merge_model_slot(
    slot: Option<UsageModelSummary>,
    key: &str,
    name: &str,
    breakdown: &TokenBreakdown,
    cost: Option<f64>,
) -> UsageModelSummary {
    match slot {
        Some(mut existing) => {
            existing.total_tokens = add(existing.total_tokens, breakdown.total);
            existing.request_count = add(existing.request_count, breakdown.request);
            existing.cache_hit_tokens = add(existing.cache_hit_tokens, breakdown.cache_hit);
            existing.cache_miss_tokens = add(existing.cache_miss_tokens, breakdown.cache_miss);
            existing.response_tokens = add(existing.response_tokens, breakdown.response);
            existing.other_tokens = add(existing.other_tokens, breakdown.other);
            existing.cost = existing.cost.zip(cost).map(|(a, b)| a + b);
            existing
        }
        None => UsageModelSummary::new(key, name, breakdown, cost),
    }
}

/// 费用求和。`REQUEST` 条目的 amount 是**次数**而不是金额，必须排除，
/// 否则每月费用会被请求数污染成一个天文数字。
///
/// 任一金额无法解析时整体为 `None`：费用缺失不能折算成 0 元。
/// 金额用 `f64` 而非整数分：平台返回的就是小数字符串，本应用只做
/// 展示级汇总（元、两位小数），不做财务入账；改整数分需同步改接口反序列化与前端
/// 全部 `fmtMoney` 调用链，收益不抵成本。极端量级（>2^53 最小单位）的精度损失可接受。
pub fn cost_sum(usage: &[Entry]) -> Option<f64> {
    // 复评 N16：**每一步**都要检查累计值仍有限 —— 旧实现只校验各输入
    // 有限，1e308 + 1e308 会得到 Infinity 并被当成正常金额展示。
    usage
        .iter()
        .filter(|entry| entry.kind != "REQUEST")
        .try_fold(0.0, |total, entry| {
            let next = total + amount(&entry.amount)?;
            next.is_finite().then_some(next)
        })
}

/// 复评 R09：费用求和的**presence 证据**版本。
///
/// `cost_sum` 对「只有 REQUEST」或「空 usage」返回 `Some(0.0)` —— 那是从 0
/// 开始累加得到的零，不是平台声明的零。当数量侧明确返回了模型（有 token），
/// 而费用侧该模型的 usage 为空时，展示 0 元等于把一个未知值说成「没花钱」。
///
/// 返回 `None` 表示**没有任何可用的非 REQUEST 费用值**（未知）；返回
/// `Some(v)` 表示至少存在一个可解析的费用条目（v 可以是显式 0）。
pub fn cost_sum_present(usage: &[Entry]) -> Option<f64> {
    let mut seen = false;
    // 复评 N16：累计溢出（非有限）同样传播未知。
    let total = usage
        .iter()
        .filter(|entry| entry.kind != "REQUEST")
        .try_fold(0.0, |total, entry| {
            seen = true;
            let next = total + amount(&entry.amount)?;
            next.is_finite().then_some(next)
        })?;
    seen.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, amount: &str) -> Entry {
        Entry {
            kind: kind.to_string(),
            amount: amount.to_string(),
        }
    }

    // ---------- model_slot ----------

    #[test]
    fn 模型名映射表_与_readme_一致() {
        // README 的模型口径表格直接转成断言：改口径必须先动这里。
        assert_eq!(
            model_slot("deepseek-flash"),
            Some((FLASH_SLOT, "V4.1 Flash"))
        );
        assert_eq!(
            model_slot("deepseek-v4-flash"),
            Some((FLASH_SLOT, "V4.1 Flash"))
        );
        assert_eq!(
            model_slot("deepseek-v4-flash-vision-exp"),
            Some((FLASH_SLOT, "V4.1 Flash"))
        );
        assert_eq!(model_slot("deepseek-v4-pro"), Some((PRO_SLOT, "V4 Pro")));
    }

    #[test]
    fn 未知模型名_返回_none() {
        assert_eq!(model_slot(""), None);
        assert_eq!(model_slot("deepseek-chat"), None);
        assert_eq!(model_slot("deepseek-reasoner"), None);
        // 大小写敏感：平台返回的是小写规范名，拼错不该被静默归并
        assert_eq!(model_slot("DeepSeek-Flash"), None);
        // 前后空格不应被容错吞掉（原始值直接比对）
        assert_eq!(model_slot(" deepseek-flash"), None);
    }

    // ---------- token_breakdown ----------

    #[test]
    fn 六种_kind_的归并与累加() {
        let usage = vec![
            entry("PROMPT_CACHE_HIT_TOKEN", "100.0"),
            entry("PROMPT_CACHE_MISS_TOKEN", "200.0"),
            entry("RESPONSE_TOKEN", "50.0"),
            entry("REQUEST", "3.0"),
            entry("MULTIMODAL_IMAGE_TOKEN", "7.0"),
        ];
        let b = token_breakdown(&usage);
        assert_eq!(b.cache_hit, Some(100));
        assert_eq!(b.cache_miss, Some(200));
        assert_eq!(b.response, Some(50));
        assert_eq!(b.request, Some(3));
        assert_eq!(b.other, Some(7));
        // total 不含 request（计次而非计 token）
        assert_eq!(b.total, Some(100 + 200 + 50 + 7));
    }

    #[test]
    fn 同种_kind_多条_累加() {
        let usage = vec![
            entry("PROMPT_CACHE_HIT_TOKEN", "10.0"),
            entry("PROMPT_CACHE_HIT_TOKEN", "20.0"),
            entry("RESPONSE_TOKEN", "1.0"),
        ];
        let b = token_breakdown(&usage);
        assert_eq!(b.cache_hit, Some(30));
        assert_eq!(b.total, Some(31));
    }

    #[test]
    fn 小数计数为未知_不静默四舍五入() {
        // 与历史口径统一：Token 只接受合法整数，"20.5" 不能变成 21。
        let b = token_breakdown(&[entry("PROMPT_CACHE_HIT_TOKEN", "20.5")]);
        assert_eq!(b.cache_hit, None);
        assert_eq!(b.total, None);
    }

    #[test]
    fn 无法解析的_amount_为未知_有效兄弟字段保留() {
        let b = token_breakdown(&[
            entry("RESPONSE_TOKEN", "not-a-number"),
            entry("RESPONSE_TOKEN", ""),
            entry("PROMPT_CACHE_HIT_TOKEN", "5"),
        ]);
        assert_eq!(b.response, None, "坏字段不能补成零");
        assert_eq!(b.cache_hit, Some(5), "有效兄弟字段仍保留");
        assert_eq!(b.total, None, "总量无法完整重建时为未知");
    }

    #[test]
    fn 只有_prompt_token_时_兜底计入总量() {
        let b = token_breakdown(&[entry("PROMPT_TOKEN", "800.0")]);
        assert_eq!(b.total, Some(800));
        assert_eq!(b.other, Some(800));
        assert_eq!(b.cache_hit, Some(0));
        assert_eq!(b.cache_miss, Some(0));
    }

    #[test]
    fn prompt_token_与明细并存_不重复计入() {
        // 定稿口径：有 HIT/MISS 明细时 PROMPT_TOKEN 只作参考，不进 total。
        // 若平台出现「有明细且 PROMPT ≠ HIT+MISS」的样本，以本断言为准（保守不双计），
        // 同时看日志里的 warn 做人工核对。
        let b = token_breakdown(&[
            entry("PROMPT_TOKEN", "300.0"),
            entry("PROMPT_CACHE_HIT_TOKEN", "100.0"),
            entry("PROMPT_CACHE_MISS_TOKEN", "200.0"),
            entry("RESPONSE_TOKEN", "50.0"),
        ]);
        assert_eq!(
            b.total,
            Some(350),
            "有缓存明细时不得把 PROMPT_TOKEN 再算一遍"
        );
        assert_eq!(b.cache_hit.unwrap() + b.cache_miss.unwrap(), 300);
    }

    #[test]
    fn 只有命中明细_无未命中时_也算有明细() {
        // 边界：未出现 MISS 条目视为该分段为零（平台省略即零），
        // 因此仍按明细口径，不用 PROMPT_TOKEN 兜底。
        let b = token_breakdown(&[
            entry("PROMPT_TOKEN", "999.0"),
            entry("PROMPT_CACHE_HIT_TOKEN", "10.0"),
        ]);
        assert_eq!(b.total, Some(10));
        assert_eq!(b.cache_hit, Some(10));
        assert_eq!(b.cache_miss, Some(0));
    }

    #[test]
    fn 只有未命中明细_无命中时_也算有明细() {
        let b = token_breakdown(&[
            entry("PROMPT_TOKEN", "999.0"),
            entry("PROMPT_CACHE_MISS_TOKEN", "10.0"),
        ]);
        assert_eq!(b.total, Some(10));
        assert_eq!(b.cache_miss, Some(10));
        assert_eq!(b.cache_hit, Some(0));
    }

    #[test]
    fn 命中条目解析失败时不用_prompt_token_兜底() {
        // 与「只有命中明细」的区别：HIT 条目**存在但坏掉**，此时不能当成「没有明细」
        // 而退回兜底口径，否则解析失败会被伪装成一次正常归并。
        let b = token_breakdown(&[
            entry("PROMPT_TOKEN", "999.0"),
            entry("PROMPT_CACHE_HIT_TOKEN", "1.5"),
        ]);
        assert_eq!(b.cache_hit, None);
        assert_eq!(b.total, None);
    }

    #[test]
    fn 空输入_全零() {
        let empty = token_breakdown(&[]);
        assert_eq!(empty.total, Some(0));
        assert_eq!(empty.request, Some(0));
        assert_eq!(empty.cache_hit, Some(0));
    }

    // ---------- merge_model_slot ----------

    #[test]
    fn 首次归并_直接采用明细() {
        let b = token_breakdown(&[
            entry("PROMPT_CACHE_HIT_TOKEN", "10.0"),
            entry("RESPONSE_TOKEN", "5.0"),
            entry("REQUEST", "2.0"),
        ]);
        let merged = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &b, Some(1.25));
        assert_eq!(merged.key, FLASH_SLOT);
        assert_eq!(merged.name, "V4.1 Flash");
        assert_eq!(merged.total_tokens, Some(15));
        assert_eq!(merged.request_count, Some(2));
        assert_eq!(merged.cache_hit_tokens, Some(10));
        assert_eq!(merged.response_tokens, Some(5));
        assert_eq!(merged.cost, Some(1.25));
    }

    #[test]
    fn 新旧模型名并存_求和而非覆盖() {
        // v1.2.1 修的 bug 的回归测试：迁移期 deepseek-flash 与 deepseek-v4-flash
        // 会同时出现在账单里，它们其实是同一个模型。
        let old_name = token_breakdown(&[
            entry("PROMPT_CACHE_HIT_TOKEN", "100.0"),
            entry("PROMPT_CACHE_MISS_TOKEN", "200.0"),
            entry("RESPONSE_TOKEN", "50.0"),
            entry("REQUEST", "4.0"),
        ]);
        let new_name = token_breakdown(&[
            entry("PROMPT_CACHE_HIT_TOKEN", "1.0"),
            entry("PROMPT_CACHE_MISS_TOKEN", "2.0"),
            entry("RESPONSE_TOKEN", "3.0"),
            entry("REQUEST", "1.0"),
        ]);

        let first = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &old_name, Some(10.0));
        let merged = merge_model_slot(Some(first), FLASH_SLOT, "V4.1 Flash", &new_name, Some(0.5));

        assert_eq!(merged.total_tokens, Some(350 + 6));
        assert_eq!(merged.cache_hit_tokens, Some(101));
        assert_eq!(merged.cache_miss_tokens, Some(202));
        assert_eq!(merged.response_tokens, Some(53));
        assert_eq!(merged.request_count, Some(5));
        assert_eq!(merged.cost, Some(10.5));
    }

    #[test]
    fn 三次归并_累计不丢() {
        let b = token_breakdown(&[entry("RESPONSE_TOKEN", "10.0")]);
        let once = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &b, Some(1.0));
        let twice = merge_model_slot(Some(once), FLASH_SLOT, "V4.1 Flash", &b, Some(1.0));
        let thrice = merge_model_slot(Some(twice), FLASH_SLOT, "V4.1 Flash", &b, Some(1.0));
        assert_eq!(
            thrice.total_tokens,
            Some(30),
            "三个模型名应累加成 30，而非停留在 10"
        );
        assert_eq!(thrice.cost, Some(3.0));
    }

    #[test]
    fn 归并_保留未归类_token() {
        let b = token_breakdown(&[entry("MULTIMODAL_IMAGE_TOKEN", "42.0")]);
        let merged = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &b, Some(0.0));
        assert_eq!(merged.other_tokens, Some(42));
        assert_eq!(merged.total_tokens, Some(42));
    }

    #[test]
    fn 归并_任一费用未知时汇总费用未知() {
        let b = token_breakdown(&[entry("RESPONSE_TOKEN", "10.0")]);
        let first = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &b, Some(1.0));
        let merged = merge_model_slot(Some(first), FLASH_SLOT, "V4.1 Flash", &b, None);
        assert_eq!(merged.cost, None, "部分费用缺失不能只累加已知部分");
        let merged = merge_model_slot(Some(merged), FLASH_SLOT, "V4.1 Flash", &b, Some(2.0));
        assert_eq!(merged.cost, None, "未知一旦出现不可被后续已知值覆盖");
    }

    #[test]
    fn 归并_计数未知传染且不补零() {
        let good = token_breakdown(&[entry("RESPONSE_TOKEN", "10.0")]);
        let bad = token_breakdown(&[entry("RESPONSE_TOKEN", "1.5")]);
        let first = merge_model_slot(None, FLASH_SLOT, "V4.1 Flash", &good, Some(0.0));
        let merged = merge_model_slot(Some(first), FLASH_SLOT, "V4.1 Flash", &bad, Some(0.0));
        assert_eq!(merged.total_tokens, None);
        assert_eq!(merged.response_tokens, None);
        assert_eq!(merged.cost, Some(0.0));
    }

    #[test]
    fn 计数超出安全整数为未知() {
        let b = token_breakdown(&[
            entry("RESPONSE_TOKEN", "9007199254740991"),
            entry("RESPONSE_TOKEN", "1"),
        ]);
        assert_eq!(b.response, None, "累加越过安全整数上界应为未知");
        assert_eq!(b.total, None);
        assert_eq!(
            count("9007199254740991"),
            Some(9007199254740991),
            "上界本身可接受"
        );
        assert_eq!(count("9007199254740992"), None);
    }

    // ---------- cost_sum ----------

    #[test]
    fn 费用求和_排除_request_条目() {
        let usage = vec![
            entry("REQUEST", "120.0"), // 次数，不是钱
            entry("PROMPT_CACHE_HIT_TOKEN", "0.5"),
            entry("RESPONSE_TOKEN", "1.5"),
        ];
        let sum = cost_sum(&usage).unwrap();
        assert!((sum - 2.0).abs() < 1e-9);
    }

    #[test]
    fn 费用求和_无法解析为未知而非零() {
        let usage = vec![
            entry("RESPONSE_TOKEN", "abc"),
            entry("RESPONSE_TOKEN", "2.5"),
        ];
        assert_eq!(cost_sum(&usage), None, "缺失费用不能折算成零元");
    }

    #[test]
    fn 费用求和_负数与无穷为未知() {
        for value in ["-1", "NaN", "inf", "1e400"] {
            assert_eq!(cost_sum(&[entry("RESPONSE_TOKEN", value)]), None, "{value}");
        }
    }

    #[test]
    fn 费用求和_空输入为零() {
        assert_eq!(cost_sum(&[]), Some(0.0));
    }
}
