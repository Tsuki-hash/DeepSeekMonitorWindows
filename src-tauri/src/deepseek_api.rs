//! DeepSeek 平台 HTTP 业务：余额、用量拉取与聚合。
//!
//! 网络 I/O 与「响应 → 界面模型」的纯聚合拆开，后者可直接单测（含反序列化样本），
//! 不必启动 Tauri 或打真实接口。

use crate::error::ErrorKind;
use crate::http::http_client;
use crate::usage::{
    merge_model_slot, model_slot, token_breakdown, Entry, UsageModelSummary, FLASH_SLOT,
};
use serde::{Deserialize, Serialize};

/// 来源层错误：稳定 kind + 展示文案。
///
/// 评审 P2：网络层原先返回 `String`，上层只能靠匹配中文分类，改措辞就会改重试策略。
/// 现在 HTTP 状态码在**产生错误的地方**就映射成 `ErrorKind`，展示层只负责翻译文案。
#[derive(Debug, Clone)]
pub struct ApiError {
    pub kind: ErrorKind,
    pub message: String,
}

impl ApiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ApiError> for crate::error::CommandError {
    fn from(error: ApiError) -> Self {
        crate::error::CommandError::kind(error.message, error.kind, None)
    }
}

/// 旧调用点（提示检查等）仍在用字符串错误：默认按「暂不可用」分类。
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        ApiError::new(ErrorKind::Unavailable, message)
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        ApiError::new(ErrorKind::Unavailable, message)
    }
}

/// HTTP 状态码 → 稳定错误种类。未知状态码按「暂不可用」处理（可重试）。
fn status_kind(code: u16) -> ErrorKind {
    match code {
        401 | 403 => ErrorKind::CredentialsInvalid,
        429 => ErrorKind::RateLimited,
        code if code >= 500 => ErrorKind::Unavailable,
        404 => ErrorKind::Unavailable,
        _ => ErrorKind::Unknown,
    }
}

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

/// 余额显示的防御上界，沿用托盘既有范围；不是 DeepSeek 的业务余额上限。
/// 各入口使用同一范围，不能在首页成功后才被提醒或托盘拒绝。
const MAX_DISPLAY_BALANCE: f64 = 1e15;

/// 余额金额的共同值域。保留明确零、欠费负数及原有浮点数字语法；
/// 不把空白、非有限值或下溢的非零数当成可展示的零余额。
pub(crate) fn validate_balance_amount(raw: &str) -> Result<f64, String> {
    let value = raw.parse::<f64>().map_err(|_| "余额金额不是有效数字")?;
    if !value.is_finite() || value.abs() > MAX_DISPLAY_BALANCE {
        return Err("余额金额超出可显示范围".into());
    }
    let mantissa = raw.split(['e', 'E']).next().unwrap_or(raw);
    if value == 0.0 && mantissa.bytes().any(|byte| matches!(byte, b'1'..=b'9')) {
        return Err("余额金额过小，不能可靠表示".into());
    }
    Ok(value)
}

/// 首页与托盘当前支持的账户币种。未知币种不能默认为人民币。
pub(crate) fn balance_currency_symbol(currency: &str) -> Result<&'static str, String> {
    match currency {
        "CNY" => Ok("¥"),
        "USD" => Ok("$"),
        _ => Err("余额币种不可用".into()),
    }
}

/// 纯解析：余额 JSON → 已校验结构。沿用首条账户余额语义，不跳过坏行找好行。
fn parse_balance(data: BalanceResponse) -> Result<BalanceResult, String> {
    let info = data
        .balance_infos
        .into_iter()
        .next()
        .ok_or_else(|| "余额信息为空".to_string())?;
    balance_currency_symbol(&info.currency)?;
    for (field, value) in [
        ("total_balance", &info.total_balance),
        ("granted_balance", &info.granted_balance),
        ("topped_up_balance", &info.topped_up_balance),
    ] {
        validate_balance_amount(value).map_err(|error| format!("{field}：{error}"))?;
    }
    // 账户不可用可能只是余额为零或欠费，不等于 API Key 失效。
    // 金额保留原始精度文本，不补零、不取绝对值，也不擅自校正各余额分项。
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

/// 所有生产余额请求共用的 JSON 入口：结构或值域异常均为 InvalidData，
/// 在产生 BalanceResult 前失败，调用者沿既有失败路径保留最后可信快照/凭据。
pub(crate) fn parse_balance_json(text: &str) -> Result<BalanceResult, ApiError> {
    BalanceResponse::from_json(text)
        .and_then(parse_balance)
        .map_err(|message| ApiError::new(ErrorKind::InvalidData, message))
}

/// 实时查询 DeepSeek 账户余额。
pub async fn fetch_balance_with_key(api_key: &str) -> Result<BalanceResult, ApiError> {
    let client = http_client().map_err(|error| ApiError::new(ErrorKind::Unavailable, error))?;
    let response = client
        .get("https://api.deepseek.com/user/balance")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| ApiError::new(ErrorKind::Unavailable, format!("网络请求失败：{error}")))?;

    match response.status().as_u16() {
        200 => {}
        code => {
            let kind = status_kind(code);
            let message = match code {
                401 => "API Key 无效或已过期".to_string(),
                429 => "请求过于频繁，请稍后再试".to_string(),
                code if code >= 500 => format!("DeepSeek 服务器错误：{code}"),
                code => format!("请求失败：HTTP {code}"),
            };
            return Err(ApiError::new(kind, message));
        }
    }

    // 复评 N18：响应体必须有**字节上限**。旧实现直接 `response.text()`
    // 整读，15 秒超时不限制体积；异常/超长响应会先吃满内存。
    let text = read_bounded_body(response, MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| body_error_to_api("读取余额响应失败", error))?;
    parse_balance_json(&text)
}

/// 复评 N18：官方响应体的字节上限（16MiB，与采集输出同量级）。
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// 复评 N18/T11：响应体读取失败的类型化原因。
///
/// 旧实现把所有失败压成一个 `String`，调用方再统一映射成 `InvalidData` ——
/// 于是「200 头之后断流 / 超时」这类**传输**故障被当成数据格式错误，
/// 通道退避被清零、历史批次继续连打下一个月。这里保留类型，让上层按
/// 传输 / 超限 / 编码分别映射（不靠解析中文文案猜）。
enum BodyError {
    /// 传输层故障（连接中断、超时、分块错误）。
    Transport(String),
    /// 超过字节上限。
    TooLarge(usize),
    /// 编码或结构不可用。
    Invalid(String),
}

/// 复评 N18：按块读取响应体，超过上限立即失败。
async fn read_bounded_body(response: reqwest::Response, limit: usize) -> Result<String, BodyError> {
    let mut response = response;
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| BodyError::Transport(error.to_string()))?
    {
        if buffer.len() + chunk.len() > limit {
            return Err(BodyError::TooLarge(limit));
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| BodyError::Invalid("响应不是有效 UTF-8".into()))
}

/// 复评 T11：把 `BodyError` 映射成 API 错误（传输 → Unavailable，保留退避）。
fn body_error_to_api(label: &str, error: BodyError) -> ApiError {
    match error {
        BodyError::Transport(message) => {
            ApiError::new(ErrorKind::Unavailable, format!("{label}：{message}"))
        }
        BodyError::TooLarge(limit) => ApiError::new(
            ErrorKind::InvalidData,
            format!("{label}：超过 {limit} 字节上限"),
        ),
        BodyError::Invalid(message) => {
            ApiError::new(ErrorKind::InvalidData, format!("{label}：{message}"))
        }
    }
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
            // 复评 T16：Token 验证也走统一的有界读取，不再 `json()` 整读 ——
            // 官方端点的巨大 200 响应不该先吃满内存。超限/编码按 Transient
            // 处理（候选凭据不提交，原凭据不变）。
            let body = read_bounded_body(resp, MAX_RESPONSE_BYTES)
                .await
                .map_err(|_| VerifyFailure::Transient)?;
            verify_usage_body(&body)
        }
        // 401/403 是对凭据本身的明确拒绝，与查询月份无关
        401 | 403 => Err(VerifyFailure::Definitive),
        _ => Err(VerifyFailure::Transient),
    }
}

/// R21：验证与读取共用原始数值入口，不能把 -1e-400 下溢成的 -0 当合法零。
/// 这里仍只验证 amount 响应的结构和值域，不要求计数完整、费用齐全或无质量警告；
/// 响应异常不证明 Token 失效，保持 Transient，允许上月探针或稍后重试。
pub(crate) fn verify_usage_body(body: &str) -> Result<(), VerifyFailure> {
    let parsed: AmountResp = serde_json::from_str(body).map_err(|_| VerifyFailure::Transient)?;
    validate_usage_values(amount_entries(&parsed)).map_err(|_| VerifyFailure::Transient)
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
    /// 以下计数为 `None` 表示平台没给或无法解析；不能当作零用量。
    pub flash_tokens: Option<u64>,
    pub flash_cache_hit: Option<u64>,
    pub flash_cache_miss: Option<u64>,
    pub flash_response: Option<u64>,
    pub pro_tokens: Option<u64>,
    pub pro_cache_hit: Option<u64>,
    pub pro_cache_miss: Option<u64>,
    pub pro_response: Option<u64>,
    pub flash_other_tokens: Option<u64>,
    pub pro_other_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// `None` 表示费用接口没有返回该日期；不是「当天免费」。
    pub total_cost: Option<f64>,
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
    /// `None` 表示费用接口缺项/无法解析；主面板显示「—」而不是 ¥0.00。
    pub month_cost: Option<f64>,
    /// R20：只在本次原始响应中生成的预算证据，不写入旧 JSON/前端缓存。
    /// 不能用显示金额反推；缺失时提醒失败关闭，展示 schema 保持 v2。
    #[serde(skip)]
    pub(crate) budget_month_cost: Option<crate::usage::DecimalAmount>,
}

/// 查询月和请求开始时的 UTC+8 记账日共同限定质量检查范围。
/// 当前月只要求月初至源日，历史月要求完整自然月；响应回来时不重新读时钟。
#[derive(Clone, Copy, Debug)]
pub(crate) struct UsagePeriod {
    first: chrono::NaiveDate,
    last: chrono::NaiveDate,
    month_end: chrono::NaiveDate,
}

impl UsagePeriod {
    pub(crate) fn at(
        year: u32,
        month: u32,
        source_time: chrono::DateTime<chrono::Utc>,
    ) -> Result<Self, String> {
        let year = i32::try_from(year).map_err(|_| "非法的用量查询年份")?;
        let first = chrono::NaiveDate::from_ymd_opt(year, month, 1).ok_or("非法的用量查询月份")?;
        let month_end = first
            .checked_add_months(chrono::Months::new(1))
            .and_then(|next| next.pred_opt())
            .ok_or("用量查询月份超出范围")?;
        let source_date = source_time
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("UTC+8"))
            .date_naive();
        if first > source_date {
            return Err("不能查询尚未开始的记账月".into());
        }
        Ok(Self {
            first,
            last: source_date.min(month_end),
            month_end,
        })
    }

    fn parse_date(date: &str) -> Option<chrono::NaiveDate> {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .ok()
            .filter(|parsed| parsed.to_string() == date)
    }

    fn includes_day(self, date: &str) -> bool {
        Self::parse_date(date).is_some_and(|date| (self.first..=self.last).contains(&date))
    }

    fn is_query_month(self, date: &str) -> bool {
        Self::parse_date(date).is_some_and(|date| (self.first..=self.month_end).contains(&date))
    }
}

pub(crate) fn build_usage_result_for_period(
    amount: &AmountResp,
    cost: &CostResp,
    period: UsagePeriod,
) -> UsageResult {
    build_usage_result_inner(amount, cost, Some(period))
}

/// 旧算术单测只关注返回行，生产请求必须走显式月份/源日期入口。
#[cfg(test)]
pub fn build_usage_result(amount: &AmountResp, cost: &CostResp) -> UsageResult {
    build_usage_result_inner(amount, cost, None)
}

