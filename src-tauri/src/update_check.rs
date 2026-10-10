//! Manual, unauthenticated GitHub release lookup; never downloads or installs an update.
use serde::{Deserialize, Serialize};
use std::{
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const RELEASE_API: &str =
    "https://api.github.com/repos/Tsuki-hash/DeepSeekMonitorWin/releases/latest";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub state: String,
    pub checked_at: u64,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}
pub fn compare_release(current: &str, data: &[u8], now: u64) -> Result<UpdateResult, String> {
    let release: Release = serde_json::from_slice(data).map_err(|_| "发行信息格式不可用")?;
    if release.draft || release.prerelease {
        return Err("没有可核对的正式发行版本".into());
    }
    let version = semver::Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| "发行版本号格式不可用")?;
    if !version.pre.is_empty() {
        return Err("不是正式发行版本".into());
    }
    let installed = semver::Version::parse(current).map_err(|_| "当前版本号不可用")?;
    let state = match version.cmp_precedence(&installed) {
        std::cmp::Ordering::Greater => "available",
        std::cmp::Ordering::Equal => "current",
        std::cmp::Ordering::Less => "ahead",
    };
    Ok(UpdateResult {
        current_version: current.into(),
        latest_version: Some(version.to_string()),
        state: state.into(),
        checked_at: now,
    })
}
#[derive(Default)]
pub struct UpdateCache(pub tokio::sync::Mutex<Option<UpdateResult>>);
pub async fn check(current: &str, cache: &UpdateCache) -> Result<UpdateResult, String> {
    let mut cached = cache.0.lock().await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟异常")?
        .as_millis() as u64;
    if let Some(result) = cached.as_ref().filter(|result| {
        result.current_version == current
            && now >= result.checked_at
            && now - result.checked_at < 60000
    }) {
        return Ok(result.clone());
    }
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("DeepSeekMonitorWindows-update-check")
                .build()
        })
        .as_ref()
        .map_err(|_| "无法初始化更新检查")?;
    let mut response = client
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接发行服务，请检查网络后重试")?;
    let result = if response.status() == reqwest::StatusCode::NOT_FOUND {
        UpdateResult {
            current_version: current.into(),
            latest_version: None,
            state: "unavailable".into(),
            checked_at: now,
        }
    } else {
        if response.status() == reqwest::StatusCode::FORBIDDEN
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err("更新检查暂受限，请稍后重试或查看发行页面".into());
        }
        if !response.status().is_success() {
            return Err("发行服务暂不可用，请稍后重试".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "发行信息读取失败")? {
            if body.len() + chunk.len() > 1024 * 1024 {
                return Err("发行信息超出读取限制".into());
            }
            body.extend_from_slice(&chunk);
        }
        compare_release(current, &body, now)?
    };
    *cached = Some(result.clone());
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false}))
            .unwrap()
    }
    #[test]
    fn 版本按数字比较_当前开发版领先不误报最新() {
        assert_eq!(
            compare_release("1.9.0", &release("v1.10.0"), 1)
                .unwrap()
                .state,
            "available"
        );
        assert_eq!(
            compare_release("1.3.0", &release("1.3.0"), 1)
                .unwrap()
                .state,
            "current"
        );
        assert_eq!(
            compare_release("1.3.0+local", &release("v1.3.0+public"), 1)
                .unwrap()
                .state,
            "current"
        );
        assert_eq!(
            compare_release("1.3.0", &release("v1.2.3"), 1)
                .unwrap()
                .state,
            "ahead"
        );
    }
    #[test]
    fn 预发行草稿和异常元数据不当正式更新() {
        assert!(compare_release("1.3.0", &release("v2.0.0-beta.1"), 1).is_err());
        assert!(compare_release(
            "1.3.0",
            br#"{"tag_name":"v2.0.0","draft":true,"prerelease":false}"#,
            1
        )
        .is_err());
        assert!(compare_release("1.3.0", &release("javascript:evil"), 1).is_err());
        assert!(compare_release("1.3.0", b"{}", 1).is_err());
    }
}
