//! Opt-in independent reminder checks. No retained/failed data can trigger a notice.
use crate::{config, deepseek_api, error::CommandError};
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

const CHECK_SECONDS: u64 = 300;
const COOLDOWN_SECONDS: u64 = 24 * 3600;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AlertOptions {
    pub enabled: bool,
    pub low_balance_enabled: bool,
    pub low_balance_cny: f64,
    pub monthly_budget_enabled: bool,
    pub monthly_budget_cny: f64,
    pub quiet_hours: bool,
}
impl Default for AlertOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            low_balance_enabled: true,
            low_balance_cny: 10.0,
            monthly_budget_enabled: false,
            monthly_budget_cny: 100.0,
            quiet_hours: true,
        }
    }
}
impl AlertOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !self.low_balance_cny.is_finite()
            || !(0.0..=1_000_000_000.0).contains(&self.low_balance_cny)
        {
            return Err("余额提醒线需为0至10亿元之间的金额".into());
        }
        if !self.monthly_budget_cny.is_finite()
            || self.monthly_budget_cny <= 0.0
            || self.monthly_budget_cny > 1_000_000_000.0
        {
            return Err("月预算需大于0且不超过10亿元".into());
        }
        if self.enabled && !self.low_balance_enabled && !self.monthly_budget_enabled {
            return Err("请至少开启一种提醒".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Balance,
    Budget,
    Test,
}
fn quiet(options: &AlertOptions, hour: u32) -> bool {
    options.quiet_hours && !(8..22).contains(&hour)
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_secs())
        .unwrap_or(0)
}
fn identity(kind: Kind, credential: &str, threshold: f64, month: (u32, u32)) -> String {
    let kind = match kind {
        Kind::Balance => "balance",
        Kind::Budget => "budget",
        Kind::Test => "test",
    };
    let mut hash = Sha256::new();
    hash.update(kind);
    hash.update([0]);
    hash.update(credential);
    hash.update([0]);
    hash.update(threshold.to_bits().to_le_bytes());
    if kind == "budget" {
        hash.update(month.0.to_le_bytes());
        hash.update(month.1.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    attempted_at: u64,
    submitted: bool,
}
#[derive(Default, Clone, Serialize, Deserialize)]
struct Ledger {
    receipts: BTreeMap<String, Receipt>,
}
impl Ledger {
    fn allows(&self, key: &str, kind: Kind, now: u64) -> bool {
        let Some(receipt) = self.receipts.get(key) else {
            return true;
        };
        if kind == Kind::Budget && receipt.submitted {
            return false;
        }
        let wait = if kind == Kind::Test {
            60
        } else if receipt.submitted {
            COOLDOWN_SECONDS
        } else {
            3600
        };
        now >= receipt.attempted_at && now - receipt.attempted_at >= wait
    }
    fn record(&mut self, key: String, now: u64, submitted: bool) {
        self.receipts
            .retain(|_, r| now < r.attempted_at || now - r.attempted_at < 90 * 86400);
        self.receipts.insert(
            key,
            Receipt {
                attempted_at: now,
                submitted,
            },
        );
        while self.receipts.len() > 128 {
            let oldest = self
                .receipts
                .iter()
                .min_by_key(|(_, r)| r.attempted_at)
                .map(|(k, _)| k.clone())
                .unwrap();
            self.receipts.remove(&oldest);
        }
    }
}
fn ledger_path() -> Result<std::path::PathBuf, String> {
    Ok(config::config_path()?.with_file_name("alert-receipts.json"))
}
fn load_ledger() -> Result<Ledger, String> {
    let path = ledger_path()?;
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::default()),
        Ok(m) if m.len() <= 65536 => {}
        _ => return Err("提醒去重记录无法读取，未发送通知".into()),
    }
    let ledger: Ledger = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "提醒去重记录无法读取，未发送通知")?,
    )
    .map_err(|_| "提醒去重记录损坏，未发送通知")?;
    if ledger.receipts.len() > 128
        || ledger
            .receipts
            .keys()
            .any(|k| k.len() != 64 || !k.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("提醒去重记录格式不可用，未发送通知".into());
    }
    Ok(ledger)
}
fn persist_ledger(ledger: &Ledger) -> Result<(), String> {
    let path = ledger_path()?;
    std::fs::create_dir_all(path.parent().ok_or("提醒目录不可用")?)
        .map_err(|_| "提醒去重记录无法保存，未发送通知")?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(ledger).map_err(|_| "提醒记录格式不可用")?,
    )
    .map_err(|_| "提醒去重记录无法保存，未发送通知")?;
    std::fs::rename(&temp, path).map_err(|_| "提醒去重记录无法保存，未发送通知".into())
}
#[derive(Default)]
struct Poll {
    identity: String,
    next: u64,
    failures: u32,
}
impl Poll {
    fn due(&mut self, key: String, now: u64) -> bool {
        if self.identity != key {
            self.identity = key;
            self.next = 0;
            self.failures = 0;
        }
        now >= self.next
    }
    fn finish(&mut self, now: u64, code: &str) {
        if code == "ok" || code == "unsupported" || code == "invalid_data" {
            self.failures = 0;
            self.next = now + CHECK_SECONDS;
        } else if code == "credentials_invalid" {
            self.next = u64::MAX;
        } else {
            self.failures = self.failures.saturating_add(1);
            self.next = now + (CHECK_SECONDS * (1u64 << self.failures.min(3))).min(1800);
        }
    }
}
#[derive(Default)]
pub struct AlertRuntime(Mutex<Runtime>);
#[derive(Default)]
struct Runtime {
    ledger: Option<Ledger>,
    balance: Poll,
    budget: Poll,
    balance_state: String,
    budget_state: String,
    balance_checked_at: Option<u64>,
    budget_checked_at: Option<u64>,
    last_notification_at: Option<u64>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertStatus {
    pub options: AlertOptions,
    pub balance_state: String,
    pub budget_state: String,
    pub balance_checked_at: Option<u64>,
    pub budget_checked_at: Option<u64>,
    pub last_notification_at: Option<u64>,
    pub quiet_now: bool,
    pub error: Option<String>,
}
pub fn status(app: &tauri::AppHandle) -> Result<AlertStatus, String> {
    let config = config::read_stored_config()?;
    let runtime = app.state::<AlertRuntime>();
    let state = runtime.0.lock().map_err(|_| "提醒状态不可用")?;
    let month = crate::usage_watcher::cst_month(SystemTime::now());
    let current_balance = state.balance.identity == poll_identity(Kind::Balance, &config, month);
    let current_budget = state.budget.identity == poll_identity(Kind::Budget, &config, month);
    let state_for = |enabled: bool, credential: &Option<String>, value: &str, current: bool| {
        if !config.alerts.enabled || !enabled {
            "disabled".into()
        } else if credential.as_ref().is_none_or(|k| k.is_empty()) {
            "missing".into()
        } else if value.is_empty() || !current {
            "waiting".into()
        } else {
            value.into()
        }
    };
    Ok(AlertStatus {
        balance_state: state_for(
            config.alerts.low_balance_enabled,
            &config.api_key,
            &state.balance_state,
            current_balance,
        ),
        budget_state: state_for(
            config.alerts.monthly_budget_enabled,
            &config.usage_token,
            &state.budget_state,
            current_budget,
        ),
        quiet_now: quiet(&config.alerts, chrono::Local::now().hour()),
        error: config.alerts.enabled.then(|| state.error.clone()).flatten(),
        options: config.alerts,
        balance_checked_at: current_balance
            .then_some(state.balance_checked_at)
            .flatten(),
        budget_checked_at: current_budget.then_some(state.budget_checked_at).flatten(),
        last_notification_at: state.last_notification_at,
    })
}
pub fn save_options(app: &tauri::AppHandle, options: AlertOptions) -> Result<AlertStatus, String> {
    options.validate()?;
    config::edit_config(|config| {
        config.alerts = options;
        Ok(())
    })?;
    app.state::<AlertRuntime>()
        .0
        .lock()
        .map_err(|_| "提醒状态不可用")?
        .error = None;
    status(app)
}
fn submit(
    app: &tauri::AppHandle,
    state: &mut Runtime,
    key: String,
    kind: Kind,
    now: u64,
) -> Result<bool, String> {
    submit_with(
        state,
        key,
        kind,
        now,
        |body| {
            app.notification()
                .builder()
                .title("DeepSeek Monitor")
                .body(body)
                .show()
                .map_err(|_| "通知未能提交系统，请检查Windows通知设置或安装后重试".into())
        },
        persist_ledger,
    )
}
fn submit_with(
    state: &mut Runtime,
    key: String,
    kind: Kind,
    now: u64,
    send: impl FnOnce(&str) -> Result<(), String>,
    mut persist: impl FnMut(&Ledger) -> Result<(), String>,
) -> Result<bool, String> {
    if state.ledger.is_none() {
        state.ledger = Some(load_ledger()?);
    }
    let ledger = state.ledger.as_ref().unwrap();
    if !ledger.allows(&key, kind, now) {
        return Ok(false);
    }
    // Persist an attempted submission first: a crash cannot cause an immediate duplicate.
    let mut next = ledger.clone();
    next.record(key.clone(), now, false);
    persist(&next)?;
    state.ledger = Some(next);
    let body=match kind {Kind::Balance=>"账户余额已达到提醒线，请打开面板查看最新余额。",Kind::Budget=>"平台本月费用已达到预算提醒线，请打开用量页核对。统计按北京时间自然月，提醒不会阻止消费。",Kind::Test=>"这是一条测试通知，没有查询账户余额或用量。"};
    send(body)?;
    state.last_notification_at = Some(now * 1000);
    let ledger = state.ledger.as_mut().unwrap();
    ledger.record(key, now, true);
    persist(ledger).map_err(|_| "通知已提交系统，但去重回执保存失败；请检查本地配置目录")?;
    Ok(true)
}
pub fn test_notification(app: &tauri::AppHandle) -> Result<(), String> {
    let (revision, _) = config::read_snapshot()?;
    config::with_current(revision, |config| {
        if !config.alerts.enabled {
            return Err("请先开启提醒并保存".into());
        }
        let runtime = app.state::<AlertRuntime>();
        let mut state = runtime.0.lock().map_err(|_| "提醒状态不可用")?;
        if !submit(
            app,
            &mut state,
            identity(Kind::Test, "", 0.0, (0, 0)),
            Kind::Test,
            now_seconds(),
        )? {
            return Err("测试通知请间隔至少60秒".into());
        }
        state.error = None;
        Ok(())
    })?
    .ok_or_else(|| "设置已改变，请重试".into())
}
fn balance_sample(data: deepseek_api::BalanceResult, options: &AlertOptions) -> (String, bool) {
    if data.currency != "CNY" {
        return ("unsupported".into(), false);
    }
    match data.total_balance.parse::<f64>() {
        Ok(value) if value.is_finite() && value.abs() <= 1e12 => {
            ("ok".into(), value <= options.low_balance_cny)
        }
        _ => ("invalid_data".into(), false),
    }
}
fn budget_sample(data: deepseek_api::UsageResult, options: &AlertOptions) -> (String, bool) {
    if !data.warnings.is_empty()
        || !data.month_cost.is_finite()
        || !(0.0..=1e12).contains(&data.month_cost)
    {
        return ("invalid_data".into(), false);
    }
    ("ok".into(), data.month_cost >= options.monthly_budget_cny)
}
fn outcome<T>(
    result: Option<Result<T, String>>,
    evaluate: impl FnOnce(T) -> (String, bool),
) -> Option<(String, bool)> {
    result.map(|result| match result {
        Ok(data) => evaluate(data),
        Err(message) => (CommandError::new(message, None).code.into(), false),
    })
}
pub async fn while_current<T>(
    revision: u64,
    future: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result=&mut future => return (config::revision()==revision).then_some(result),
            _=tokio::time::sleep(Duration::from_millis(200)) => if config::revision()!=revision {return None;},
        }
    }
}
fn poll_identity(kind: Kind, config: &config::StoredConfig, month: (u32, u32)) -> String {
    let options = serde_json::to_string(&config.alerts).unwrap_or_default();
    let (credential, threshold) = match kind {
        Kind::Balance => (
            config.api_key.as_deref().unwrap_or(""),
            config.alerts.low_balance_cny,
        ),
        _ => (
            config.usage_token.as_deref().unwrap_or(""),
            config.alerts.monthly_budget_cny,
        ),
    };
    let validation = config::credential_validation_revision(match kind {
        Kind::Balance => config::ValidatedCredential::ApiKey,
        _ => config::ValidatedCredential::UsageToken,
    });
    identity(
        kind,
        &format!("{credential}\0{options}\0{validation}"),
        threshold,
        month,
    )
}
async fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    let (revision, config) = config::read_snapshot()?;
    if !config.alerts.enabled {
        return Ok(());
    }
    config.alerts.validate()?;
    let now = now_seconds();
    if now == 0 {
        return Err("系统时钟不可用，提醒未执行".into());
    }
    let month = crate::usage_watcher::cst_month(SystemTime::now());
    let key = config.api_key.as_deref().filter(|k| !k.is_empty());
    let token = config.usage_token.as_deref().filter(|k| !k.is_empty());
    let runtime = app.state::<AlertRuntime>();
    let (balance_due, budget_due) = {
        let mut state = runtime.0.lock().map_err(|_| "提醒状态不可用")?;
        let balance_due = config.alerts.low_balance_enabled
            && key.is_some()
            && state
                .balance
                .due(poll_identity(Kind::Balance, &config, month), now);
        let budget_due = config.alerts.monthly_budget_enabled
            && token.is_some()
            && state
                .budget
                .due(poll_identity(Kind::Budget, &config, month), now);
        if balance_due {
            state.balance_state = "checking".into();
        }
        if budget_due {
            state.budget_state = "checking".into();
        }
        (balance_due, budget_due)
    };
    if !balance_due && !budget_due {
        return Ok(());
    }
    let future = async {
        tokio::join!(
            async {
                if balance_due {
                    Some(deepseek_api::fetch_balance_with_key(key.unwrap()).await)
                } else {
                    None
                }
            },
            async {
                if budget_due {
                    Some(
                        deepseek_api::fetch_usage_with_token(token.unwrap(), month.0, month.1)
                            .await,
                    )
                } else {
                    None
                }
            }
        )
    };
    let Some(result) = while_current(
        revision,
        tokio::time::timeout(Duration::from_secs(20), future),
    )
    .await
    else {
        return Ok(());
    };
    let (balance, budget) = result.unwrap_or_else(|_| {
        (
            balance_due.then(|| Err("网络请求失败：提醒检查超时".into())),
            budget_due.then(|| Err("网络请求失败：提醒检查超时".into())),
        )
    });
    let balance = outcome(balance, |data| balance_sample(data, &config.alerts));
    let budget = outcome(budget, |data| budget_sample(data, &config.alerts));
    config::with_current(revision, |current| {
        if !current.alerts.enabled
            || current.alerts != config.alerts
            || current.api_key != config.api_key
            || current.usage_token != config.usage_token
        {
            return Ok(());
        }
        let now = now_seconds();
        let quiet_now = quiet(&current.alerts, chrono::Local::now().hour());
        let mut state = runtime.0.lock().map_err(|_| "提醒状态不可用")?;
        if let Some((code, trigger)) = balance {
            state.balance.finish(now, &code);
            state.balance_state = code;
            state.balance_checked_at = Some(now * 1000);
            if trigger && !quiet_now {
                match submit(
                    app,
                    &mut state,
                    identity(
                        Kind::Balance,
                        key.unwrap(),
                        current.alerts.low_balance_cny,
                        (0, 0),
                    ),
                    Kind::Balance,
                    now,
                ) {
                    Ok(true) => state.error = None,
                    Ok(false) => {}
                    Err(error) => state.error = Some(error),
                }
            }
        }
        if let Some((code, trigger)) = budget {
            state.budget.finish(now, &code);
            state.budget_state = code;
            state.budget_checked_at = Some(now * 1000);
            if trigger && !quiet_now && crate::usage_watcher::cst_month(SystemTime::now()) == month
            {
                match submit(
                    app,
                    &mut state,
                    identity(
                        Kind::Budget,
                        token.unwrap(),
                        current.alerts.monthly_budget_cny,
                        month,
                    ),
                    Kind::Budget,
                    now,
                ) {
                    Ok(true) => state.error = None,
                    Ok(false) => {}
                    Err(error) => state.error = Some(error),
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = tick(&app).await {
                if let Ok(mut state) = app.state::<AlertRuntime>().0.lock() {
                    state.error = Some(error);
                }
            }
            tokio::select! {_=config::changed().notified()=>{},_=tokio::time::sleep(Duration::from_secs(60))=>{}}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validated_same_value_commit_recovers_only_corresponding_poll_and_keeps_receipts() {
        use config::ValidatedCredential::{ApiKey, UsageToken};
        let dir = crate::test_support::TempConfigDir::new("alert-credential-recovery");
        config::edit_config(|config| {
            config.api_key = Some("synthetic-key".into());
            config.usage_token = Some("synthetic-token".into());
            Ok(())
        })
        .unwrap();
        let mut state = Runtime::default();
        let config = config::read_stored_config().unwrap();
        let month = (10, 2026);
        let balance_id = poll_identity(Kind::Balance, &config, month);
        let budget_id = poll_identity(Kind::Budget, &config, month);
        assert!(state.balance.due(balance_id.clone(), 100));
        assert!(state.budget.due(budget_id.clone(), 100));
        state.balance.finish(100, "credentials_invalid");
        state.budget.finish(100, "credentials_invalid");
        let receipt = identity(Kind::Budget, "synthetic-token", 100.0, month);
        let mut ledger = Ledger::default();
        ledger.record(receipt.clone(), 100, true);
        state.ledger = Some(ledger);
        let old_revision = config::revision();
        let budget_epoch = config::credential_validation_revision(UsageToken);
        config::edit_validated_credential(ApiKey, "synthetic-key".into()).unwrap();
        assert!(config::with_current(old_revision, |_| Ok(()))
            .unwrap()
            .is_none());
        let current = config::read_stored_config().unwrap();
        assert!(state
            .balance
            .due(poll_identity(Kind::Balance, &current, month), 200));
        assert!(!state
            .budget
            .due(poll_identity(Kind::Budget, &current, month), 200));
        assert_eq!(
            config::credential_validation_revision(UsageToken),
            budget_epoch
        );
        let bytes = std::fs::read(config::config_path().unwrap()).unwrap();
        // Force a real isolated write failure, after reading a valid config.
        std::fs::create_dir(dir.join("config.json.tmp")).unwrap();
        assert!(config::edit_validated_credential(UsageToken, "synthetic-token".into()).is_err());
        assert_eq!(
            config::credential_validation_revision(UsageToken),
            budget_epoch
        );
        assert_eq!(
            std::fs::read(config::config_path().unwrap()).unwrap(),
            bytes
        );
        std::fs::remove_dir(dir.join("config.json.tmp")).unwrap();
        let current =
            config::edit_validated_credential(UsageToken, "synthetic-token".into()).unwrap();
        assert!(state
            .budget
            .due(poll_identity(Kind::Budget, &current, month), 200));
        assert!(!state
            .ledger
            .as_ref()
            .unwrap()
            .allows(&receipt, Kind::Budget, 200));
        let balance_epoch = config::credential_validation_revision(ApiKey);
        config::edit_config(|c| {
            c.api_key = None;
            Ok(())
        })
        .unwrap();
        config::edit_validated_credential(ApiKey, "synthetic-key".into()).unwrap();
        assert!(config::credential_validation_revision(ApiKey) > balance_epoch);
    }
    #[test]
    fn 阈值与默认关闭严格校验() {
        assert!(!AlertOptions::default().enabled);
        for value in [f64::NAN, -1.0, f64::INFINITY, 1e10] {
            assert!(AlertOptions {
                low_balance_cny: value,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert!(AlertOptions {
            monthly_budget_cny: 0.0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(AlertOptions {
            enabled: true,
            low_balance_enabled: false,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn 本机免打扰边界和关闭() {
        let options = AlertOptions::default();
        for hour in [0, 7, 22, 23] {
            assert!(quiet(&options, hour));
        }
        for hour in [8, 21] {
            assert!(!quiet(&options, hour));
        }
        assert!(!quiet(
            &AlertOptions {
                quiet_hours: false,
                ..options
            },
            23
        ));
    }
    #[test]
    fn 余额冷却月预算单次和失败重试隔离() {
        let mut ledger = Ledger::default();
        ledger.record("low".into(), 100, true);
        assert!(!ledger.allows("low", Kind::Balance, 101));
        assert!(ledger.allows("low", Kind::Balance, 100 + COOLDOWN_SECONDS));
        assert!(!ledger.allows("low", Kind::Balance, 99));
        ledger.record("month".into(), 100, true);
        assert!(!ledger.allows("month", Kind::Budget, 100 + COOLDOWN_SECONDS));
        assert!(ledger.allows("next-month", Kind::Budget, 101));
        ledger.record("failure".into(), 100, false);
        assert!(!ledger.allows("failure", Kind::Budget, 101));
        assert!(ledger.allows("failure", Kind::Budget, 3700));
    }
    #[test]
    fn 去重记录仅含摘要_重启可复用_大小受限() {
        let a = identity(Kind::Budget, "SECRET", 100.0, (10, 2026));
        assert_ne!(a, identity(Kind::Budget, "SECRET", 100.0, (11, 2026)));
        assert_ne!(a, identity(Kind::Budget, "OTHER", 100.0, (10, 2026)));
        let mut ledger = Ledger::default();
        for i in 0..200 {
            ledger.record(
                identity(Kind::Balance, &i.to_string(), 10.0, (0, 0)),
                i,
                true,
            );
        }
        assert_eq!(ledger.receipts.len(), 128);
        ledger.record(a.clone(), 300, true);
        let text = serde_json::to_string(&ledger).unwrap();
        assert!(!text.contains("SECRET"));
        let reload: Ledger = serde_json::from_str(&text).unwrap();
        assert!(!reload.allows(&a, Kind::Budget, 400));
    }
    #[test]
    fn 退避封顶_成功恢复_无效凭据暂停() {
        let mut poll = Poll::default();
        assert!(poll.due("one".into(), 1));
        for _ in 0..9 {
            poll.finish(1, "unavailable");
        }
        assert_eq!(poll.next, 1801);
        poll.finish(1, "ok");
        assert_eq!(poll.next, 301);
        poll.finish(1, "credentials_invalid");
        assert!(!poll.due("one".into(), 1000));
        assert!(poll.due("new-key".into(), 1000));
    }
    #[test]
    fn 失败不触发通知_金额与币种不猜测() {
        assert_eq!(
            outcome::<()>(Some(Err("网络请求失败".into())), |_| panic!()),
            Some(("unavailable".into(), false))
        );
        let balance = |currency: &str, total: &str| deepseek_api::BalanceResult {
            is_available: true,
            currency: currency.into(),
            total_balance: total.into(),
            granted_balance: "0".into(),
            topped_up_balance: "0".into(),
        };
        assert!(balance_sample(balance("CNY", "10"), &Default::default()).1);
        assert!(!balance_sample(balance("CNY", "NaN"), &Default::default()).1);
        assert!(!balance_sample(balance("USD", "0"), &Default::default()).1);
    }
    #[test]
    fn 预算待核对或无效数字不能触发_阈值包含等号() {
        let data = |cost, warnings| deepseek_api::UsageResult {
            schema_version: 2,
            model_mapping_version: "test",
            raw_models: vec![],
            warnings,
            models: vec![],
            days: vec![],
            month_cost: cost,
        };
        assert!(budget_sample(data(100.0, vec![]), &Default::default()).1);
        assert!(!budget_sample(data(99.99, vec![]), &Default::default()).1);
        for cost in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(!budget_sample(data(cost, vec![]), &Default::default()).1);
        }
        assert!(
            !budget_sample(
                data(200.0, vec!["费用与Token未对齐".into()]),
                &Default::default()
            )
            .1
        );
    }
    #[test]
    fn 去重文件实际往返与损坏拒绝_不发送系统通知() {
        let _dir = crate::test_support::TempConfigDir::new("alert-ledger");
        let mut ledger = load_ledger().unwrap();
        let key = identity(Kind::Budget, "LOCAL_SECRET", 100.0, (10, 2026));
        ledger.record(key.clone(), 100, true);
        persist_ledger(&ledger).unwrap();
        assert!(!load_ledger().unwrap().allows(&key, Kind::Budget, 200));
        let path = ledger_path().unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("LOCAL_SECRET"));
        std::fs::write(&path, b"broken").unwrap();
        assert!(load_ledger().is_err());
    }
    #[test]
    fn 持久化失败不发送_系统提交失败保留冷却尝试() {
        let mut state = Runtime {
            ledger: Some(Ledger::default()),
            ..Default::default()
        };
        assert!(submit_with(
            &mut state,
            "key".into(),
            Kind::Balance,
            100,
            |_| panic!("去重无法持久化时不能通知"),
            |_| Err("disk".into())
        )
        .is_err());
        assert!(submit_with(
            &mut state,
            "key".into(),
            Kind::Balance,
            100,
            |_| Err("system".into()),
            |_| Ok(())
        )
        .is_err());
        assert!(!state
            .ledger
            .as_ref()
            .unwrap()
            .allows("key", Kind::Balance, 101));
        assert!(state
            .ledger
            .as_ref()
            .unwrap()
            .allows("key", Kind::Balance, 3700));
        assert!(state.last_notification_at.is_none());
    }
    #[test]
    fn 系统提交后回执写入失败不能谎称未发送_正常去重不再次发送() {
        let mut state = Runtime {
            ledger: Some(Ledger::default()),
            ..Default::default()
        };
        let mut writes = 0;
        let error = submit_with(
            &mut state,
            "key".into(),
            Kind::Budget,
            100,
            |_| Ok(()),
            |_| {
                writes += 1;
                if writes == 1 {
                    Ok(())
                } else {
                    Err("disk".into())
                }
            },
        )
        .unwrap_err();
        assert!(error.contains("已提交系统"));
        assert_eq!(state.last_notification_at, Some(100000));
        assert!(!submit_with(
            &mut state,
            "key".into(),
            Kind::Budget,
            200,
            |_| panic!("已提交的月预算不能重复发送"),
            |_| panic!("无需再次保存")
        )
        .unwrap());
    }
    #[test]
    fn 配置更换取消挂起请求_最终回调不能执行_失败写入不更改代际() {
        let dir = crate::test_support::TempConfigDir::new("alert-generation");
        let (old, _) = config::read_snapshot().unwrap();
        config::edit_config(|cfg| {
            cfg.api_key = None;
            Ok(())
        })
        .unwrap();
        assert!(config::with_current(old, |_| -> Result<(), String> {
            panic!("旧代际不能提交通知")
        })
        .unwrap()
        .is_none());
        let (current, _) = config::read_snapshot().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let pending = async {
                std::future::pending::<()>().await;
            };
            let change = async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                config::edit_config(|cfg| {
                    cfg.alerts.enabled = false;
                    Ok(())
                })
                .unwrap();
            };
            let (result, _) = tokio::join!(while_current(current, pending), change);
            assert!(result.is_none());
        });
        let before = config::revision();
        std::fs::create_dir(dir.join("config.json.tmp")).unwrap();
        assert!(config::edit_config(|cfg| {
            cfg.alerts.enabled = true;
            Ok(())
        })
        .is_err());
        assert_eq!(before, config::revision());
        assert!(!config::read_stored_config().unwrap().alerts.enabled);
    }
}
