//! IPC 错误契约。前端按稳定 code 判定状态，message 只负责展示。
//!
//! 评审 P2：原先 `CommandError::new` 靠匹配中文字符串（"未配置"/"取消"/"无效"…）
//! 来分类，改一句文案就会悄悄改变重试策略。现在由**产生错误的一方**给出稳定 kind，
//! 字符串兜底只保留给尚未迁移的老调用点，且集中在 `legacy_code` 一处。

use serde::{Deserialize, Serialize};

/// 稳定的错误种类。序列化成前端已有的 `code` 值，避免两端契约漂移。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 本地配置无法读取；不能误判为平台凭据拒绝。
    ConfigReadError,
    /// 尚未配置凭据。
    NotConfigured,
    /// 凭据被明确拒绝（401/403）。
    CredentialsInvalid,
    /// 操作被取消或被更新的操作替代。
    Cancelled,
    /// 平台限流。
    RateLimited,
    /// 凭据加密/存储不可用。
    EncryptionUnavailable,
    /// 上游返回的数据结构或数值不可用。
    InvalidData,
    /// 网络或服务端暂时不可用。
    Unavailable,
    /// 未分类。
    Unknown,
}

impl ErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::ConfigReadError => "config_read_error",
            ErrorKind::NotConfigured => "not_configured",
            ErrorKind::CredentialsInvalid => "credentials_invalid",
            ErrorKind::Cancelled => "cancelled",
            ErrorKind::RateLimited => "rate_limited",
            ErrorKind::EncryptionUnavailable => "encryption_unavailable",
            ErrorKind::InvalidData => "invalid_data",
            ErrorKind::Unavailable => "unavailable",
            ErrorKind::Unknown => "unknown",
        }
    }

    /// 只有「稍后重试可能成功」的错误才允许退避重试。
    pub fn retryable(self) -> bool {
        matches!(self, ErrorKind::RateLimited | ErrorKind::Unavailable)
    }
}

/// 尚未迁移到 `ErrorKind` 的调用点的兜底分类。
///
/// 这里保留字符串匹配是为了不一次性改动全部调用方；新代码应当直接用
/// `CommandError::kind(...)` 显式指定，不要依赖文案。
fn legacy_code(message: &str) -> ErrorKind {
    if message.contains("未配置") {
        ErrorKind::NotConfigured
    } else if message.contains("取消") || message.contains("替代") {
        ErrorKind::Cancelled
    } else if message.contains("无效") || message.contains("过期") || message.contains("拒绝访问")
    {
        ErrorKind::CredentialsInvalid
    } else if message.contains("过于频繁") {
        ErrorKind::RateLimited
    } else if message.contains("加密") {
        ErrorKind::EncryptionUnavailable
    } else if ["解析", "非法", "统计口径", "超出范围"]
        .iter()
        .any(|s| message.contains(s))
    {
        ErrorKind::InvalidData
    } else if ["网络", "请求失败", "服务器", "暂时"]
        .iter()
        .any(|s| message.contains(s))
    {
        ErrorKind::Unavailable
    } else {
        ErrorKind::Unknown
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub credential: Option<&'static str>,
    pub retryable: bool,
}
impl CommandError {
    /// 显式指定错误种类；新代码应优先用这个构造器。
    pub fn kind(message: String, kind: ErrorKind, credential: Option<&'static str>) -> Self {
        Self {
            code: kind.code(),
            message,
            credential,
            retryable: kind.retryable(),
        }
    }

    /// 兼容构造器：按文案推断种类。迁移完成后可移除。
    pub fn new(message: String, credential: Option<&'static str>) -> Self {
        let kind = legacy_code(&message);
        Self::kind(message, kind, credential)
    }
}
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self::new(message, None)
    }
}
impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 凭据缺失与网络故障区分_序列化保留稳定状态码() {
        let error = CommandError::new("未配置用量 Token".into(), Some("usage_token"));
        assert_eq!(error.code, "not_configured");
        assert!(!error.retryable);
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json["credential"], "usage_token");
        assert!(CommandError::new("网络请求失败".into(), None).retryable);
    }

    #[test]
    fn 显式种类不依赖文案_改措辞不改重试策略() {
        // 同一句话用不同 kind 构造，得到的 code 与 retryable 完全不同。
        let missing = CommandError::kind(
            "用量 Token 不可用".into(),
            ErrorKind::NotConfigured,
            Some("usage_token"),
        );
        let limited = CommandError::kind(
            "用量 Token 不可用".into(),
            ErrorKind::RateLimited,
            Some("usage_token"),
        );
        assert_eq!(missing.code, "not_configured");
        assert!(!missing.retryable);
        assert_eq!(limited.code, "rate_limited");
        assert!(limited.retryable);

        // 把文案改成完全不含关键词的表述，分类保持不变。
        let renamed = CommandError::kind(
            "请先在设置页填写凭据".into(),
            ErrorKind::CredentialsInvalid,
            None,
        );
        assert_eq!(renamed.code, "credentials_invalid");
    }

    #[test]
    fn 只有限流与暂不可用可重试() {
        for kind in [
            ErrorKind::ConfigReadError,
            ErrorKind::NotConfigured,
            ErrorKind::CredentialsInvalid,
            ErrorKind::Cancelled,
            ErrorKind::EncryptionUnavailable,
            ErrorKind::InvalidData,
            ErrorKind::Unknown,
        ] {
            assert!(!kind.retryable(), "{kind:?}");
        }
        assert!(ErrorKind::RateLimited.retryable());
        assert!(ErrorKind::Unavailable.retryable());
    }

    #[test]
    fn 每个种类都有稳定的序列化值() {
        for (kind, code) in [
            (ErrorKind::ConfigReadError, "config_read_error"),
            (ErrorKind::NotConfigured, "not_configured"),
            (ErrorKind::CredentialsInvalid, "credentials_invalid"),
            (ErrorKind::Cancelled, "cancelled"),
            (ErrorKind::RateLimited, "rate_limited"),
            (ErrorKind::EncryptionUnavailable, "encryption_unavailable"),
            (ErrorKind::InvalidData, "invalid_data"),
            (ErrorKind::Unavailable, "unavailable"),
            (ErrorKind::Unknown, "unknown"),
        ] {
            assert_eq!(kind.code(), code);
            assert_eq!(serde_json::to_value(kind).unwrap(), serde_json::json!(code));
        }
    }
}
