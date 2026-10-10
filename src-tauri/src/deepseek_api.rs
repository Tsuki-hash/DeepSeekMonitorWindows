//! DeepSeek 平台 HTTP 业务：余额、用量拉取与聚合。
//!
//! 网络 I/O 与「响应 → 界面模型」的纯聚合拆开，后者可直接单测（含反序列化样本），
//! 不必启动 Tauri 或打真实接口。

use crate::http::http_client;
use crate::usage::{
    cost_sum, merge_model_slot, model_slot, token_breakdown, Entry, UsageModelSummary, FLASH_SLOT,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceResult {
    pub is_available: bool,
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Debug, Deserialize)]
struct BalanceInfo {
    currency: String,
    total_balance: String,
    granted_balance: String,
    topped_up_balance: String,
}

#[derive(Debug, Deserialize)]
struct BalanceResponse {
    is_available: bool,
    balance_infos: Vec<BalanceInfo>,
}

/// 纯解析：余额 JSON → 结构。供单测直接喂样本。
fn parse_balance(data: BalanceResponse) -> Result<BalanceResult, String> {
    let info = data
        .balance_infos
        .into_iter()
        .next()
        .ok_or_else(|| "余额信息为空".to_string())?;
    Ok(BalanceResult {
        is_available: data.is_available,
        currency: info.currency,
        total_balance: info.total_balance,
        granted_balance: info.granted_balance,
        topped_up_balance: info.topped_up_balance,
    })
}

// BalanceResponse 字段私有，测试在本模块内反序列化后调用 parse_balance。
impl BalanceResponse {
    fn from_json(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|error| format!("解析余额数据失败：{error}"))
    }
}

/// 实时查询 DeepSeek 账户余额。
pub async fn fetch_balance_with_key(api_key: &str) -> Result<BalanceResult, String> {
    let client = http_client()?;
    let response = client
        .get("https://api.deepseek.com/user/balance")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("网络请求失败：{error}"))?;

    match response.status().as_u16() {
        200 => {}
        401 => return Err("API Key 无效或已过期".to_string()),
        429 => return Err("请求过于频繁，请稍后再试".to_string()),
        code if code >= 500 => return Err(format!("DeepSeek 服务器错误：{code}")),
        code => return Err(format!("请求失败：HTTP {code}")),
    }

    let text = response
        .text()
        .await
        .map_err(|error| format!("读取余额响应失败：{error}"))?;
    parse_balance(BalanceResponse::from_json(&text)?)
}

/// 用量 Token 校验失败的性质。
/// **Definitive**：Token 本身被明确拒绝（401/403），与探针月份无关，重试没有意义；
/// **Transient**：网络、服务端或路由类失败（连接错误/404/429/5xx），值得稍后重试。
///
/// 用量拉取路径（`get_json`）保留按状态码分级的完整文案；校验路径只关心
/// 「要不要重试」，因此收敛成两值枚举供同步链路做不同处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyFailure {
    Definitive,
    Transient,
}

impl VerifyFailure {
    pub fn message(self) -> String {
        match self {
            VerifyFailure::Definitive => {
                "用量 Token 无效或已过期，请重新同步或手动粘贴用量 Token".to_string()
            }
            VerifyFailure::Transient => {
                "用量接口暂时不可用，请稍后重试；余额查询不受影响".to_string()
            }
        }
    }
}