/// 纯聚合：amount/cost 响应 → 界面用量结构。新旧模型名归并、费用口径均在此。
///
/// **缺失不等于零**：费用接口没有返回某模型/日期时，费用为 `None`；计数解析失败时
/// 对应计数为 `None`。两者都不会被静默补成 0，而是产生质量警告，让界面显示「—」。
fn build_usage_result_inner(
    amount: &AmountResp,
    cost: &CostResp,
    period: Option<UsagePeriod>,
) -> UsageResult {
    let cost_total = cost.data.biz_data.first();
    let raw_models = crate::usage_history::raw_models(
        &amount.data.biz_data.total,
        cost_total.map(|c| c.total.as_slice()).unwrap_or(&[]),
    );
    // R15-04：月槽位、月总额和历史共用按原始模型归并后的 presence 口径。
    let monthly_costs = crate::usage::costs_by_model(
        cost_total
            .into_iter()
            .flat_map(|item| &item.total)
            .map(|row| (row.model.as_str(), row.usage.as_slice())),
    );
    let cost_for_model = |model: &str| monthly_costs.get(model).copied().flatten();

    // 按槽位归并：迁移期内 deepseek-flash 与旧名可能同时出现在同一份账单里，
    // 它们其实是同一个模型，必须累加，否则前端只取第一个会漏掉另一部分用量。
    let mut flash_sum: Option<UsageModelSummary> = None;
    let mut pro_sum: Option<UsageModelSummary> = None;
    // 未知模型（如后续上线的 V4.1 Pro）聚合为「其他」兜底行，避免新模型名
    // 接入前其用量「日合计有、模型行无」地静默消失。正式接入仍以 model_slot 为准。
    let mut other_sum: Option<UsageModelSummary> = None;
    // 复评 F05：**先按模型合并 usage 条目，再算 breakdown**。
    //
    // 旧实现逐条计算 `token_breakdown` 再累加：同一模型被平台拆成两条
    //（第一条 `PROMPT_TOKEN=100`，第二条 HIT=20/MISS=80/RESPONSE=10）时，
    // 主面板逐条走「明细为零→PROMPT_TOKEN 兜底」得到 100+110=210，而历史
    // 先按模型合并后只兜底一次、得到 110 —— 两条展示通路自相矛盾。
    // 现在主面板与历史共用同一口径：按模型把 usage 条目合并成一份再解析。
    let mut source: Vec<ModelUsage> = Vec::new();
    let mut merged: std::collections::BTreeMap<&str, Vec<crate::usage::Entry>> =
        std::collections::BTreeMap::new();
    for entry in &amount.data.biz_data.total {
        merged
            .entry(&entry.model)
            .or_default()
            .extend(entry.usage.iter().cloned());
    }
    for (model, usage) in merged {
        source.push(ModelUsage {
            model: model.to_string(),
            usage,
        });
    }
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
    // 只在费用侧出现的模型没有数量数据：计数必须保持未知，不能被空 usage 解析成零。
    let amount_models: std::collections::HashSet<&str> = amount
        .data
        .biz_data
        .total
        .iter()
        .map(|model| model.model.as_str())
        .collect();
    for model_usage in &source {
        let breakdown = if amount_models.contains(model_usage.model.as_str()) {
            token_breakdown(&model_usage.usage)
        } else {
            unknown_breakdown()
        };
        // 同名模型可能重复出现：只有第一条带费用，后续同名条目费用记 0（已计入）。
        let cost = if charged_models.insert(&model_usage.model) {
            cost_for_model(&model_usage.model)
        } else {
            Some(0.0)
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
    // R14-09：平台一旦返回未知模型就保留入口，包括请求非零而 Token/费用
    // 为零、部分未知以及明确全零。没有未知模型时 other_sum 自然为 None。
    models.extend(other_sum);

    // R15-04：先按日期收齐所有片段，再按原始模型合并费用条目。
    // 同日期多个 day 对象与单个对象必须产生相同的日额、raw 和模型额。
    let mut grouped_cost_days: std::collections::BTreeMap<&str, Vec<&ModelUsage>> =
        std::collections::BTreeMap::new();
    if let Some(item) = cost_total {
        for day in &item.days {
            grouped_cost_days
                .entry(&day.date)
                .or_default()
                .extend(&day.data);
        }
    }
    let cost_by_date: std::collections::BTreeMap<String, Option<f64>> = grouped_cost_days
        .into_iter()
        .map(|(date, rows)| {
            let costs = crate::usage::costs_by_model(
                rows.into_iter()
                    .map(|row| (row.model.as_str(), row.usage.as_slice())),
            );
            (
                date.to_owned(),
                crate::usage::cost_total_present(costs.values().copied()),
            )
        })
        .collect();

    let mut days = Vec::new();
    // 复评 N10：**先按 date 合并所有片段**，再派生 summary / raw / 槽位。
    // 旧实现直接 clone 数量侧的 days：平台若对同一天返回多个对象，就会
    // 生成多条同日 summary，而 raw_models 却按整日合并 —— 图表取最后一项
    // （只看到 20）、历史取全日（看到 30），同一份数据出现两个结论。
    let mut merged_days: Vec<DayUsage> = Vec::new();
    let mut day_index: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    for day in &amount.data.biz_data.days {
        match day_index.get(&day.date) {
            Some(&index) => merged_days[index].data.extend(day.data.iter().cloned()),
            None => {
                day_index.insert(day.date.clone(), merged_days.len());
                merged_days.push(DayUsage {
                    date: day.date.clone(),
                    data: day.data.clone(),
                });
            }
        }
    }
    let mut daily_source = merged_days;
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
    // 数量侧是否返回过这一天（复评 F07）：只有费用侧有的日期，计数是「未知」，
    // 不是零用量。空 data 与「平台明确给了 0」必须区分。
    let amount_dates: std::collections::HashSet<&str> = amount
        .data
        .biz_data
        .days
        .iter()
        .map(|day| day.date.as_str())
        .collect();
    for day in &daily_source {
        let count_known = amount_dates.contains(day.date.as_str()) && !day.data.is_empty();
        let zero = || if count_known { Some(0u64) } else { None };
        let mut flash = zero();
        let mut flash_hit = zero();
        let mut flash_miss = zero();
        let mut flash_resp = zero();
        let mut pro = zero();
        let mut pro_hit = zero();
        let mut pro_miss = zero();
        let mut pro_resp = zero();
        let mut total = zero();
        let mut flash_other = zero();
        let mut pro_other = zero();
        // 复评 R10：**先按模型合并当天的 usage 条目，再算一次 breakdown** ——
        // 与月级（F05）和 raw_models 同一口径。旧实现逐片调用
        // `token_breakdown` 再累加：一天里同一模型两行
        //（`PROMPT_TOKEN=100` 与 `HIT=20/MISS=80/RESPONSE=10`）会让首页日总
        // 推导 210，而历史 raw 得 110 —— 同一份数据在两条通路自相矛盾。
        let mut merged_daily: std::collections::BTreeMap<&str, Vec<crate::usage::Entry>> =
            std::collections::BTreeMap::new();
        for model_usage in &day.data {
            merged_daily
                .entry(model_usage.model.as_str())
                .or_default()
                .extend(model_usage.usage.iter().cloned());
        }
        for (model, usage) in merged_daily {
            let breakdown = token_breakdown(&usage);
            total = sum_counts(total, breakdown.total);
            // total 覆盖当天全部模型（含未知模型），槽位分摊只作用于已识别的模型
            if let Some((slot, _)) = model_slot(model) {
                if slot == FLASH_SLOT {
                    flash = sum_counts(flash, breakdown.total);
                    flash_hit = sum_counts(flash_hit, breakdown.cache_hit);
                    flash_miss = sum_counts(flash_miss, breakdown.cache_miss);
                    flash_resp = sum_counts(flash_resp, breakdown.response);
                    flash_other = sum_counts(flash_other, breakdown.other);
                } else {
                    pro = sum_counts(pro, breakdown.total);
                    pro_hit = sum_counts(pro_hit, breakdown.cache_hit);
                    pro_miss = sum_counts(pro_miss, breakdown.cache_miss);
                    pro_resp = sum_counts(pro_resp, breakdown.response);
                    pro_other = sum_counts(pro_other, breakdown.other);
                }
            }
        }
        // 复评 N02：逐日比较两侧**实际返回**的模型集合 —— 出现在数组里代表
        // 平台返回了该模型（显式零与未返回是两种语义）。两侧都有这一天的
        // 数据但集合不齐时，缺的那一侧汇总置为未知，不把部分和当完整值
        // 展示；只有一侧返回过这一天时维持既有语义（另一侧本就是未知，
        // 见复评 F07 的 cost-only / amount-only 日）。
        let day_amount_models: std::collections::HashSet<&str> = raw_amount_days
            .get(day.date.as_str())
            .map(|models| {
                models
                    .iter()
                    .map(|model| model.model.as_str())
                    .filter(|model| !model.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let day_cost_models: std::collections::HashSet<&str> = raw_cost_days
            .get(day.date.as_str())
            .map(|models| {
                models
                    .iter()
                    .map(|model| model.model.as_str())
                    .filter(|model| !model.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let both_sides_present = amount_dates.contains(day.date.as_str())
            && raw_cost_days.contains_key(day.date.as_str());
        let cost_side_incomplete = both_sides_present
            && day_amount_models
                .iter()
                .any(|model| !day_cost_models.contains(model));
        let count_side_incomplete = both_sides_present
            && day_cost_models
                .iter()
                .any(|model| !day_amount_models.contains(model));
        // 复评 R07：把缺项按**槽位**传播 —— 费用侧返回、数量侧缺失的模型，
        // 其所在槽位（flash/pro）当日的分段合计也要置为未知；其他槽位不受
        // 牵连。否则模型详情图会把这些分段画成真实 0 或部分和（首页读
        // totalTokens 已由上面的集合比对兜住，详情只读各自分段）。
        let count_missing_slots: std::collections::HashSet<&str> = if both_sides_present {
            day_cost_models
                .iter()
                .filter(|model| !day_amount_models.contains(*model))
                .filter_map(|model| crate::usage::model_slot(model).map(|(slot, _)| slot))
                .collect()
        } else {
            std::collections::HashSet::new()
        };
        let flash_known = !count_missing_slots.contains(crate::usage::FLASH_SLOT);
        let pro_known = !count_missing_slots.contains(crate::usage::PRO_SLOT);
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
            flash_tokens: if flash_known { flash } else { None },
            flash_cache_hit: if flash_known { flash_hit } else { None },
            flash_cache_miss: if flash_known { flash_miss } else { None },
            flash_response: if flash_known { flash_resp } else { None },
            pro_tokens: if pro_known { pro } else { None },
            pro_cache_hit: if pro_known { pro_hit } else { None },
            pro_cache_miss: if pro_known { pro_miss } else { None },
            pro_response: if pro_known { pro_resp } else { None },
            // R26：缺失别名同样使 other 不完整，不能展示已知别名的部分和。
            // 只按来源缺项传播；槽位总量单独溢出时，合法 other 仍须保留。
            flash_other_tokens: if flash_known { flash_other } else { None },
            pro_other_tokens: if pro_known { pro_other } else { None },
            // 缺数量的模型让当日 Token 合计未知；缺费用不污染有效 Tokens。
            total_tokens: if count_side_incomplete { None } else { total },
            // 缺费用的模型让当日费用合计未知，而不是把已知部分表现成完整值。
            total_cost: if cost_side_incomplete || day_cost_models.is_empty() {
                None
            } else {
                cost_by_date.get(&day.date).copied().flatten()
            },
        });
    }

    // 复评 F04：月费用必须与**月级**数量模型集合对齐后再决定是否可用。
    //
    // 旧实现直接对费用月分组 try_fold，于是「数量月汇总有 A/B、费用月汇总只有
    // A=1元」会得到 monthCost=1 —— 余额卡把部分和当完整月金额展示；
    // 而 `total:[]`（有分组但没有任何模型）还会得到 0，与 `biz_data=[]`
    // 的正确 None 不同。这里：
    // 1. 数量侧返回了模型、费用侧缺任何一个 → 整月费用未知（不是部分和）；
    // 2. 有费用分组但 total 为空 → 未知（两侧都空也不是显式零）；
    // 3. 每个数量模型都有显式费用（含显式 0）→ 正常求值（0 是合法值）；
    // 4. 只有日级缺项、月级齐全 → 保持有效月费用（不受日缺项牵连）。
    let amount_month_models: std::collections::HashSet<&str> = amount
        .data
        .biz_data
        .total
        .iter()
        .map(|model| model.model.as_str())
        .filter(|model| !model.is_empty())
        .collect();
    let cost_month_models: std::collections::HashSet<&str> = cost_total
        .map(|item| {
            item.total
                .iter()
                .map(|model| model.model.as_str())
                .filter(|model| !model.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let month_models_aligned = amount_month_models.is_subset(&cost_month_models);
    let month_cost = if month_models_aligned {
        crate::usage::cost_total_present(monthly_costs.values().copied())
    } else {
        None
    };
    let budget_month_cost = if month_models_aligned {
        crate::usage::budget_cost_total(
            cost_total
                .into_iter()
                .flat_map(|item| &item.total)
                .map(|row| (row.model.as_str(), row.usage.as_slice())),
        )
    } else {
        None
    };

    let mut warnings = usage_alignment_warnings(amount, cost, &days, period);
    // R18：模型名对齐不等于月数量完整。先按原始模型收齐全部片段，再检查
    // 关键总 Tokens；空桶/REQUEST-only 不得靠完整日记录绕过预算质量门禁。
    // 缺 REQUEST 或某个可容许的 Token 子字段不影响已有总量，也不是坏值。
    // 只追加质量警告，不清空可靠月费用、日记录或其他模型的有效数量。
    if raw_models.is_empty() || raw_models.iter().any(|model| model.total_tokens.is_none()) {
        warnings.push("本月 Token 总量不完整或不可用，相关数量按未知显示".into());
    }
    if raw_models
        .iter()
        .chain(
            days.iter()
                .filter(|day| period.is_none_or(|scope| scope.includes_day(&day.date)))
                .flat_map(|day| &day.raw_models),
        )
        .any(|model| model.data_warning.is_some())
    {
        warnings.push("平台 Token 计数异常，受影响的历史字段保留为未知".into());
    }
    if month_cost.is_none() {
        warnings.push("费用接口未返回可用的本月费用，费用显示为未知而不是零".into());
    }
    UsageResult {
        schema_version: 2,
        model_mapping_version: "deepseek-slots-v1",
        raw_models,
        warnings,
        models,
        days,
        month_cost,
        budget_month_cost,
    }
}

/// 计数相加：任一未知即未知（缺失不补零）。
fn sum_counts(total: Option<u64>, value: Option<u64>) -> Option<u64> {
    total?
        .checked_add(value?)
        .filter(|value| *value <= crate::usage::MAX_SAFE_COUNT)
}

/// 完全没有数量数据时的明细：所有计数未知，不借空数组伪装成零。
fn unknown_breakdown() -> crate::usage::TokenBreakdown {
    crate::usage::TokenBreakdown {
        total: None,
        request: None,
        cache_hit: None,
        cache_miss: None,
        response: None,
        other: None,
    }
}

/// 双向对齐检查：数量有费用无、费用有数量无、日期两侧不齐，都要能被用户看见。
///
/// 这里只产生**质量警告**，不改变数值：真正的「缺失」语义由 `Option` 承载。
fn usage_alignment_warnings(
    amount: &AmountResp,
    cost: &CostResp,
    days: &[UsageDaySummary],
    period: Option<UsagePeriod>,
) -> Vec<String> {
    let cost_total = cost.data.biz_data.first();
    let amount_models: std::collections::HashSet<&str> = amount
        .data
        .biz_data
        .total
        .iter()
        .map(|model| model.model.as_str())
        .filter(|model| !model.is_empty())
        .collect();
    let cost_models: std::collections::HashSet<&str> = cost_total
        .map(|item| {
            item.total
                .iter()
                .map(|model| model.model.as_str())
                .filter(|model| !model.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let amount_dates: std::collections::HashSet<&str> = amount
        .data
        .biz_data
        .days
        .iter()
        .filter(|day| period.is_none_or(|scope| scope.includes_day(&day.date)))
        .map(|day| day.date.as_str())
        .collect();
    let cost_dates: std::collections::HashSet<&str> = cost_total
        .map(|item| {
            item.days
                .iter()
                .filter(|day| period.is_none_or(|scope| scope.includes_day(&day.date)))
                .map(|day| day.date.as_str())
                .collect()
        })
        .unwrap_or_default();

    // R14-07：同模型允许拆成多行。比较原始模型 ID 的去重集合，不能把
    // 数量原始行数与费用模型数混比，误阻止已对齐数据的预算提醒。
    let models_mismatch = amount_models != cost_models;
    // R19：两端月 total 可以同时漏掉同一个模型，互相比对仍然相等。
    // 从源日范围内两端的原始日记录取得实际业务证据，并要求该原始模型
    // 同时出现在数量和费用月 total；别名/未知模型不能靠显示槽位互相替代。
    // 非零证据逐条判断，因此空/REQUEST 片段、同日拆对象及反序不影响结果；
    // 全零/空桶不证明发生业务，未来日也不能污染当前月覆盖检查。
    // 这里只告警，不从日级补造月模型或以日合计替换平台月额。
    let missing_month_models = amount
        .data
        .biz_data
        .days
        .iter()
        .chain(cost_total.into_iter().flat_map(|item| &item.days))
        .filter(|day| period.is_none_or(|scope| scope.includes_day(&day.date)))
        .flat_map(|day| &day.data)
        .filter(|model| crate::usage::has_recorded_activity(&model.usage))
        .any(|model| {
            !amount_models.contains(model.model.as_str())
                || !cost_models.contains(model.model.as_str())
        });
    // 日期只有一侧存在，或某天算不出费用/数量，都算不齐。
    let dates_mismatch = !amount_dates.is_subset(&cost_dates)
        || !cost_dates.is_subset(&amount_dates)
        || days
            .iter()
            .filter(|day| period.is_none_or(|scope| scope.includes_day(&day.date)))
            .any(|day| day.total_cost.is_none() || day.total_tokens.is_none());
    // 两侧同时缺失的过去/当日也必须被发现。未来空日仍留在结果中为 None，
    // 但不参加当前质量判定；次日新请求会自动扩大应覆盖范围。
    let missing_dates = period.is_some_and(|scope| {
        (0..=(scope.last - scope.first).num_days()).any(|offset| {
            let date = (scope.first + chrono::Duration::days(offset)).to_string();
            !amount_dates.contains(date.as_str()) || !cost_dates.contains(date.as_str())
        })
    });
    let unexpected_dates =
        period.is_some_and(|scope| days.iter().any(|day| !scope.is_query_month(&day.date)));

    let mut warnings = Vec::new();
    if models_mismatch {
        warnings.push("费用与 Token 数据尚未完全对齐，请稍后刷新".into());
    }
    if missing_month_models {
        warnings.push("本月数量或费用汇总缺少已有日用量的原始模型，请稍后刷新核对".into());
    }
    if dates_mismatch || missing_dates {
        warnings.push("部分日期缺少费用或数量，相关数值按未知显示".into());
    }
    if unexpected_dates {
        warnings.push("平台返回无效日期或查询月份以外的数据，请稍后刷新核对".into());
    }
    warnings
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, ApiError> {
    let resp = client
        .get(url)
        .bearer_auth(token)
        .header("x-app-version", "1.0.0")
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|error| ApiError::new(ErrorKind::Unavailable, format!("用量请求失败：{error}")))?;
    match resp.status().as_u16() {
        200 => {}
        code => {
            let kind = status_kind(code);
            let message = match code {
                401 => "用量 Token 无效或已过期，请重新同步用量 Token（设置页）".to_string(),
                403 => "用量接口拒绝访问，请重新同步用量 Token（设置页）".to_string(),
                404 => "用量接口路径可能已变更，可稍后重试或使用手动粘贴 Token".to_string(),
                429 => "请求过于频繁，请稍后再试".to_string(),
                code if code >= 500 => {
                    format!("用量服务暂时不可用（HTTP {code}），余额查询不受影响")
                }
                code => format!("用量接口错误：HTTP {code}，余额查询不受影响"),
            };
            return Err(ApiError::new(kind, message));
        }
    }
    // 复评 N18：同上，用量响应也走有界读取后再解析。
    let body = read_bounded_body(resp, MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| body_error_to_api("读取用量数据失败", error))?;
    serde_json::from_slice::<T>(body.as_bytes()).map_err(|error| {
        ApiError::new(ErrorKind::InvalidData, format!("解析用量数据失败：{error}"))
    })
}

/// 并发拉取 amount/cost 并聚合成界面结构。
pub async fn fetch_usage_with_token(
    token: &str,
    month: u32,
    year: u32,
) -> Result<UsageResult, ApiError> {
    // 在任何网络等待之前固定 UTC+8 源日期，避免跨午夜后把尚未查询到的
    // 新一天纳入旧请求；同一个范围同时用于首页/历史和后台预算。
    let period = UsagePeriod::at(year, month, chrono::Utc::now())
        .map_err(|message| ApiError::new(ErrorKind::InvalidData, message))?;
    let client = http_client().map_err(|error| ApiError::new(ErrorKind::Unavailable, error))?;
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
        return Err(ApiError::new(
            ErrorKind::InvalidData,
            "平台返回多个费用业务分组，暂无法确认统计口径，请保留旧数据并反馈",
        ));
    }
    validate_usage_entries(&amount, &cost)
        .map_err(|message| ApiError::new(ErrorKind::InvalidData, message))?;
    Ok(build_usage_result_for_period(&amount, &cost, period))
}

fn amount_entries(amount: &AmountResp) -> impl Iterator<Item = &Entry> {
    amount
        .data
        .biz_data
        .total
        .iter()
        .chain(amount.data.biz_data.days.iter().flat_map(|d| d.data.iter()))
        .flat_map(|model| model.usage.iter())
}

fn validate_usage_entries(amount: &AmountResp, cost: &CostResp) -> Result<(), String> {
    let cost_entries = cost.data.biz_data.iter().flat_map(|b| {
        b.total
            .iter()
            .chain(b.days.iter().flat_map(|d| d.data.iter()))
            .flat_map(|model| model.usage.iter())
    });
    validate_usage_values(amount_entries(amount).chain(cost_entries))
}

/// 源响应级值域校验，不替代数量整数/presence 或预算十进制质量判断。
/// 保留 R20 的原始尾数负号判定及既有语法/范围，供 Token 探针和用量读取共用。
fn validate_usage_values<'a>(entries: impl Iterator<Item = &'a Entry>) -> Result<(), String> {
    for entry in entries {
        let n = entry
            .amount
            .parse::<f64>()
            .map_err(|_| "平台返回无法解析的用量数值，请稍后重试")?;
        if !n.is_finite()
            || n < 0.0
            || n >= u64::MAX as f64
            || crate::usage::is_negative_amount(&entry.amount)
        {
            return Err("平台返回超出范围的用量数值，请稍后重试".into());
        }
    }
    Ok(())
}

/// 合成响应供数据和预算回归共同使用，不访问平台或实际账户。
#[cfg(test)]
pub(crate) mod regression_samples {
    use super::*;

    /// 探针与读取测试共用原始 JSON，确保覆盖生产反序列化而不只手工组装结构体。
    pub(crate) fn amount_body(value: &str, daily: bool) -> String {
        let model = serde_json::json!({
            "model": "deepseek-flash",
            "usage": [
                { "type": "RESPONSE_TOKEN", "amount": "1" },
                { "type": "RESPONSE_TOKEN", "amount": value },
                { "type": "REQUEST", "amount": "1" }
            ]
        });
        let (total, days) = if daily {
            (
                serde_json::json!([]),
                serde_json::json!([{ "date": "2026-11-01", "data": [model] }]),
            )
        } else {
            (serde_json::json!([model]), serde_json::json!([]))
        };
        serde_json::json!({ "data": { "biz_data": { "total": total, "days": days } } }).to_string()
    }

    /// 与生产请求相同的数值验证 → 日期范围聚合链路，不发网络请求。
    pub(crate) fn checked_result(
        amount: &AmountResp,
        cost: &CostResp,
        period: UsagePeriod,
    ) -> UsageResult {
        validate_usage_entries(amount, cost).expect("合成响应应通过生产数值入口");
        build_usage_result_for_period(amount, cost, period)
    }

    pub(crate) fn missing_month_token_rows() -> Vec<Vec<ModelUsage>> {
        vec![
            vec![],
            vec![row("deepseek-flash", &[])],
            vec![row("deepseek-flash", &[]), row("deepseek-flash", &[])],
            vec![row("deepseek-flash", &[("REQUEST", "0")])],
            vec![row("deepseek-flash", &[("REQUEST", "1")])],
        ]
    }

    pub(crate) fn row(model: &str, entries: &[(&str, &str)]) -> ModelUsage {
        ModelUsage {
            model: model.into(),
            usage: entries
                .iter()
                .map(|(kind, value)| Entry {
                    kind: (*kind).into(),
                    amount: (*value).into(),
                })
                .collect(),
        }
    }

    /// 同一合成日记录可原样加入，也可拆成空片段和逆序的单字段 day 对象。
    pub(crate) fn append_daily_model(
        days: &mut Vec<DayUsage>,
        date: &str,
        model: &str,
        entries: &[(&str, &str)],
        split: bool,
    ) {
        if split {
            days.push(DayUsage {
                date: date.into(),
                data: vec![row(model, &[])],
            });
            for entry in entries.iter().rev() {
                days.push(DayUsage {
                    date: date.into(),
                    data: vec![row(model, &[*entry])],
                });
            }
        } else if let Some(day) = days.iter_mut().find(|day| day.date == date) {
            day.data.push(row(model, entries));
        } else {
            days.push(DayUsage {
                date: date.into(),
                data: vec![row(model, entries)],
            });
        }
    }

    /// 月额120，最后一天120，之前每天明确零；数量/费用两侧完整且对齐。
    pub(crate) fn complete_month(year: u32, month: u32, days: u32) -> (AmountResp, CostResp) {
        let counts = vec![row(
            "deepseek-flash",
            &[
                ("PROMPT_CACHE_HIT_TOKEN", "10"),
                ("PROMPT_CACHE_MISS_TOKEN", "20"),
                ("RESPONSE_TOKEN", "5"),
                ("REQUEST", "1"),
            ],
        )];
        let zero_counts = vec![row(
            "deepseek-flash",
            &[
                ("PROMPT_CACHE_HIT_TOKEN", "0"),
                ("PROMPT_CACHE_MISS_TOKEN", "0"),
                ("RESPONSE_TOKEN", "0"),
                ("REQUEST", "0"),
            ],
        )];
        let costs = vec![row(
            "deepseek-flash",
            &[("REQUEST", "1"), ("RESPONSE_TOKEN", "120")],
        )];
        let zero_costs = vec![row("deepseek-flash", &[("RESPONSE_TOKEN", "0")])];
        let amount = AmountResp {
            data: AmountData {
                biz_data: AmountBiz {
                    total: counts.clone(),
                    days: (1..=days)
                        .map(|day| DayUsage {
                            date: format!("{year:04}-{month:02}-{day:02}"),
                            data: if day == days {
                                counts.clone()
                            } else {
                                zero_counts.clone()
                            },
                        })
                        .collect(),
                },
            },
        };
        let cost = CostResp {
            data: CostData {
                biz_data: vec![CostBiz {
                    total: costs.clone(),
                    days: (1..=days)
                        .map(|day| DayUsage {
                            date: format!("{year:04}-{month:02}-{day:02}"),
                            data: if day == days {
                                costs.clone()
                            } else {
                                zero_costs.clone()
                            },
                        })
                        .collect(),
                }],
            },
        };
        (amount, cost)
    }

    pub(crate) fn period(year: u32, month: u32, instant: &str) -> UsagePeriod {
        UsagePeriod::at(
            year,
            month,
            instant.parse::<chrono::DateTime<chrono::Utc>>().unwrap(),
        )
        .unwrap()
    }
}

#[cfg(test)]
// 测试名用中文描述被测行为，是项目既有约定；改成拼音或英文会丢掉可读性。
// 仅放宽这一个 lint。
#[allow(non_snake_case)]
mod tests {
    use super::regression_samples::{
        amount_body, append_daily_model, checked_result, complete_month, missing_month_token_rows,
        period, row,
    };
    use super::*;

    const MONTH_COVERAGE_WARNING: &str =
        "本月数量或费用汇总缺少已有日用量的原始模型，请稍后刷新核对";

    #[test]
    fn r21_探针与用量读取拒绝同一数值_覆盖月汇总和日明细() {
        for raw in [
            "",
            "invalid",
            "NaN",
            "inf",
            "-inf",
            "-1",
            "-1e-400",
            "-0.0001e-400",
            "-1E-400",
            "1e40",
            "18446744073709551615",
            " 1",
            "1 ",
        ] {
            for daily in [false, true] {
                let body = amount_body(raw, daily);
                let amount: AmountResp = serde_json::from_str(&body).unwrap();
                assert_eq!(
                    verify_usage_body(&body),
                    Err(VerifyFailure::Transient),
                    "响应坏值不能证明凭据失效：{raw}，daily={daily}"
                );
                assert!(
                    validate_usage_entries(&amount, &cost_sample()).is_err(),
                    "读取必须拒绝同一坏值：{raw}，daily={daily}"
                );
            }
        }
    }

    #[test]
    fn r21_探针保留负零科学计数法与源数值合法但计数未知的语义() {
        for raw in [
            "0",
            "-0",
            "-0.0",
            "-0e-400",
            "-0.00E+400",
            "100.0",
            "1e3",
            "1E+3",
            "+1.5",
            "0.25",
            "1e-400",
            "9007199254740992",
        ] {
            for daily in [false, true] {
                let body = amount_body(raw, daily);
                let amount: AmountResp = serde_json::from_str(&body).unwrap();
                assert_eq!(verify_usage_body(&body), Ok(()), "{raw}，daily={daily}");
                assert!(
                    validate_usage_entries(&amount, &cost_sample()).is_ok(),
                    "{raw}，daily={daily}"
                );
            }
        }
        // 探针不是计数质量门禁：科学计数法/小数等仍由后续 count/presence 显示未知。
        assert_eq!(crate::usage::count("1e3"), None);
        assert_eq!(crate::usage::count("0.25"), None);
        assert_eq!(crate::usage::count("1e-400"), None);
    }

    #[test]
    fn r21_探针保留空业务成功但拒绝缺失结构() {
        for body in [
            r#"{"data":{"biz_data":{"total":[],"days":[]}}}"#,
            r#"{"data":{"biz_data":{"total":[{"model":"deepseek-flash","usage":[]}],"days":[]}}}"#,
            r#"{"data":{"biz_data":{"total":[{"model":"deepseek-flash","usage":[{"type":"REQUEST","amount":"0"}]}],"days":[]}}}"#,
        ] {
            assert_eq!(verify_usage_body(body), Ok(()), "{body}");
        }
        for body in [
            "not-json",
            "{}",
            r#"{"data":{"biz_data":{}}}"#,
            r#"{"data":{"biz_data":{"total":[],"days":null}}}"#,
            r#"{"data":{"biz_data":{"total":[{"model":"deepseek-flash","usage":[{"type":"REQUEST","amount":0}]}],"days":[]}}}"#,
        ] {
            assert_eq!(verify_usage_body(body), Err(VerifyFailure::Transient));
        }
    }

    #[test]
    fn r20_十进制预算不放宽生产数值入口_非法费用仍拒绝() {
        for raw in ["", "invalid", "NaN", "inf", "-1", "-1e-400", "1e40"] {
            let (amount, mut cost) = complete_month(2026, 11, 1);
            cost.data.biz_data[0]
                .total
                .push(row("deepseek-flash", &[("RESPONSE_TOKEN", raw)]));
            assert!(validate_usage_entries(&amount, &cost).is_err(), "{raw}");
            let (amount, mut cost) = complete_month(2026, 11, 1);
            cost.data.biz_data[0].days[0]
                .data
                .push(row("deepseek-flash", &[("RESPONSE_TOKEN", raw)]));
            assert!(
                validate_usage_entries(&amount, &cost).is_err(),
                "日费用同样拒绝：{raw}"
            );
        }
    }

    #[test]
    fn r19_双方月汇总共同漏日模型仍告警_保留原月额与日明细() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for model in ["deepseek-v4-flash", "deepseek-v4-pro", "future-model"] {
            for date in ["2026-11-01", "2026-11-10"] {
                for split in [false, true] {
                    let (mut amount, mut cost) = complete_month(2026, 11, 10);
                    append_daily_model(
                        &mut amount.data.biz_data.days,
                        date,
                        model,
                        &[("REQUEST", "1"), ("RESPONSE_TOKEN", "7")],
                        split,
                    );
                    append_daily_model(
                        &mut cost.data.biz_data[0].days,
                        date,
                        model,
                        &[("REQUEST", "1"), ("RESPONSE_TOKEN", "9")],
                        split,
                    );
                    let result = checked_result(&amount, &cost, scope);
                    assert_eq!(result.warnings, vec![MONTH_COVERAGE_WARNING.to_owned()]);
                    assert_eq!(result.month_cost, Some(120.0), "不得改成日合计129");
                    assert_eq!(result.raw_models.len(), 1, "不得从日级补造月模型");
                    assert_eq!(result.raw_models[0].model, "deepseek-flash");
                    assert_eq!(result.raw_models[0].total_tokens, Some(35));
                    assert_eq!(result.raw_models[0].cost, Some(120.0));
                    assert_eq!(result.days.len(), 10, "同日片段只形成一条摘要");
                    let day = result.days.iter().find(|day| day.date == date).unwrap();
                    let is_last = date == "2026-11-10";
                    assert_eq!(day.total_tokens, Some(if is_last { 42 } else { 7 }));
                    assert_eq!(day.total_cost, Some(if is_last { 129.0 } else { 9.0 }));
                    let raw = day
                        .raw_models
                        .iter()
                        .find(|raw| raw.model == model)
                        .unwrap();
                    assert_eq!(raw.total_tokens, Some(7));
                    assert_eq!(raw.request_count, Some(1));
                    assert_eq!(raw.cost, Some(9.0));
                }
            }
        }
    }

    #[test]
    fn r19_日实际证据含免费请求与小额费用_不依赖Token或金额非零() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        let cases = [
            (
                vec![("REQUEST", "1"), ("RESPONSE_TOKEN", "0")],
                vec![("RESPONSE_TOKEN", "0")],
            ),
            (
                vec![("RESPONSE_TOKEN", "0")],
                vec![("REQUEST", "1"), ("RESPONSE_TOKEN", "0")],
            ),
            (vec![("REQUEST", "1")], vec![("RESPONSE_TOKEN", "0")]),
            (vec![("RESPONSE_TOKEN", "0")], vec![("REQUEST", "1")]),
            (
                vec![("RESPONSE_TOKEN", "0")],
                vec![("RESPONSE_TOKEN", "0.125")],
            ),
            (vec![("FUTURE_TOKEN", "7")], vec![("RESPONSE_TOKEN", "0")]),
        ];
        for (counts, costs) in cases {
            for split in [false, true] {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                append_daily_model(
                    &mut amount.data.biz_data.days,
                    "2026-11-10",
                    "future-model",
                    &counts,
                    split,
                );
                append_daily_model(
                    &mut cost.data.biz_data[0].days,
                    "2026-11-10",
                    "future-model",
                    &costs,
                    split,
                );
                let result = checked_result(&amount, &cost, scope);
                assert!(result
                    .warnings
                    .iter()
                    .any(|warning| warning == MONTH_COVERAGE_WARNING));
                assert_eq!(result.month_cost, Some(120.0));
                let raw = result.days[9]
                    .raw_models
                    .iter()
                    .find(|raw| raw.model == "future-model")
                    .unwrap();
                assert_eq!(
                    raw.total_tokens,
                    token_breakdown(&row("unused", &counts).usage).total
                );
                assert_eq!(
                    raw.cost,
                    crate::usage::cost_sum_present(&row("unused", &costs).usage)
                );
            }
        }
    }

    #[test]
    fn r19_日全零模型无需月覆盖_空桶缺项仍沿用原质量规则() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for entries in [
            vec![("RESPONSE_TOKEN", "0")],
            vec![("REQUEST", "0"), ("FUTURE_TOKEN", "0")],
            vec![],
            vec![("REQUEST", "0")],
        ] {
            for split in [false, true] {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                append_daily_model(
                    &mut amount.data.biz_data.days,
                    "2026-11-10",
                    "unused-model",
                    &entries,
                    split,
                );
                append_daily_model(
                    &mut cost.data.biz_data[0].days,
                    "2026-11-10",
                    "unused-model",
                    &entries,
                    split,
                );
                let result = checked_result(&amount, &cost, scope);
                assert!(!result
                    .warnings
                    .iter()
                    .any(|warning| warning == MONTH_COVERAGE_WARNING));
                assert_eq!(result.month_cost, Some(120.0));
                let explicit_zero = entries.iter().any(|(kind, _)| *kind != "REQUEST");
                assert_eq!(
                    result.warnings.is_empty(),
                    explicit_zero,
                    "无业务证据不等于缺项已修好"
                );
                assert_eq!(result.days[9].total_cost, explicit_zero.then_some(120.0));
                assert_eq!(result.days[9].total_tokens, explicit_zero.then_some(35));
            }
        }
    }

    #[test]
    fn r19_月覆盖按固定源日检查_未来与非法日期不混入实际模型集合() {
        for date in ["2026-11-11", "2026-10-31", "2026-12-01", "bad-date"] {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            append_daily_model(
                &mut amount.data.biz_data.days,
                date,
                "future-model",
                &[("RESPONSE_TOKEN", "7")],
                true,
            );
            append_daily_model(
                &mut cost.data.biz_data[0].days,
                date,
                "future-model",
                &[("RESPONSE_TOKEN", "9")],
                true,
            );
            let before = period(2026, 11, "2026-11-10T15:59:59Z");
            let result = checked_result(&amount, &cost, before);
            assert!(!result
                .warnings
                .iter()
                .any(|warning| warning == MONTH_COVERAGE_WARNING));
            assert_eq!(result.warnings.is_empty(), date == "2026-11-11");
            assert_eq!(
                result
                    .days
                    .iter()
                    .find(|day| day.date == date)
                    .unwrap()
                    .total_cost,
                Some(9.0)
            );
            if date == "2026-11-11" {
                let after = period(2026, 11, "2026-11-10T16:00:00Z");
                assert_eq!(
                    checked_result(&amount, &cost, after).warnings,
                    vec![MONTH_COVERAGE_WARNING.to_owned()]
                );
                assert!(
                    checked_result(&amount, &cost, before).warnings.is_empty(),
                    "旧请求范围固定"
                );
            }
        }
        let (mut amount, mut cost) = complete_month(2026, 10, 31);
        append_daily_model(
            &mut amount.data.biz_data.days,
            "2026-10-31",
            "future-model",
            &[("RESPONSE_TOKEN", "7")],
            false,
        );
        append_daily_model(
            &mut cost.data.biz_data[0].days,
            "2026-10-31",
            "future-model",
            &[("RESPONSE_TOKEN", "9")],
            false,
        );
        assert_eq!(
            checked_result(&amount, &cost, period(2026, 10, "2026-11-10T04:00:00Z")).warnings,
            vec![MONTH_COVERAGE_WARNING.to_owned()]
        );
    }

    #[test]
    fn r19_实际日模型须双方月覆盖_恢复拆片保留PROMPT口径() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for model in ["deepseek-v4-flash", "future-model"] {
            for (amount_present, cost_present) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                let counts = [
                    ("PROMPT_TOKEN", "30"),
                    ("PROMPT_CACHE_HIT_TOKEN", "10"),
                    ("PROMPT_CACHE_MISS_TOKEN", "20"),
                    ("RESPONSE_TOKEN", "5"),
                    ("REQUEST", "1"),
                ];
                let costs = [("REQUEST", "1"), ("RESPONSE_TOKEN", "9")];
                append_daily_model(
                    &mut amount.data.biz_data.days,
                    "2026-11-10",
                    model,
                    &counts,
                    true,
                );
                append_daily_model(
                    &mut cost.data.biz_data[0].days,
                    "2026-11-10",
                    model,
                    &costs,
                    true,
                );
                if amount_present {
                    amount.data.biz_data.total.push(row(model, &[]));
                    amount
                        .data
                        .biz_data
                        .total
                        .extend(counts.iter().rev().map(|entry| row(model, &[*entry])));
                }
                if cost_present {
                    cost.data.biz_data[0].total.push(row(model, &[]));
                    cost.data.biz_data[0]
                        .total
                        .extend(costs.iter().rev().map(|entry| row(model, &[*entry])));
                }
                let result = checked_result(&amount, &cost, scope);
                assert_eq!(
                    result
                        .warnings
                        .iter()
                        .any(|warning| warning == MONTH_COVERAGE_WARNING),
                    !(amount_present && cost_present)
                );
                assert_eq!(
                    result.month_cost,
                    if cost_present {
                        Some(129.0)
                    } else if amount_present {
                        None
                    } else {
                        Some(120.0)
                    }
                );
                assert_eq!(
                    result.days[9].total_tokens,
                    Some(70),
                    "PROMPT不与缓存明细重复计数"
                );
                assert_eq!(result.days[9].total_cost, Some(129.0));
                if amount_present && cost_present {
                    assert!(result.warnings.is_empty());
                    let raw = result
                        .raw_models
                        .iter()
                        .find(|raw| raw.model == model)
                        .unwrap();
                    assert_eq!(raw.total_tokens, Some(35));
                    assert_eq!(raw.cost, Some(9.0));
                }
            }
        }
    }

    #[test]
    fn r18_月数量空桶与仅REQUEST产生完整性警告_保留月费与完整日数据() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for rows in missing_month_token_rows() {
            let (mut amount, cost) = complete_month(2026, 11, 10);
            amount.data.biz_data.total = rows;
            let result = checked_result(&amount, &cost, scope);
            assert_eq!(result.month_cost, Some(120.0));
            assert_eq!(result.models[0].total_tokens, None);
            assert_eq!(result.models[0].cost, Some(120.0));
            assert_eq!(result.raw_models[0].total_tokens, None);
            assert_eq!(result.raw_models[0].cost, Some(120.0));
            assert!(
                result.raw_models[0].data_warning.is_none(),
                "缺失不伪装坏值"
            );
            assert!(result
                .warnings
                .iter()
                .any(|warning| warning.contains("本月 Token 总量")));
            assert!(!result
                .warnings
                .iter()
                .any(|warning| warning.contains("计数异常")));
            assert_eq!(result.days.len(), 10);
            assert!(result
                .days
                .iter()
                .all(|day| day.total_tokens.is_some() && day.total_cost.is_some()));
            assert_eq!(result.days[9].total_tokens, Some(35));
            assert_eq!(result.days[9].total_cost, Some(120.0));
            assert_eq!(result.days[9].raw_models[0].total_tokens, Some(35));
        }
    }

    #[test]
    fn r18_月数量真零与合法稀疏明细不被泛化为缺失() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for (entries, total) in [
            (vec![("RESPONSE_TOKEN", "0")], 0),
            (vec![("RESPONSE_TOKEN", "35")], 35),
            (vec![("PROMPT_TOKEN", "35")], 35),
            (vec![("PROMPT_TOKEN", "30"), ("RESPONSE_TOKEN", "5")], 35),
            (
                vec![("PROMPT_CACHE_HIT_TOKEN", "10"), ("RESPONSE_TOKEN", "5")],
                15,
            ),
            (
                vec![("PROMPT_CACHE_MISS_TOKEN", "20"), ("RESPONSE_TOKEN", "5")],
                25,
            ),
        ] {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            amount.data.biz_data.total = vec![row("deepseek-flash", &entries)];
            amount.data.biz_data.days[9].data = amount.data.biz_data.total.clone();
            if total == 0 {
                cost.data.biz_data[0].total = cost.data.biz_data[0].days[0].data.clone();
                cost.data.biz_data[0].days[9].data = cost.data.biz_data[0].total.clone();
            }
            let result = checked_result(&amount, &cost, scope);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert_eq!(
                result.month_cost,
                Some(if total == 0 { 0.0 } else { 120.0 })
            );
            assert_eq!(result.models[0].total_tokens, Some(total));
            assert_eq!(result.models[0].request_count, None);
            assert_eq!(result.raw_models[0].total_tokens, Some(total));
            assert!(result.raw_models[0].data_warning.is_none());
            assert_eq!(result.days[9].total_tokens, Some(total));
        }
    }

    #[test]
    fn r18_同原始模型空片段与REQUEST片段不掩盖有效月总量() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for tokens in ["35", "0"] {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            amount.data.biz_data.total = vec![row(
                "deepseek-flash",
                &[("REQUEST", "1"), ("RESPONSE_TOKEN", tokens)],
            )];
            amount.data.biz_data.days[9].data = amount.data.biz_data.total.clone();
            if tokens == "0" {
                cost.data.biz_data[0].total = cost.data.biz_data[0].days[0].data.clone();
                cost.data.biz_data[0].days[9].data = cost.data.biz_data[0].total.clone();
            }
            let single = checked_result(&amount, &cost, scope);
            assert!(single.warnings.is_empty());
            let expected = serde_json::to_value(single).unwrap();
            let mut rows = vec![
                row("deepseek-flash", &[]),
                row("deepseek-flash", &[("REQUEST", "1")]),
                row("deepseek-flash", &[("RESPONSE_TOKEN", tokens)]),
            ];
            for _ in 0..2 {
                amount.data.biz_data.total = rows.clone();
                let split = checked_result(&amount, &cost, scope);
                assert_eq!(serde_json::to_value(split).unwrap(), expected);
                rows.reverse();
            }
        }
    }

    #[test]
    fn r18_有效月模型不能掩盖别名或其他模型的总量缺失() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for missing_model in ["deepseek-v4-flash", "deepseek-v4-pro", "future-model"] {
            for entries in [vec![], vec![("REQUEST", "1")]] {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                amount
                    .data
                    .biz_data
                    .total
                    .push(row(missing_model, &entries));
                cost.data.biz_data[0]
                    .total
                    .push(row(missing_model, &[("RESPONSE_TOKEN", "7")]));
                for index in 0..10 {
                    amount.data.biz_data.days[index].data.push(row(
                        missing_model,
                        &[("RESPONSE_TOKEN", if index == 9 { "1" } else { "0" })],
                    ));
                    cost.data.biz_data[0].days[index].data.push(row(
                        missing_model,
                        &[("RESPONSE_TOKEN", if index == 9 { "7" } else { "0" })],
                    ));
                }
                let result = checked_result(&amount, &cost, scope);
                assert_eq!(result.month_cost, Some(127.0));
                assert!(result
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("本月 Token 总量")));
                let valid = result
                    .raw_models
                    .iter()
                    .find(|model| model.model == "deepseek-flash")
                    .unwrap();
                let missing = result
                    .raw_models
                    .iter()
                    .find(|model| model.model == missing_model)
                    .unwrap();
                assert_eq!(valid.total_tokens, Some(35));
                assert_eq!(valid.cost, Some(120.0));
                assert_eq!(missing.total_tokens, None);
                assert_eq!(missing.cost, Some(7.0));
                assert!(missing.data_warning.is_none());
                assert_eq!(
                    result.models[0].total_tokens,
                    (missing_model != "deepseek-v4-flash").then_some(35)
                );
                assert_eq!(result.days[9].total_tokens, Some(36));
                assert_eq!(result.days[9].total_cost, Some(127.0));
            }
        }
    }

    #[test]
    fn r15_01_未来空日不改变当前质量且不伪装零() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for end in [10, 11, 30] {
            for sides in [0, 1, 2] {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                for day in 11..=end {
                    let empty = DayUsage {
                        date: format!("2026-11-{day:02}"),
                        data: vec![],
                    };
                    if sides != 1 {
                        amount.data.biz_data.days.push(empty.clone());
                    }
                    if sides != 0 {
                        cost.data.biz_data[0].days.push(empty);
                    }
                }
                let result = build_usage_result_for_period(&amount, &cost, scope);
                assert!(result.warnings.is_empty(), "{:?}", result.warnings);
                assert_eq!(result.month_cost, Some(120.0));
                assert_eq!(result.days[9].total_cost, Some(120.0));
                for day in result
                    .days
                    .iter()
                    .filter(|day| day.date.as_str() > "2026-11-10")
                {
                    assert_eq!(day.total_cost, None);
                    assert_eq!(day.total_tokens, None);
                    assert!(day.raw_models.is_empty());
                }
            }
        }
    }

    #[test]
    fn r15_01_当前与过去缺日空日和单侧缺失仍然警告() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for day_index in [0, 8, 9] {
            for mode in 0..4 {
                let (mut amount, mut cost) = complete_month(2026, 11, 10);
                match mode {
                    0 => {
                        amount.data.biz_data.days.remove(day_index);
                        cost.data.biz_data[0].days.remove(day_index);
                    }
                    1 => {
                        amount.data.biz_data.days[day_index].data.clear();
                        cost.data.biz_data[0].days[day_index].data.clear();
                    }
                    2 => {
                        cost.data.biz_data[0].days[day_index].data.clear();
                    }
                    _ => {
                        amount.data.biz_data.days[day_index].data.clear();
                    }
                }
                let result = build_usage_result_for_period(&amount, &cost, scope);
                assert!(!result.warnings.is_empty());
                assert_eq!(result.month_cost, Some(120.0), "日缺失不清空可靠月额");
            }
        }
    }

    #[test]
    fn r15_01_跨UTC8午夜旧范围不变_新请求纳入新一天() {
        let (mut amount, mut cost) = complete_month(2026, 11, 10);
        let empty = DayUsage {
            date: "2026-11-11".into(),
            data: vec![],
        };
        amount.data.biz_data.days.push(empty.clone());
        cost.data.biz_data[0].days.push(empty);
        let before = period(2026, 11, "2026-11-10T15:59:59Z");
        let after = period(2026, 11, "2026-11-10T16:00:00Z");
        assert!(build_usage_result_for_period(&amount, &cost, before)
            .warnings
            .is_empty());
        assert!(!build_usage_result_for_period(&amount, &cost, after)
            .warnings
            .is_empty());
        assert!(
            build_usage_result_for_period(&amount, &cost, before)
                .warnings
                .is_empty(),
            "旧请求不重读时钟"
        );
    }

    #[test]
    fn r15_01_历史月检查到月末_闰年与UTC8月界独立() {
        for (year, month, days, instant) in [
            (2026, 10, 31, "2026-10-31T15:59:59Z"),
            (2026, 10, 31, "2026-10-31T16:00:00Z"),
            (2026, 10, 31, "2026-11-10T04:00:00Z"),
            (2028, 2, 29, "2028-03-01T04:00:00Z"),
        ] {
            let (mut amount, mut cost) = complete_month(year, month, days);
            let scope = period(year, month, instant);
            assert!(build_usage_result_for_period(&amount, &cost, scope)
                .warnings
                .is_empty());
            amount.data.biz_data.days.pop();
            cost.data.biz_data[0].days.pop();
            assert!(!build_usage_result_for_period(&amount, &cost, scope)
                .warnings
                .is_empty());
        }
        assert!(UsagePeriod::at(2026, 12, "2026-11-10T04:00:00Z".parse().unwrap()).is_err());
        assert!(UsagePeriod::at(2026, 13, "2026-11-10T04:00:00Z".parse().unwrap()).is_err());
    }

    #[test]
    fn r15_01_未来原始字段警告只在纳入范围后出现_坏日期仍拒绝() {
        let (mut amount, mut cost) = complete_month(2026, 11, 10);
        amount.data.biz_data.days.push(DayUsage {
            date: "2026-11-11".into(),
            data: vec![row("deepseek-flash", &[("RESPONSE_TOKEN", "1.5")])],
        });
        cost.data.biz_data[0].days.push(DayUsage {
            date: "2026-11-11".into(),
            data: vec![row("deepseek-flash", &[("RESPONSE_TOKEN", "0")])],
        });
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        let result = build_usage_result_for_period(&amount, &cost, scope);
        assert!(result.warnings.is_empty());
        assert!(
            result.days[10].raw_models[0].data_warning.is_some(),
            "原始证据仍保留"
        );
        assert!(!build_usage_result_for_period(
            &amount,
            &cost,
            period(2026, 11, "2026-11-11T04:00:00Z")
        )
        .warnings
        .is_empty());
        for date in [
            "2026-10-31",
            "2026-12-01",
            "2026-11-31",
            "2026-11-1",
            "bad-date",
        ] {
            amount.data.biz_data.days[10].date = date.into();
            cost.data.biz_data[0].days[10].date = date.into();
            assert!(
                !build_usage_result_for_period(&amount, &cost, scope)
                    .warnings
                    .is_empty(),
                "{date}"
            );
        }
    }

    #[test]
    fn r15_03_双空月汇总未知_日历史有效金额与显式零保留() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for zero_day in [false, true] {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            amount.data.biz_data.total.clear();
            cost.data.biz_data[0].total.clear();
            if zero_day {
                cost.data.biz_data[0].days[9].data =
                    vec![row("deepseek-flash", &[("RESPONSE_TOKEN", "0")])];
            }
            let result = build_usage_result_for_period(&amount, &cost, scope);
            assert_eq!(result.month_cost, None);
            assert!(!result.warnings.is_empty());
            assert!(result.raw_models.is_empty());
            let expected = Some(if zero_day { 0.0 } else { 120.0 });
            assert_eq!(result.days[9].total_cost, expected);
            assert_eq!(result.days[9].raw_models[0].cost, expected);
        }
        let (mut amount, mut cost) = complete_month(2026, 11, 10);
        amount.data.biz_data.total = amount.data.biz_data.days[0].data.clone();
        amount.data.biz_data.days[9].data = amount.data.biz_data.total.clone();
        cost.data.biz_data[0].total = cost.data.biz_data[0].days[0].data.clone();
        cost.data.biz_data[0].days[9].data = cost.data.biz_data[0].total.clone();
        let result = build_usage_result_for_period(&amount, &cost, scope);
        assert_eq!(result.month_cost, Some(0.0));
        assert!(result.warnings.is_empty());
        assert_eq!(result.days[9].total_cost, Some(0.0));
    }

    #[test]
    fn r15_04_费用单行拆行反序与拆day等价_数量PROMPT不重计() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for mode in 0..4 {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            amount
                .data
                .biz_data
                .total
                .push(row("deepseek-flash", &[("PROMPT_TOKEN", "30")]));
            amount.data.biz_data.days[9]
                .data
                .push(row("deepseek-flash", &[("PROMPT_TOKEN", "30")]));
            let mut fragments = vec![
                row("deepseek-flash", &[("REQUEST", "1")]),
                row("deepseek-flash", &[("RESPONSE_TOKEN", "120")]),
                row("deepseek-flash", &[]),
            ];
            if mode >= 2 {
                fragments.reverse();
            }
            if mode != 0 {
                cost.data.biz_data[0].total = fragments.clone();
                cost.data.biz_data[0].days[9].data = fragments.clone();
            }
            if mode == 3 {
                cost.data.biz_data[0].days.pop();
                cost.data.biz_data[0]
                    .days
                    .extend(fragments.into_iter().map(|row| DayUsage {
                        date: "2026-11-10".into(),
                        data: vec![row],
                    }));
            }
            let result = build_usage_result_for_period(&amount, &cost, scope);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert_eq!(result.month_cost, Some(120.0));
            assert_eq!(result.models[0].cost, Some(120.0));
            assert_eq!(result.models[0].total_tokens, Some(35));
            assert_eq!(result.days.len(), 10);
            assert_eq!(result.days[9].total_cost, Some(120.0));
            assert_eq!(result.days[9].total_tokens, Some(35));
            for raw in [&result.raw_models[0], &result.days[9].raw_models[0]] {
                assert_eq!(raw.cost, Some(120.0));
                assert_eq!(raw.total_tokens, Some(35));
                assert_eq!(raw.model, "deepseek-flash");
            }
        }
    }

    #[test]
    fn r15_04_整个模型无金额或真实金额非法仍未知_别名不互相掩盖() {
        let scope = period(2026, 11, "2026-11-10T04:00:00Z");
        for entries in [
            vec![],
            vec![("REQUEST", "1")],
            vec![("RESPONSE_TOKEN", "NaN")],
            vec![("RESPONSE_TOKEN", "-1")],
            vec![("RESPONSE_TOKEN", "")],
        ] {
            let (mut amount, mut cost) = complete_month(2026, 11, 10);
            let fragments = vec![row("deepseek-flash", &[]), row("deepseek-flash", &entries)];
            cost.data.biz_data[0].total = fragments.clone();
            cost.data.biz_data[0].days[9].data = fragments;
            let result = build_usage_result_for_period(&amount, &cost, scope);
            assert_eq!(result.month_cost, None);
            assert_eq!(result.models[0].cost, None);
            assert_eq!(result.days[9].total_cost, None);
            assert_eq!(result.raw_models[0].cost, None);
            assert_eq!(result.days[9].raw_models[0].cost, None);
            // 另一个原始别名缺费时，Flash 槽位和月/日不能只输出已知的120。
            cost.data.biz_data[0].total = vec![
                row("deepseek-flash", &[("RESPONSE_TOKEN", "120")]),
                row("deepseek-v4-flash", &entries),
            ];
            cost.data.biz_data[0].days[9].data = cost.data.biz_data[0].total.clone();
            amount
                .data
                .biz_data
                .total
                .push(row("deepseek-v4-flash", &[("RESPONSE_TOKEN", "1")]));
            amount.data.biz_data.days[9]
                .data
                .push(row("deepseek-v4-flash", &[("RESPONSE_TOKEN", "1")]));
            let result = build_usage_result_for_period(&amount, &cost, scope);
            assert_eq!(result.month_cost, None);
            assert_eq!(result.models[0].cost, None);
            assert_eq!(result.days[9].total_cost, None);
            assert_eq!(result.raw_models[0].cost, Some(120.0));
            assert_eq!(result.raw_models[1].cost, None);
        }
    }

    /// 同一合成响应同时经过月槽位、日汇总和原始模型三条展示路径。
    fn r14_response(amount_rows: serde_json::Value, cost_rows: serde_json::Value) -> UsageResult {
        let amount: AmountResp = serde_json::from_value(serde_json::json!({
            "data": {"biz_data": {
                "total": amount_rows.clone(),
                "days": [{"date": "2026-11-10", "data": amount_rows}]
            }}
        }))
        .unwrap();
        let cost: CostResp = serde_json::from_value(serde_json::json!({
            "data": {"biz_data": [{
                "total": cost_rows.clone(),
                "days": [{"date": "2026-11-10", "data": cost_rows}]
            }]}
        }))
        .unwrap();
        build_usage_result(&amount, &cost)
    }

    #[test]
    fn r14_06_空data日不是显式零_有原始零记录才是零() {
        let missing = r14_response(serde_json::json!([]), serde_json::json!([]));
        let day = &missing.days[0];
        assert!(day.raw_models.is_empty());
        assert_eq!(day.total_tokens, None);
        assert_eq!(day.total_cost, None);
        assert_eq!(day.flash_cache_hit, None);
        let zero = r14_response(
            serde_json::json!([{"model":"deepseek-flash","usage":[
                {"type":"REQUEST","amount":"0"},
                {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"0"},
                {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"0"},
                {"type":"RESPONSE_TOKEN","amount":"0"}
            ]}]),
            serde_json::json!([{"model":"deepseek-flash","usage":[
                {"type":"RESPONSE_TOKEN","amount":"0"}
            ]}]),
        );
        let day = &zero.days[0];
        assert_eq!(day.raw_models.len(), 1);
        assert_eq!(day.total_tokens, Some(0));
        assert_eq!(day.total_cost, Some(0.0));
        assert_eq!(day.flash_cache_hit, Some(0));
        assert!(zero.warnings.is_empty());
    }

    #[test]
    fn r14_08_请求缺失零与非零在月日历史中一致() {
        for (request, expected) in [(None, None), (Some("0"), Some(0)), (Some("2"), Some(2))] {
            let mut entries = vec![serde_json::json!({"type":"RESPONSE_TOKEN","amount":"100"})];
            if let Some(value) = request {
                entries.push(serde_json::json!({"type":"REQUEST","amount":value}));
            }
            let result = r14_response(
                serde_json::json!([{"model":"deepseek-flash","usage":entries}]),
                serde_json::json!([{"model":"deepseek-flash","usage":[
                    {"type":"RESPONSE_TOKEN","amount":"1"}
                ]}]),
            );
            assert_eq!(result.models[0].request_count, expected);
            assert_eq!(result.models[0].cache_hit_tokens, None);
            assert_eq!(result.models[0].cache_miss_tokens, None);
            assert_eq!(result.models[0].response_tokens, Some(100));
            assert_eq!(result.models[0].total_tokens, Some(100));
            assert_eq!(result.days[0].flash_response, Some(100));
            assert_eq!(result.days[0].flash_cache_hit, None);
            assert_eq!(result.days[0].flash_cache_miss, None);
            for raw in [&result.raw_models[0], &result.days[0].raw_models[0]] {
                assert_eq!(raw.request_count, expected);
                assert_eq!(raw.response_tokens, Some(100));
                assert_eq!(raw.cache_hit_tokens, None);
                assert_eq!(raw.cache_miss_tokens, None);
                assert_eq!(raw.cost, Some(1.0));
                assert!(raw.data_warning.is_none(), "缺字段不是非法数值");
            }
        }
    }

    #[test]
    fn r14_08_别名缺请求或缓存字段不输出部分和() {
        let result = r14_response(
            serde_json::json!([
                {"model":"deepseek-flash","usage":[
                    {"type":"REQUEST","amount":"2"},
                    {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100"},
                    {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"0"},
                    {"type":"RESPONSE_TOKEN","amount":"10"}
                ]},
                {"model":"deepseek-v4-flash","usage":[
                    {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"20"},
                    {"type":"RESPONSE_TOKEN","amount":"5"}
                ]}
            ]),
            serde_json::json!([
                {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"1"}]},
                {"model":"deepseek-v4-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"2"}]}
            ]),
        );
        let slot = &result.models[0];
        assert_eq!(slot.request_count, None);
        assert_eq!(slot.cache_miss_tokens, None);
        assert_eq!(slot.cache_hit_tokens, Some(120));
        assert_eq!(slot.response_tokens, Some(15));
        assert_eq!(slot.total_tokens, Some(135));
        assert_eq!(slot.cost, Some(3.0));
        assert_eq!(result.days[0].flash_cache_miss, None);
        assert_eq!(result.days[0].flash_cache_hit, Some(120));
        for raw in [&result.raw_models, &result.days[0].raw_models] {
            assert_eq!(raw[0].request_count, Some(2));
            assert_eq!(raw[0].cache_miss_tokens, Some(0));
            assert_eq!(raw[1].request_count, None);
            assert_eq!(raw[1].cache_miss_tokens, None);
        }
    }

    #[test]
    fn r14_09_未知模型有请求或未知字段或全零均保留入口() {
        let zero_tokens = serde_json::json!([
            {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"0"},
            {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"0"},
            {"type":"RESPONSE_TOKEN","amount":"0"}
        ]);
        for (request, include_tokens, include_cost) in [
            (Some("2"), true, true),
            (Some("2"), false, true),
            (None, false, false),
            (Some("0"), true, true),
        ] {
            let mut entries = if include_tokens {
                zero_tokens.as_array().unwrap().clone()
            } else {
                vec![]
            };
            if let Some(value) = request {
                entries.push(serde_json::json!({"type":"REQUEST","amount":value}));
            }
            let costs = if include_cost {
                serde_json::json!([{"model":"future-model","usage":[{"type":"RESPONSE_TOKEN","amount":"0"}]}])
            } else {
                serde_json::json!([])
            };
            let result = r14_response(
                serde_json::json!([{"model":"future-model","usage":entries}]),
                costs,
            );
            let other = result
                .models
                .iter()
                .find(|model| model.key == "other")
                .expect("未知模型入口不得被过滤");
            assert_eq!(
                other.request_count,
                request.map(|value| value.parse::<u64>().unwrap())
            );
            assert_eq!(other.total_tokens, include_tokens.then_some(0));
            assert_eq!(other.cost, include_cost.then_some(0.0));
            assert_eq!(result.raw_models[0].model, "future-model");
            assert_eq!(result.days[0].raw_models[0].model, "future-model");
        }
    }

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
        // 费用侧只给了 deepseek-flash；同一槽位的 deepseek-v4-flash 没有费用条目，
        // 因此合并后的槽位费用是「未知」而不是只累加已知部分（复评 F06）。
        let flash = result
            .models
            .iter()
            .find(|model| model.key == "flash")
            .unwrap();
        assert_eq!(flash.cost, None, "部分别名缺费用时槽位费用未知");
        // 复评 F04：费用侧缺了数量侧返回的别名模型 → 月金额未知。
        assert_eq!(result.month_cost, None, "缺项时月金额不可用");
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("尚未完全对齐")));
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
        // 主面板口径与历史一致：同一份小数计数不能出现「面板 0 而历史未知」。
        assert_eq!(result.models[0].response_tokens, None);
        assert_eq!(result.models[0].total_tokens, None);
        assert_eq!(result.days[0].flash_response, None);
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
        assert!((result.days[0].total_cost.unwrap() - 0.05).abs() < 1e-9);
        assert!(!result.warnings.is_empty());
        // 复评 F07：数量侧没有返回这一天，计数必须是未知而不是 0。
        assert_eq!(
            result.days[0].total_tokens, None,
            "只有费用的日期不能被画成零 Token"
        );
        assert_eq!(result.days[0].flash_tokens, None);
        assert_eq!(result.days[0].pro_tokens, None);
    }

    #[test]
    fn 费用侧缺某模型时该模型费用为未知而非零_显式零仍为零() {
        // 复评 F06：费用业务组存在，但只有 Flash，没有 Pro。
        let mut amount = amount_sample();
        amount.data.biz_data.total.push(ModelUsage {
            model: "deepseek-v4-pro".into(),
            usage: vec![Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "11".into(),
            }],
        });
        let result = build_usage_result(&amount, &cost_sample());
        let pro = result
            .models
            .iter()
            .find(|model| model.key == "pro")
            .expect("Pro 行应存在");
        assert_eq!(pro.cost, None, "费用侧没有 Pro 条目时不能显示 ¥0.00");
        assert_eq!(pro.total_tokens, Some(11), "数量侧有效数据仍保留");
        // flash 槽位含 deepseek-flash（有费用）与 deepseek-v4-flash（无费用），
        // 因此槽位费用为未知。复评 F04：费用月分组缺了数量侧返回的模型时，
        // **整月金额**也必须是未知 —— 不能把已返回部分当完整月金额展示。
        assert_eq!(
            result.month_cost, None,
            "费用缺模型时月金额必须是未知，而不是部分和"
        );
        assert!(result.models.iter().all(|model| model.cost.is_none()));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("尚未完全对齐")));
    }

    #[test]
    fn 费用显式为0的模型仍是已知零() {
        // 与 F06 的区别：费用侧确实返回了该模型，金额为 0 —— 这是合法零。
        let mut cost = cost_sample();
        cost.data.biz_data[0].total.push(ModelUsage {
            model: "deepseek-v4-pro".into(),
            usage: vec![Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "0".into(),
            }],
        });
        let mut amount = amount_sample();
        amount.data.biz_data.total.push(ModelUsage {
            model: "deepseek-v4-pro".into(),
            usage: vec![Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "3".into(),
            }],
        });
        let result = build_usage_result(&amount, &cost);
        let pro = result
            .models
            .iter()
            .find(|model| model.key == "pro")
            .unwrap();
        assert_eq!(pro.cost, Some(0.0), "显式零费用必须保留为已知零");
    }

    #[test]
    fn 数量有费用缺时费用为未知而非零_双向都告警() {
        // 费用接口整份缺失：模型/日/月费用全部未知，且必须产生对齐警告。
        let empty_cost: CostResp = serde_json::from_str(r#"{"data":{"biz_data":[]}}"#).unwrap();
        let result = build_usage_result(&amount_sample(), &empty_cost);
        assert_eq!(result.month_cost, None, "缺失费用不能折算成 ¥0.00");
        assert!(result.models.iter().all(|model| model.cost.is_none()));
        assert!(result.days.iter().all(|day| day.total_cost.is_none()));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("费用与 Token 数据尚未完全对齐")));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("本月费用")));
        // 数量本身仍然完整可用。
        assert_eq!(result.models[0].total_tokens, Some(190));

        // 反向：费用接口多出一个数量接口没有的模型 —— 费用保留，数量侧为未知。
        let mut cost = cost_sample();
        cost.data.biz_data[0].total.push(ModelUsage {
            model: "cost-only-model".into(),
            usage: vec![Entry {
                kind: "RESPONSE_TOKEN".into(),
                amount: "0.40".into(),
            }],
        });
        let result = build_usage_result(&amount_sample(), &cost);
        // 复评 F04：费用侧多出模型不影响「数量侧是否都被费用覆盖」，
        // 但本样本费用侧仍缺 deepseek-v4-flash → 月金额未知。
        assert_eq!(
            result.month_cost, None,
            "费用侧未覆盖数量侧全部模型时月金额未知"
        );
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("尚未完全对齐")));
        let extra = result
            .models
            .iter()
            .find(|model| model.key == "other")
            .expect("仅有费用的模型应出现在「其他」行");
        assert_eq!(extra.total_tokens, None, "数量缺失不能补成零");
        assert!((extra.cost.unwrap() - 0.40).abs() < 1e-9);
    }

    #[test]
    fn 单日缺费用只影响该日且不污染月合计() {
        let mut cost = cost_sample();
        cost.data.biz_data[0].days.clear();
        let result = build_usage_result(&amount_sample(), &cost);
        assert_eq!(result.days[0].total_cost, None, "该日费用未知");
        // 复评 F04：只有日级缺项时**月金额**仍必须有效 —— 但本样本的月级
        // 费用侧也缺了数量侧的别名模型，因此按新契约月金额为未知。
        assert_eq!(
            result.month_cost, None,
            "月级模型集合不齐时月金额未知（日级缺项本身不影响月金额）"
        );
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("部分日期缺少费用")));
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

    // ---------- 第五轮复评 N02：日级模型集合对齐 ----------

    #[test]
    fn n02_当日费用缺模型_日费用置未知且数量不受影响() {
        // 月总额两侧对齐（A、B 都有），但 09-01 当日费用侧缺 B：
        // 已知的 ¥1 不得被当作当日完整费用展示（缺 ≠ 零）。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                        {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                    ]},
                    {"date":"2026-09-02","data":[
                        {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"10.0"}]}
                    ]}
                ]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[
                    {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"2.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]}
                    ]},
                    {"date":"2026-09-02","data":[
                        {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"0.0"}]},
                        {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"0.0"}]}
                    ]}
                ]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let day1 = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(day1.total_cost, None, "缺 B 费用时当日费用必须是未知");
        assert!(
            day1.total_tokens.is_some(),
            "数量侧完整时 Tokens 不得被费用缺项污染"
        );
        let day2 = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-02")
            .unwrap();
        assert!(
            day2.total_cost.is_some(),
            "显式 0 表示平台返回了该模型，不算缺失"
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("未知")),
            "日级缺项必须产生可见质量提示：{:?}",
            result.warnings
        );
    }

    #[test]
    fn n02_当日数量缺模型_token置未知费用保留() {
        // 反向：当日费用侧返回 A、B，数量侧只返回 A —— 当日 Token 合计未知，
        // 费用相对自身侧完整、保持可见（缺数量不补零，也不清掉有效费用）。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]}
                    ]}
                ]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[
                    {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"2.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"0.3"}]},
                        {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"0.4"}]}
                    ]}
                ]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let day = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(day.total_tokens, None, "缺 B 的数量时当日 Token 合计未知");
        assert!(
            (day.total_cost.unwrap() - 0.7).abs() < 1e-9,
            "费用侧自身完整时保持可见"
        );
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("未知")));
    }

    // ---------- 复评 R07：槽位级缺项传播 ----------

    #[test]
    fn r07_当日缺pro数量_pro分段置未知_flash不受牵连() {
        // 月总额两侧对齐，09-01 数量侧只有 Flash、费用侧 Flash+Pro：
        // Pro 分段必须是未知，Flash 有完整数量不受牵连。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"deepseek-v4-pro","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]}
                    ]}
                ]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[
                    {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                    {"model":"deepseek-v4-pro","usage":[{"type":"RESPONSE_TOKEN","amount":"2.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                        {"model":"deepseek-v4-pro","usage":[{"type":"RESPONSE_TOKEN","amount":"2.0"}]}
                    ]}
                ]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let day = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(day.pro_tokens, None, "Pro 缺数量的当日分段必须未知");
        assert_eq!(day.total_tokens, None, "当日合计同样缺项");
        assert!(
            day.flash_tokens.is_some(),
            "Flash 数量完整，不得被 Pro 缺项牵连"
        );
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("未知")));
    }

    #[test]
    fn r07_同槽位别名缺项_分段同样置未知() {
        // 数量侧只有旧别名 deepseek-flash，费用侧还有 deepseek-v4-flash：
        // 两者同属 Flash 槽位 —— 已返回别名给出的部分和不能当作槽位完整值。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"deepseek-v4-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"50.0"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]}
                    ]}
                ]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[
                    {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                    {"model":"deepseek-v4-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.5"}]}
                ],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                        {"model":"deepseek-v4-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.5"}]}
                    ]}
                ]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let day = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(day.flash_tokens, None, "Flash 槽位缺别名数量的分段必须未知");
        assert_eq!(day.total_tokens, None);
    }

    // ---------- R26：日级 other 与同槽位缺项使用同一来源证据 ----------

    fn r26_token_row(model: &str, other: &str) -> serde_json::Value {
        serde_json::json!({
            "model": model,
            "usage": [
                { "type": "PROMPT_CACHE_HIT_TOKEN", "amount": "0" },
                { "type": "PROMPT_CACHE_MISS_TOKEN", "amount": "0" },
                { "type": "RESPONSE_TOKEN", "amount": "0" },
                { "type": "MULTIMODAL_IMAGE_TOKEN", "amount": other },
                { "type": "REQUEST", "amount": "0" }
            ]
        })
    }

    fn r26_cost_row(model: &str, amount: &str) -> serde_json::Value {
        serde_json::json!({
            "model": model,
            "usage": [{ "type": "RESPONSE_TOKEN", "amount": amount }]
        })
    }

    /// 使用真实响应结构、日期和费用入口的合成样本，不手工伪造 UsageDaySummary。
    fn r26_daily_result(
        amount_rows: Vec<serde_json::Value>,
        cost_rows: Vec<serde_json::Value>,
    ) -> UsageResult {
        let amount_body = serde_json::json!({ "data": { "biz_data": {
            "total": amount_rows.clone(),
            "days": [{ "date": "2026-11-01", "data": amount_rows }]
        } } })
        .to_string();
        let cost_body = serde_json::json!({ "data": { "biz_data": [{
            "total": cost_rows.clone(),
            "days": [{ "date": "2026-11-01", "data": cost_rows }]
        }] } })
        .to_string();
        let amount: AmountResp = serde_json::from_str(&amount_body).unwrap();
        let cost: CostResp = serde_json::from_str(&cost_body).unwrap();
        checked_result(&amount, &cost, period(2026, 11, "2026-11-01T04:00:00Z"))
    }

    #[test]
    fn r26_同槽别名只有费用_other未知且保留原始模型兄弟槽与费用() {
        let aliases = [
            "deepseek-flash",
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
        ];
        for known in aliases {
            for missing in aliases.into_iter().filter(|alias| *alias != known) {
                for known_other in ["7", "0"] {
                    // 费用零也只证明费用存在，不能证明该别名的数量为零。
                    for missing_cost in ["2", "0"] {
                        let result = r26_daily_result(
                            vec![
                                r26_token_row(known, known_other),
                                r26_token_row("deepseek-v4-pro", "11"),
                            ],
                            vec![
                                r26_cost_row(known, "1"),
                                r26_cost_row(missing, missing_cost),
                                r26_cost_row("deepseek-v4-pro", "3"),
                            ],
                        );
                        let day = &result.days[0];
                        assert_eq!(day.date, "2026-11-01");
                        assert_eq!(
                            (
                                day.flash_tokens,
                                day.flash_cache_hit,
                                day.flash_cache_miss,
                                day.flash_response,
                                day.flash_other_tokens,
                            ),
                            (None, None, None, None, None)
                        );
                        assert_eq!(
                            (
                                day.pro_tokens,
                                day.pro_cache_hit,
                                day.pro_cache_miss,
                                day.pro_response,
                                day.pro_other_tokens,
                            ),
                            (Some(11), Some(0), Some(0), Some(0), Some(11))
                        );
                        assert_eq!(day.total_tokens, None);
                        let expected_cost = 4.0 + missing_cost.parse::<f64>().unwrap();
                        assert_eq!(day.total_cost, Some(expected_cost));
                        assert_eq!(result.month_cost, Some(expected_cost));

                        assert_eq!(day.raw_models.len(), 3);
                        let raw_known = day
                            .raw_models
                            .iter()
                            .find(|row| row.model == known)
                            .unwrap();
                        assert_eq!(
                            raw_known.other_tokens,
                            Some(known_other.parse::<u64>().unwrap())
                        );
                        assert_eq!(raw_known.total_tokens, raw_known.other_tokens);
                        assert_eq!(raw_known.cost, Some(1.0));
                        let raw_missing = day
                            .raw_models
                            .iter()
                            .find(|row| row.model == missing)
                            .unwrap();
                        assert_eq!(raw_missing.other_tokens, None);
                        assert_eq!(raw_missing.total_tokens, None);
                        assert_eq!(raw_missing.cost, Some(missing_cost.parse::<f64>().unwrap()));
                        assert!(result
                            .warnings
                            .iter()
                            .any(|warning| warning.contains("部分日期缺少费用或数量")));

                        let wire = serde_json::to_value(&result).unwrap();
                        assert!(wire["days"][0]["flashOtherTokens"].is_null());
                        assert_eq!(wire["days"][0]["proOtherTokens"], serde_json::json!(11));
                    }
                }
            }
        }
    }

    #[test]
    fn r26_别名明确数量零_other保留七或真实零() {
        for known_other in ["7", "0"] {
            let result = r26_daily_result(
                vec![
                    r26_token_row("deepseek-flash", known_other),
                    r26_token_row("deepseek-v4-flash", "0"),
                    r26_token_row("deepseek-v4-pro", "11"),
                ],
                vec![
                    r26_cost_row("deepseek-flash", "1"),
                    r26_cost_row("deepseek-v4-flash", "0"),
                    r26_cost_row("deepseek-v4-pro", "3"),
                ],
            );
            let day = &result.days[0];
            let expected_other = known_other.parse::<u64>().unwrap();
            assert_eq!(day.flash_other_tokens, Some(expected_other));
            assert_eq!(day.flash_tokens, Some(expected_other));
            assert_eq!(day.pro_other_tokens, Some(11));
            assert_eq!(day.total_tokens, Some(expected_other + 11));
            assert_eq!(day.total_cost, Some(4.0));
            assert_eq!(result.month_cost, Some(4.0));
            assert!(result.warnings.is_empty(), "明确零且两侧完整不能虚构缺项");
            let raw_zero = day
                .raw_models
                .iter()
                .find(|row| row.model == "deepseek-v4-flash")
                .unwrap();
            assert_eq!(
                (raw_zero.total_tokens, raw_zero.other_tokens, raw_zero.cost),
                (Some(0), Some(0), Some(0.0))
            );
            let wire = serde_json::to_value(&result).unwrap();
            assert_eq!(
                wire["days"][0]["flashOtherTokens"],
                serde_json::json!(expected_other)
            );
        }
    }

    #[test]
    fn r26_flash与pro缺数量互换_other只污染缺项槽位() {
        for (known, missing) in [
            ("deepseek-flash", "deepseek-v4-pro"),
            ("deepseek-v4-pro", "deepseek-flash"),
        ] {
            for known_other in ["7", "0"] {
                let result = r26_daily_result(
                    vec![r26_token_row(known, known_other)],
                    vec![r26_cost_row(known, "1"), r26_cost_row(missing, "2")],
                );
                let day = &result.days[0];
                let (known_total, known_other_count, missing_total, missing_other) =
                    if known == "deepseek-flash" {
                        (
                            day.flash_tokens,
                            day.flash_other_tokens,
                            day.pro_tokens,
                            day.pro_other_tokens,
                        )
                    } else {
                        (
                            day.pro_tokens,
                            day.pro_other_tokens,
                            day.flash_tokens,
                            day.flash_other_tokens,
                        )
                    };
                assert_eq!(known_total, Some(known_other.parse::<u64>().unwrap()));
                assert_eq!(known_other_count, known_total);
                assert_eq!(
                    (missing_total, missing_other, day.total_tokens),
                    (None, None, None)
                );
                assert_eq!(day.total_cost, Some(3.0));
                assert_eq!(result.month_cost, Some(3.0));
                let raw_known = day
                    .raw_models
                    .iter()
                    .find(|row| row.model == known)
                    .unwrap();
                assert_eq!(raw_known.other_tokens, known_other_count);
                let raw_missing = day
                    .raw_models
                    .iter()
                    .find(|row| row.model == missing)
                    .unwrap();
                assert_eq!(raw_missing.other_tokens, None);
                assert_eq!(raw_missing.cost, Some(2.0));
                let wire = serde_json::to_value(&result).unwrap();
                let missing_key = if missing == "deepseek-flash" {
                    "flashOtherTokens"
                } else {
                    "proOtherTokens"
                };
                assert!(wire["days"][0][missing_key].is_null());
            }
        }
    }

    #[test]
    fn r26_槽位总量溢出但来源齐全_保留安全other与费用() {
        for model in ["deepseek-flash", "deepseek-v4-pro"] {
            for other in ["7", "0"] {
                let mut counts = r26_token_row(model, other);
                counts["usage"][0]["amount"] = serde_json::json!("1");
                counts["usage"][2]["amount"] =
                    serde_json::json!(crate::usage::MAX_SAFE_COUNT.to_string());
                let result = r26_daily_result(vec![counts], vec![r26_cost_row(model, "2")]);
                let day = &result.days[0];
                let (total, other_count) = if model == "deepseek-flash" {
                    (day.flash_tokens, day.flash_other_tokens)
                } else {
                    (day.pro_tokens, day.pro_other_tokens)
                };
                assert_eq!(total, None, "仅分段加总超出安全整数，不是模型缺项");
                assert_eq!(day.total_tokens, None);
                assert_eq!(other_count, Some(other.parse::<u64>().unwrap()));
                assert_eq!(day.raw_models[0].other_tokens, other_count);
                assert_eq!(day.total_cost, Some(2.0));
                assert_eq!(result.month_cost, Some(2.0));
            }
        }

        // 两个原始 Flash 别名各自合法，只在槽位求和时溢出也不能抹掉 other。
        let mut first = r26_token_row("deepseek-flash", "0");
        first["usage"][2]["amount"] = serde_json::json!(crate::usage::MAX_SAFE_COUNT.to_string());
        let result = r26_daily_result(
            vec![first, r26_token_row("deepseek-v4-flash", "7")],
            vec![
                r26_cost_row("deepseek-flash", "1"),
                r26_cost_row("deepseek-v4-flash", "2"),
            ],
        );
        let day = &result.days[0];
        assert_eq!(day.flash_tokens, None);
        assert_eq!(day.flash_other_tokens, Some(7));
        assert_eq!(day.total_tokens, None);
        assert!(day.raw_models.iter().all(|row| row.total_tokens.is_some()));
        assert_eq!(day.total_cost, Some(3.0));
        assert_eq!(result.month_cost, Some(3.0));
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["days"][0]["flashOtherTokens"], serde_json::json!(7));
    }

    // ---------- 第七轮复评 F04：月费用与月级模型集合对齐 ----------

    #[test]
    fn f04_数量月汇总含_b_但费用月汇总缺_b_月金额未知() {
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ],
                "days":[]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        assert_eq!(
            result.month_cost, None,
            "费用缺 B 时月金额必须是未知，不能把部分和当完整值"
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("未知") || warning.contains("对齐")),
            "缺项必须有可见提示：{:?}",
            result.warnings
        );
    }

    #[test]
    fn f04_空费用组不当显式零_每个模型显式零才是零() {
        // 有费用分组但 total 为空、数量侧有模型 → 未知（不是 0）。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]}],
                "days":[]
            }}}"#,
        )
        .unwrap();
        let empty_cost: CostResp =
            serde_json::from_str(r#"{"data":{"biz_data":[{"total":[],"days":[]}]}}"#).unwrap();
        let result = build_usage_result(&amount, &empty_cost);
        assert_eq!(result.month_cost, None, "空费用组不是显式零");

        // 每个数量模型都有显式 0 费用 → 0 是合法值。
        let zero_cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"0.0"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &zero_cost);
        assert_eq!(result.month_cost, Some(0.0), "显式零费用应保留为 0");

        // 完全没有费用分组 → 未知（既有语义不变）。
        let absent: CostResp = serde_json::from_str(r#"{"data":{"biz_data":[]}}"#).unwrap();
        let result = build_usage_result(&amount, &absent);
        assert_eq!(result.month_cost, None);
    }

    #[test]
    fn f04_只有日级缺项_月金额保持有效() {
        // 月级齐全，只有 09-01 日缺 B 费用：日费用未知，但月金额必须保留。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ],
                "days":[{"date":"2026-09-01","data":[
                    {"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"200.0"}]}
                ]}]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[
                    {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]},
                    {"model":"m-b","usage":[{"type":"RESPONSE_TOKEN","amount":"2.0"}]}
                ],
                "days":[{"date":"2026-09-01","data":[
                    {"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"1.0"}]}
                ]}]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        assert_eq!(
            result.month_cost,
            Some(3.0),
            "月级齐全时月金额不受日级缺项牵连"
        );
        let day = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(day.total_cost, None, "该日费用仍是未知");
    }

    // ---------- 第七轮复评 F05：主面板与历史共用同一归并口径 ----------

    /// 复评 F05 的最小输入：同一模型被拆成两条 usage。
    fn split_model_response() -> AmountResp {
        serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[
                    {"model":"deepseek-flash","usage":[{"type":"PROMPT_TOKEN","amount":"100"}]},
                    {"model":"deepseek-flash","usage":[
                        {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"20"},
                        {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"80"},
                        {"type":"RESPONSE_TOKEN","amount":"10"}
                    ]}
                ],
                "days":[]
            }}}"#,
        )
        .unwrap()
    }

    #[test]
    fn f05_同名模型分两条_主面板与历史口径一致() {
        let amount = split_model_response();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let flash = result
            .models
            .iter()
            .find(|model| model.key == "flash")
            .expect("flash 行");
        assert_eq!(
            flash.total_tokens,
            Some(110),
            "按模型合并后只兜底一次：110（旧实现逐条得到 210）"
        );
        // 历史侧同一输入也必须得到 110。
        let raw = crate::usage_history::raw_models(
            &amount.data.biz_data.total,
            &cost.data.biz_data[0].total,
        );
        let history = raw
            .iter()
            .find(|model| model.model == "deepseek-flash")
            .expect("历史 flash 行");
        assert_eq!(
            history.total_tokens,
            Some(110),
            "主面板与历史必须给出同一个值"
        );
    }

    #[test]
    fn f05_只有请求量时token未知_不是零() {
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"deepseek-flash","usage":[{"type":"REQUEST","amount":"2"}]}],
                "days":[]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let flash = result
            .models
            .iter()
            .find(|model| model.key == "flash")
            .expect("flash 行");
        assert_eq!(
            flash.total_tokens, None,
            "只有请求数不能把 token 总量说成 0"
        );
        assert_eq!(flash.request_count, Some(2), "请求数本身仍然有效");
        let raw = crate::usage_history::raw_models(
            &amount.data.biz_data.total,
            &cost.data.biz_data[0].total,
        );
        assert_eq!(
            raw.iter()
                .find(|model| model.model == "deepseek-flash")
                .unwrap()
                .total_tokens,
            None,
            "历史侧同样未知"
        );
    }

    #[test]
    fn f05_prompt累计溢出传播未知_不变成零() {
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"deepseek-flash","usage":[
                    {"type":"PROMPT_TOKEN","amount":"9007199254740991"},
                    {"type":"PROMPT_TOKEN","amount":"1"}
                ]}],
                "days":[]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let flash = result
            .models
            .iter()
            .find(|model| model.key == "flash")
            .expect("flash 行");
        assert_eq!(
            flash.total_tokens, None,
            "累计溢出必须传播未知，不能 unwrap_or(0) 变成 0"
        );
    }

    // ---------- 第八轮复评 R09/R10 ----------

    #[test]
    fn r09_有数量但无任何费用值为未知_显式零仍为零() {
        // 数量侧返回模型 A=100；费用侧 A 的 usage 为空（只有分组没有值）。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"m-a","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"100.0"}]}],
                "days":[]
            }}}"#,
        )
        .unwrap();
        let empty_usage_cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"m-a","usage":[]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &empty_usage_cost);
        assert_eq!(
            result.month_cost, None,
            "有数量但没有任何费用值时月金额未知（不是 0）"
        );
        assert!(
            result
                .models
                .iter()
                .find(|model| model.key == "other")
                .is_none_or(|model| model.cost.is_none()),
            "该模型费用同样未知"
        );

        // 显式 RESPONSE 费用 0 仍是合法零。
        let zero_cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"m-a","usage":[{"type":"RESPONSE_TOKEN","amount":"0.0"}]}],
                "days":[]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &zero_cost);
        assert_eq!(result.month_cost, Some(0.0), "显式零费用保留为 0");
    }

    #[test]
    fn r10_日级同模型分两片_日总与历史raw一致() {
        // 评审输入：一天同模型两行 PROMPT=100 与 HIT=20/MISS=80/RESPONSE=10。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"deepseek-flash","usage":[
                    {"type":"PROMPT_TOKEN","amount":"100"},
                    {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"20"},
                    {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"80"},
                    {"type":"RESPONSE_TOKEN","amount":"10"}
                ]}],
                "days":[{"date":"2026-09-01","data":[
                    {"model":"deepseek-flash","usage":[{"type":"PROMPT_TOKEN","amount":"100"}]},
                    {"model":"deepseek-flash","usage":[
                        {"type":"PROMPT_CACHE_HIT_TOKEN","amount":"20"},
                        {"type":"PROMPT_CACHE_MISS_TOKEN","amount":"80"},
                        {"type":"RESPONSE_TOKEN","amount":"10"}
                    ]}
                ]}]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}],
                "days":[{"date":"2026-09-01","data":[
                    {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}
                ]}]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let day = result
            .days
            .iter()
            .find(|day| day.date == "2026-09-01")
            .unwrap();
        assert_eq!(
            day.total_tokens,
            Some(110),
            "日级必须先按模型合并再算 breakdown（旧实现逐片得 210）"
        );
        let raw = crate::usage_history::raw_models(
            &amount.data.biz_data.days[0].data,
            &cost.data.biz_data[0].days[0].data,
        );
        assert_eq!(
            raw.iter()
                .find(|model| model.model == "deepseek-flash")
                .unwrap()
                .total_tokens,
            Some(110),
            "日总与历史 raw 必须一致"
        );
    }

    // ---------- 第九轮复评 N10 ----------

    #[test]
    fn n10_同一天多个对象先合并_只生成一条summary() {
        // 评审触发：平台对同一天返回两个 DayUsage 对象（10 与 20）。
        let amount: AmountResp = serde_json::from_str(
            r#"{"data":{"biz_data":{
                "total":[{"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"30"}]}],
                "days":[
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"10"}]}
                    ]},
                    {"date":"2026-09-01","data":[
                        {"model":"deepseek-flash","usage":[{"type":"PROMPT_CACHE_HIT_TOKEN","amount":"20"}]}
                    ]}
                ]
            }}}"#,
        )
        .unwrap();
        let cost: CostResp = serde_json::from_str(
            r#"{"data":{"biz_data":[{
                "total":[{"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}],
                "days":[{"date":"2026-09-01","data":[
                    {"model":"deepseek-flash","usage":[{"type":"RESPONSE_TOKEN","amount":"0.1"}]}
                ]}]
            }]}}"#,
        )
        .unwrap();
        let result = build_usage_result(&amount, &cost);
        let same_day: Vec<_> = result
            .days
            .iter()
            .filter(|day| day.date == "2026-09-01")
            .collect();
        assert_eq!(same_day.len(), 1, "同日多个对象必须合并成一条 summary");
        assert_eq!(
            same_day[0].total_tokens,
            Some(30),
            "10 + 20 应合并为 30（旧实现图表取最后一项只看 20）"
        );
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

    fn r17_balance_body(currency: &str, total: &str) -> serde_json::Value {
        serde_json::json!({
            "is_available": true,
            "balance_infos": [{
                "currency": currency,
                "total_balance": total,
                "granted_balance": "0.00",
                "topped_up_balance": total
            }]
        })
    }

    #[test]
    fn r17_balance_rejects_invalid_totals_at_the_production_json_boundary() {
        for total in [
            "",
            " ",
            "\t\n",
            "NaN",
            "nan",
            "+NaN",
            "inf",
            "-inf",
            "Infinity",
            "-Infinity",
            "1e309",
            "-1e309",
            "1000000000000001",
            "-1000000000000001",
            "1e-9999",
            "-1e-9999",
            "12.34oops",
            "0x10",
            "1,000",
            " 12.34 ",
            "--1",
        ] {
            let mut body = r17_balance_body("CNY", total);
            body["balance_infos"][0]["topped_up_balance"] = serde_json::json!("12.34");
            let error = parse_balance_json(&body.to_string()).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidData, "{total:?}");
            assert!(error.message.contains("total_balance"), "{total:?}");
            let command: crate::error::CommandError = error.into();
            assert_eq!(command.code, "invalid_data");
            assert!(!command.retryable);
        }
    }

    #[test]
    fn r17_balance_keeps_zero_debt_supported_currencies_and_original_precision() {
        for currency in ["CNY", "USD"] {
            for total in [
                "0",
                "0.00",
                "-0.00",
                "+0",
                "0e100",
                "-0.000e-100",
                "12.340000",
                "-12.34",
                "1.234e2",
                "-1.234e2",
                "1000000000001",
                "-1000000000001",
                "1e15",
                "-1e15",
            ] {
                for available in [true, false] {
                    let mut body = r17_balance_body(currency, total);
                    body["is_available"] = serde_json::json!(available);
                    let result = parse_balance_json(&body.to_string()).unwrap();
                    assert_eq!(result.is_available, available);
                    assert_eq!(result.currency, currency);
                    assert_eq!(result.total_balance, total);
                    assert_eq!(result.granted_balance, "0.00");
                    assert_eq!(result.topped_up_balance, total);
                }
            }
        }
    }

    #[test]
    fn r17_balance_unknown_or_missing_currency_is_not_assumed_cny() {
        for currency in ["", " ", "EUR", "JPY", "cny", "usd", "CNY "] {
            let body = r17_balance_body(currency, "12.34");
            let error = parse_balance_json(&body.to_string()).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidData, "{currency:?}");
        }
        for value in [serde_json::Value::Null, serde_json::json!(123)] {
            let mut body = r17_balance_body("CNY", "12.34");
            body["balance_infos"][0]["currency"] = value;
            assert_eq!(
                parse_balance_json(&body.to_string()).unwrap_err().kind,
                ErrorKind::InvalidData
            );
        }
        let mut body = r17_balance_body("CNY", "12.34");
        body["balance_infos"][0]
            .as_object_mut()
            .unwrap()
            .remove("currency");
        assert_eq!(
            parse_balance_json(&body.to_string()).unwrap_err().kind,
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn r17_balance_all_amount_fields_require_explicit_valid_strings() {
        for field in ["total_balance", "granted_balance", "topped_up_balance"] {
            for value in [
                serde_json::Value::Null,
                serde_json::json!(0),
                serde_json::json!(""),
                serde_json::json!("NaN"),
                serde_json::json!("Infinity"),
                serde_json::json!("1e16"),
                serde_json::json!("1e-9999"),
            ] {
                let mut body = r17_balance_body("CNY", "12.34");
                body["balance_infos"][0][field] = value;
                assert_eq!(
                    parse_balance_json(&body.to_string()).unwrap_err().kind,
                    ErrorKind::InvalidData,
                    "{field}"
                );
            }
            let mut body = r17_balance_body("CNY", "12.34");
            body["balance_infos"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert_eq!(
                parse_balance_json(&body.to_string()).unwrap_err().kind,
                ErrorKind::InvalidData,
                "missing {field}"
            );
        }
    }

    #[test]
    fn r17_balance_does_not_replace_a_bad_first_row_with_another_currency() {
        let mut body = r17_balance_body("CNY", "12.34");
        let usd = r17_balance_body("USD", "56.78")["balance_infos"][0].clone();
        body["balance_infos"].as_array_mut().unwrap().push(usd);
        let result = parse_balance_json(&body.to_string()).unwrap();
        assert_eq!(result.currency, "CNY");
        assert_eq!(result.total_balance, "12.34");
        body["balance_infos"][0]["total_balance"] = serde_json::json!("NaN");
        assert_eq!(
            parse_balance_json(&body.to_string()).unwrap_err().kind,
            ErrorKind::InvalidData
        );
        body["balance_infos"][0]["total_balance"] = serde_json::json!("12.34");
        body["balance_infos"][0]["currency"] = serde_json::json!("EUR");
        assert_eq!(
            parse_balance_json(&body.to_string()).unwrap_err().kind,
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn r17_balance_invalid_structure_uses_the_same_invalid_data_classification() {
        for body in [
            "not json",
            "{}",
            r#"{"is_available":true,"balance_infos":[]}"#,
            r#"{"is_available":true,"balance_infos":null}"#,
        ] {
            assert_eq!(
                parse_balance_json(body).unwrap_err().kind,
                ErrorKind::InvalidData
            );
        }
        let mut body = r17_balance_body("CNY", "0");
        body["is_available"] = serde_json::json!("false");
        assert_eq!(
            parse_balance_json(&body.to_string()).unwrap_err().kind,
            ErrorKind::InvalidData
        );
    }

    #[test]
    fn 用量聚合_新旧模型名归并到同一行() {
        let result = build_usage_result(&amount_sample(), &cost_sample());
        assert_eq!(result.models.len(), 1);
        let flash = &result.models[0];
        assert_eq!(flash.key, "flash");
        assert_eq!(flash.name, "V4.1 Flash");
        assert_eq!(flash.cache_hit_tokens, Some(110));
        assert_eq!(flash.response_tokens, Some(30));
        assert_eq!(flash.request_count, None, "别名缺请求字段不能展示部分和 3");
        assert_eq!(
            flash.cache_miss_tokens, None,
            "别名缺 MISS 不能展示部分和 50"
        );
        // 0.10 + 0.20（REQUEST 不计费用）只覆盖 deepseek-flash；
        // 同槽位的 deepseek-v4-flash 没有费用条目，槽位费用因此未知（复评 F06）。
        assert_eq!(flash.cost, None, "别名缺费用时不能显示部分金额");
        // 复评 F04：同一份样本里费用侧缺了数量侧返回的别名模型，
        // 因此月金额同样是未知（缺项≠零，也不是部分和）。
        assert_eq!(result.month_cost, None, "月金额与模型集合对齐后才可用");
    }

    #[test]
    fn 用量聚合_按日费用对齐日期() {
        let result = build_usage_result(&amount_sample(), &cost_sample());
        assert_eq!(result.days.len(), 1);
        assert_eq!(result.days[0].date, "2026-09-01");
        assert!((result.days[0].total_cost.unwrap() - 0.05).abs() < 1e-9);
        assert_eq!(result.days[0].total_tokens, Some(70));
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
        assert_eq!(result.models[0].total_tokens, Some(10));
        assert_eq!(result.days[0].total_tokens, Some(10));
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
        assert_eq!(result.days[0].total_tokens, Some(10));
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
        assert_eq!(result.models[0].total_tokens, Some(16));
    }
}