/// 用 token 试调平台用量接口，验证它确实是有效的用量 token。
pub async fn verify_usage_token(token: &str, month: u32, year: u32) -> Result<(), VerifyFailure> {
    let url =
        format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
    let resp = http_client()
        .map_err(|_| VerifyFailure::Transient)?
        .get(&url)
        .bearer_auth(token)
        .header("x-app-version", "1.0.0")
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|_| VerifyFailure::Transient)?;
    match resp.status().as_u16() {
        200 => {
            let parsed = resp
                .json::<AmountResp>()
                .await
                .map_err(|_| VerifyFailure::Transient)?;
            let valid = parsed
                .data
                .biz_data
                .total
                .iter()
                .chain(parsed.data.biz_data.days.iter().flat_map(|d| d.data.iter()))
                .flat_map(|m| m.usage.iter())
                .all(|e| {
                    e.amount
                        .parse::<f64>()
                        .is_ok_and(|n| n.is_finite() && n >= 0.0 && n < u64::MAX as f64)
                });
            if valid {
                Ok(())
            } else {
                Err(VerifyFailure::Transient)
            }
        }
        // 401/403 是对凭据本身的明确拒绝，与查询月份无关
        401 | 403 => Err(VerifyFailure::Definitive),
        _ => Err(VerifyFailure::Transient),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelUsage {
    pub model: String,
    pub usage: Vec<Entry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DayUsage {
    pub date: String,
    pub data: Vec<ModelUsage>,
}

#[derive(Debug, Deserialize)]
pub struct AmountBiz {
    pub total: Vec<ModelUsage>,
    pub days: Vec<DayUsage>,
}

#[derive(Debug, Deserialize)]
pub struct AmountData {
    pub biz_data: AmountBiz,
}

#[derive(Debug, Deserialize)]
pub struct AmountResp {
    pub data: AmountData,
}

#[derive(Debug, Deserialize)]
pub struct CostBiz {
    pub total: Vec<ModelUsage>,
    pub days: Vec<DayUsage>,
}

#[derive(Debug, Deserialize)]
pub struct CostData {
    pub biz_data: Vec<CostBiz>,
}

#[derive(Debug, Deserialize)]
pub struct CostResp {
    pub data: CostData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDaySummary {
    pub date: String,
    pub raw_models: Vec<crate::usage_history::RawModelUsage>,
    pub flash_tokens: u64,
    pub flash_cache_hit: u64,
    pub flash_cache_miss: u64,
    pub flash_response: u64,
    pub pro_tokens: u64,
    pub pro_cache_hit: u64,
    pub pro_cache_miss: u64,
    pub pro_response: u64,
    pub flash_other_tokens: u64,
    pub pro_other_tokens: u64,
    pub total_tokens: u64,
    pub total_cost: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub schema_version: u32,
    pub model_mapping_version: &'static str,
    pub raw_models: Vec<crate::usage_history::RawModelUsage>,
    pub warnings: Vec<String>,
    pub models: Vec<UsageModelSummary>,
    pub days: Vec<UsageDaySummary>,
    pub month_cost: f64,
}

/// 纯聚合：amount/cost 响应 → 界面用量结构。新旧模型名归并、费用口径均在此。
pub fn build_usage_result(amount: &AmountResp, cost: &CostResp) -> UsageResult {
    let cost_total = cost.data.biz_data.first();
    let raw_models = crate::usage_history::raw_models(
        &amount.data.biz_data.total,
        cost_total.map(|c| c.total.as_slice()).unwrap_or(&[]),
    );
    let cost_for_model = |model: &str| -> f64 {
        cost_total
            .map(|item| {
                item.total
                    .iter()
                    .filter(|m| m.model == model)
                    .map(|m| cost_sum(&m.usage))
                    .sum()
            })
            .unwrap_or(0.0)
    };

    // 按槽位归并：迁移期内 deepseek-flash 与旧名可能同时出现在同一份账单里，
    // 它们其实是同一个模型，必须累加，否则前端只取第一个会漏掉另一部分用量。
    let mut flash_sum: Option<UsageModelSummary> = None;
    let mut pro_sum: Option<UsageModelSummary> = None;
    // 未知模型（如后续上线的 V4.1 Pro）聚合为「其他」兜底行，避免新模型名
    // 接入前其用量「日合计有、模型行无」地静默消失。正式接入仍以 model_slot 为准。
    let mut other_sum: Option<UsageModelSummary> = None;
    let mut source = amount.data.biz_data.total.clone();
    let mut model_names: std::collections::HashSet<String> =
        source.iter().map(|m| m.model.clone()).collect();
    if let Some(cost) = cost_total {
        for entry in &cost.total {
            if model_names.insert(entry.model.clone()) {
                source.push(ModelUsage {
                    model: entry.model.clone(),
                    usage: vec![],
                });
            }
        }
    }
    let mut charged_models = std::collections::HashSet::new();
    for model_usage in &source {
        let breakdown = token_breakdown(&model_usage.usage);
        let cost = if charged_models.insert(&model_usage.model) {
            cost_for_model(&model_usage.model)
        } else {
            0.0
        };
        match model_slot(&model_usage.model) {
            Some((slot, display)) if slot == FLASH_SLOT => {
                flash_sum = Some(merge_model_slot(
                    flash_sum.take(),
                    slot,
                    display,
                    &breakdown,
                    cost,
                ));
            }
            Some((slot, display)) => {
                pro_sum = Some(merge_model_slot(
                    pro_sum.take(),
                    slot,
                    display,
                    &breakdown,
                    cost,
                ));
            }
            None => {
                log::warn!("未知模型 {}，已聚合进「其他」行", model_usage.model);
                other_sum = Some(merge_model_slot(
                    other_sum.take(),
                    "other",
                    "其他",
                    &breakdown,
                    cost,
                ));
            }
        }
    }

    let mut models = Vec::new();
    models.extend(flash_sum);
    models.extend(pro_sum);
    // 本月没有未知模型时不出「其他」行，避免常态下多一行空白
    if let Some(other) = other_sum.filter(|sum| sum.total_tokens > 0 || sum.cost != 0.0) {
        models.push(other);
    }

    let mut cost_by_date: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    if let Some(item) = cost_total {
        for day in &item.days {
            let day_cost: f64 = day.data.iter().map(|m| cost_sum(&m.usage)).sum();
            *cost_by_date.entry(day.date.clone()).or_default() += day_cost;
        }
    }

    let mut days = Vec::new();
    let mut daily_source = amount.data.biz_data.days.clone();
    let mut known_dates: std::collections::HashSet<_> =
        daily_source.iter().map(|d| d.date.clone()).collect();
    for date in cost_by_date.keys() {
        if known_dates.insert(date.clone()) {
            daily_source.push(DayUsage {
                date: date.clone(),
                data: vec![],
            });
        }
    }
    let mut raw_amount_days: std::collections::BTreeMap<&str, Vec<ModelUsage>> =
        std::collections::BTreeMap::new();
    let mut raw_cost_days: std::collections::BTreeMap<&str, Vec<ModelUsage>> =
        std::collections::BTreeMap::new();
    for day in &amount.data.biz_data.days {
        raw_amount_days
            .entry(&day.date)
            .or_default()
            .extend(day.data.iter().cloned());
    }
    if let Some(item) = cost_total {
        for day in &item.days {
            raw_cost_days
                .entry(&day.date)
                .or_default()
                .extend(day.data.iter().cloned());
        }
    }
    for day in &daily_source {
        let mut flash = 0u64;
        let mut flash_hit = 0u64;
        let mut flash_miss = 0u64;
        let mut flash_resp = 0u64;
        let mut pro = 0u64;
        let mut pro_hit = 0u64;
        let mut pro_miss = 0u64;
        let mut pro_resp = 0u64;
        let mut total = 0u64;
        let mut flash_other = 0u64;
        let mut pro_other = 0u64;
        for model_usage in &day.data {
            let breakdown = token_breakdown(&model_usage.usage);
            total += breakdown.total;
            // total 覆盖当天全部模型（含未知模型），槽位分摊只作用于已识别的模型
            if let Some((slot, _)) = model_slot(&model_usage.model) {
                if slot == FLASH_SLOT {
                    flash += breakdown.total;
                    flash_hit += breakdown.cache_hit;
                    flash_miss += breakdown.cache_miss;
                    flash_resp += breakdown.response;
                    flash_other += breakdown.other;
                } else {
                    pro += breakdown.total;
                    pro_hit += breakdown.cache_hit;
                    pro_miss += breakdown.cache_miss;
                    pro_resp += breakdown.response;
                    pro_other += breakdown.other;
                }
            }
        }
        days.push(UsageDaySummary {
            date: day.date.clone(),
            raw_models: crate::usage_history::raw_models(
                raw_amount_days
                    .get(day.date.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                raw_cost_days
                    .get(day.date.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            ),
            flash_tokens: flash,
            flash_cache_hit: flash_hit,
            flash_cache_miss: flash_miss,
            flash_response: flash_resp,
            pro_tokens: pro,
            pro_cache_hit: pro_hit,
            pro_cache_miss: pro_miss,
            pro_response: pro_resp,
            flash_other_tokens: flash_other,
            pro_other_tokens: pro_other,
            total_tokens: total,
            total_cost: cost_by_date.get(&day.date).copied().unwrap_or(0.0),
        });
    }

    let month_cost: f64 = cost_total
        .map(|item| item.total.iter().map(|m| cost_sum(&m.usage)).sum())
        .unwrap_or(0.0);

    let mut warnings = if source.len() != amount.data.biz_data.total.len()
        || daily_source.len() != amount.data.biz_data.days.len()
    {
        vec!["费用与 Token 数据尚未完全对齐，请稍后刷新".into()]
    } else {
        vec![]
    };
    if raw_models
        .iter()
        .chain(days.iter().flat_map(|day| &day.raw_models))
        .any(|model| model.data_warning.is_some())
    {
        warnings.push("平台 Token 计数异常，受影响的历史字段保留为未知".into());
    }
    UsageResult {
        schema_version: 2,
        model_mapping_version: "deepseek-slots-v1",
        raw_models,
        warnings,
        models,
        days,
        month_cost,
    }
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .bearer_auth(token)
        .header("x-app-version", "1.0.0")
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|error| format!("用量请求失败：{error}"))?;
    match resp.status().as_u16() {
        200 => {}
        401 => return Err("用量 Token 无效或已过期，请重新同步用量 Token（设置页）".to_string()),
        403 => return Err("用量接口拒绝访问，请重新同步用量 Token（设置页）".to_string()),
        404 => return Err("用量接口路径可能已变更，可稍后重试或使用手动粘贴 Token".to_string()),
        429 => return Err("请求过于频繁，请稍后再试".to_string()),
        code if code >= 500 => {
            return Err(format!(
                "用量服务暂时不可用（HTTP {code}），余额查询不受影响"
            ))
        }
        code => return Err(format!("用量接口错误：HTTP {code}，余额查询不受影响")),
    }
    resp.json::<T>()
        .await
        .map_err(|error| format!("解析用量数据失败：{error}"))
}

/// 并发拉取 amount/cost 并聚合成界面结构。
pub async fn fetch_usage_with_token(
    token: &str,
    month: u32,
    year: u32,
) -> Result<UsageResult, String> {
    let client = http_client()?;
    let amount_url =
        format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
    let cost_url =
        format!("https://platform.deepseek.com/api/v0/usage/cost?month={month}&year={year}");

    // 两个端点互相独立、同一 token，串行等待会让总延迟等于两者之和（各自含 15s 超时上限）。
    let (amount, cost): (AmountResp, CostResp) = tokio::try_join!(
        get_json(client, &amount_url, token),
        get_json(client, &cost_url, token),
    )?;

    if cost.data.biz_data.len() > 1 {
        return Err("平台返回多个费用业务分组，暂无法确认统计口径，请保留旧数据并反馈".into());
    }
    validate_usage_entries(&amount, &cost)?;
    Ok(build_usage_result(&amount, &cost))
}

fn validate_usage_entries(amount: &AmountResp, cost: &CostResp) -> Result<(), String> {
    let entries = amount
        .data
        .biz_data
        .total
        .iter()
        .chain(amount.data.biz_data.days.iter().flat_map(|d| d.data.iter()))
        .chain(cost.data.biz_data.iter().flat_map(|b| {
            b.total
                .iter()
                .chain(b.days.iter().flat_map(|d| d.data.iter()))
        }))
        .flat_map(|m| m.usage.iter());
    for entry in entries {
        let n = entry
            .amount
            .parse::<f64>()
            .map_err(|_| "平台返回无法解析的用量数值，请稍后重试")?;
        if !n.is_finite() || n < 0.0 || n >= u64::MAX as f64 {
            return Err("平台返回超出范围的用量数值，请稍后重试".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 费用重复条目累加_同模型多数量条目不重复收费() {
        let mut amount = amount_sample();
        amount
            .data
            .biz_data
            .total
            .push(amount.data.biz_data.total[0].clone());
        let mut cost = cost_sample();
        let duplicate = cost.data.biz_data[0].total[0].clone();
        cost.data.biz_data[0].total.push(duplicate);
        let result = build_usage_result(&amount, &cost);
        assert!((result.models[0].cost - 0.6).abs() < 1e-9);
        assert!((result.month_cost - 0.6).abs() < 1e-9);
    }

    #[test]
    fn finite_fractional_count_passes_existing_entry_gate_but_history_is_unknown_with_warning() {
        let mut amount = amount_sample();
        for model in [
            &mut amount.data.biz_data.total[0],
            &mut amount.data.biz_data.days[0].data[0],
        ] {
            model.usage.push(Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "0.25".into(),
            });
        }
        let cost = cost_sample();
        assert!(validate_usage_entries(&amount, &cost).is_ok());
        let result = build_usage_result(&amount, &cost);
        let monthly = result
            .raw_models
            .iter()
            .find(|model| model.model == amount.data.biz_data.total[0].model)
            .unwrap();
        assert_eq!(monthly.response_tokens, None);
        assert_eq!(monthly.total_tokens, None);
        assert!(monthly.data_warning.is_some());
        let daily = result.days[0]
            .raw_models
            .iter()
            .find(|model| model.model == amount.data.biz_data.days[0].data[0].model)
            .unwrap();
        assert_eq!(daily.response_tokens, None);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("Token 计数异常")));
    }

    #[test]
    fn 历史原始模型保留别名且日模型费用请求独立() {
        let result = build_usage_result(&amount_sample(), &cost_sample());
        assert_eq!(result.schema_version, 2);
        assert!(result
            .raw_models
            .iter()
            .any(|m| m.model == "deepseek-flash"));
        assert!(result
            .raw_models
            .iter()
            .any(|m| m.model == "deepseek-v4-flash"));
        let flash = result.days[0]
            .raw_models
            .iter()
            .find(|m| m.model == "deepseek-flash")
            .unwrap();
        assert!(flash.total_tokens.is_some());
        assert!(flash.cost.is_some());
    }

    #[test]
    fn 历史仅日记录的未知模型保留名称且缺费用不为零() {
        let mut amount = amount_sample();
        amount.data.biz_data.days[0].data.push(ModelUsage {
            model: "future-model".into(),
            usage: vec![Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "7".into(),
            }],
        });
        let result = build_usage_result(&amount, &cost_sample());
        let model = result.days[0]
            .raw_models
            .iter()
            .find(|m| m.model == "future-model")
            .unwrap();
        assert_eq!(model.total_tokens, Some(7));
        assert_eq!(model.cost, None);
        assert_eq!(model.request_count, None);
        assert_eq!(model.group_key, None);
    }

    #[test]
    fn 只有费用的模型日期仍显示并标记不完整() {
        let mut amount = amount_sample();
        amount.data.biz_data.total.clear();
        amount.data.biz_data.days.clear();
        let result = build_usage_result(&amount, &cost_sample());
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.days.len(), 1);
        assert_eq!(result.days[0].date, "2026-09-01");
        assert!((result.days[0].total_cost - 0.05).abs() < 1e-9);
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn 非法用量数值拒绝作为成功数据() {
        for value in ["NaN", "inf", "-1", "not-a-number"] {
            let mut amount = amount_sample();
            amount.data.biz_data.total[0].usage[0].amount = value.into();
            assert!(validate_usage_entries(&amount, &cost_sample()).is_err());
        }
    }

    fn amount_sample() -> AmountResp {
        let json = r#"{
            "data": {
                "biz_data": {
                    "total": [
                        {
                            "model": "deepseek-flash",
                            "usage": [
                                {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"},
                                {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"50.0"},
                                {"type":"RESPONSE_TOKEN","amount":"25.0"},
                                {"type":"REQUEST","amount":"3.0"}
                            ]
                        },
                        {
                            "model": "deepseek-v4-flash",
                            "usage": [
                                {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"10.0"},
                                {"type":"RESPONSE_TOKEN","amount":"5.0"}
                            ]
                        }
                    ],
                    "days": [
                        {
                            "date": "2026-09-01",
                            "data": [
                                {
                                    "model": "deepseek-flash",
                                    "usage": [
                                        {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"40.0"},
                                        {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"20.0"},
                                        {"type":"RESPONSE_TOKEN","amount":"10.0"}
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }"#;
        serde_json::from_str(json).unwrap()
    }

    fn cost_sample() -> CostResp {
        let json = r#"{
            "data": {
                "biz_data": [
                    {
                        "total": [
                            {
                                "model": "deepseek-flash",
                                "usage": [
                                    {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"0.10"},
                                    {"type":"RESPONSE_TOKEN","amount":"0.20"},
                                    {"type":"REQUEST","amount":"9"}
                                ]
                            }
                        ],
                        "days": [
                            {
                                "date": "2026-09-01",
                                "data": [
                                    {
                                        "model": "deepseek-flash",
                                        "usage": [
                                            {"type":"RESPONSE_TOKEN","amount":"0.05"}
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        }"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn 余额样本_解析出第一条() {
        let raw = r#"{
            "is_available": true,
            "balance_infos": [
                {
                    "currency": "CNY",
                    "total_balance": "12.34",
                    "granted_balance": "1.00",
                    "topped_up_balance": "11.34"
                }
            ]
        }"#;
        let parsed = BalanceResponse::from_json(raw).unwrap();
        let balance = parse_balance(parsed).unwrap();
        assert!(balance.is_available);
        assert_eq!(balance.currency, "CNY");
        assert_eq!(balance.total_balance, "12.34");
    }

    #[test]
    fn 余额样本_空列表报错() {
        let raw = r#"{"is_available": true, "balance_infos": []}"#;
        let parsed = BalanceResponse::from_json(raw).unwrap();
        assert!(parse_balance(parsed).is_err());
    }

    #[test]
    fn 用量聚合_新旧模型名归并到同一行() {
        let result = build_usage_result(&amount_sample(), &cost_sample());
        assert_eq!(result.models.len(), 1);
        let flash = &result.models[0];
        assert_eq!(flash.key, "flash");
        assert_eq!(flash.name, "V4.1 Flash");
        assert_eq!(flash.cache_hit_tokens, 110);
        assert_eq!(flash.response_tokens, 30);
        assert_eq!(flash.request_count, 3);
        // 0.10 + 0.20（REQUEST 不计费用）
        assert!((flash.cost - 0.30).abs() < 1e-9);
        assert!((result.month_cost - 0.30).abs() < 1e-9);
    }

    #[test]
    fn 用量聚合_按日费用对齐日期() {
        let result = build_usage_result(&amount_sample(), &cost_sample());
        assert_eq!(result.days.len(), 1);
        assert_eq!(result.days[0].date, "2026-09-01");
        assert!((result.days[0].total_cost - 0.05).abs() < 1e-9);
        assert_eq!(result.days[0].total_tokens, 70);
    }

    #[test]
    fn 用量聚合_未知模型聚合为其他行() {
        let amount_json = r#"{
            "data": {
                "biz_data": {
                    "total": [
                        {
                            "model": "deepseek-mystery",
                            "usage": [
                                {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"5.0"},
                                {"type":"RESPONSE_TOKEN","amount":"5.0"}
                            ]
                        }
                    ],
                    "days": [
                        {
                            "date": "2026-09-02",
                            "data": [
                                {
                                    "model": "deepseek-mystery",
                                    "usage": [
                                        {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"5.0"},
                                        {"type":"RESPONSE_TOKEN","amount":"5.0"}
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }"#;
        let cost_json = r#"{"data":{"biz_data":[]}}"#;
        let amount: AmountResp = serde_json::from_str(amount_json).unwrap();
        let cost: CostResp = serde_json::from_str(cost_json).unwrap();
        let result = build_usage_result(&amount, &cost);
        // 未知模型聚合为「其他」兜底行，而不是静默丢失
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.models[0].key, "other");
        assert_eq!(result.models[0].name, "其他");
        assert_eq!(result.models[0].total_tokens, 10);
        assert_eq!(result.days[0].total_tokens, 10);
    }

    #[test]
    fn 用量聚合_仅在days中出现的未知模型_计入日total但不出行() {
        // 边界口径：模型行一律来自月度 total；只在 days 出现的模型不生成
        // 「其他」行（其 token 仍计入当日合计）。记录该边界，改动须是刻意的。
        let amount_json = r#"{
            "data": {
                "biz_data": {
                    "total": [],
                    "days": [
                        {
                            "date": "2026-09-02",
                            "data": [
                                {
                                    "model": "deepseek-mystery",
                                    "usage": [
                                        {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"5.0"},
                                        {"type":"RESPONSE_TOKEN","amount":"5.0"}
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }"#;
        let cost_json = r#"{"data":{"biz_data":[]}}"#;
        let amount: AmountResp = serde_json::from_str(amount_json).unwrap();
        let cost: CostResp = serde_json::from_str(cost_json).unwrap();
        let result = build_usage_result(&amount, &cost);
        assert!(result.models.is_empty());
        assert_eq!(result.days[0].total_tokens, 10);
    }

    #[test]
    fn 用量聚合_多个未知模型累加进其他行() {
        let amount_json = r#"{
            "data": {
                "biz_data": {
                    "total": [
                        {"model": "deepseek-mystery-a", "usage": [{"type":"RESPONSE_TOKEN","amount":"10.0"}]},
                        {"model": "deepseek-mystery-b", "usage": [{"type":"RESPONSE_TOKEN","amount":"6.0"}]}
                    ],
                    "days": []
                }
            }
        }"#;
        let cost_json = r#"{"data":{"biz_data":[]}}"#;
        let amount: AmountResp = serde_json::from_str(amount_json).unwrap();
        let cost: CostResp = serde_json::from_str(cost_json).unwrap();
        let result = build_usage_result(&amount, &cost);
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.models[0].key, "other");
        assert_eq!(result.models[0].total_tokens, 16);
    }
}
