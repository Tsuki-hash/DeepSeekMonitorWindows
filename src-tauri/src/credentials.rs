//! 凭据加密（M-1）。
//!
//! 用 Windows DPAPI 的 `CryptProtectData` / `CryptUnprotectData` 保护 `config.json` 里的
//! 两类凭据（API Key 与网页登录 Token）。选择 DPAPI 而非 `keyring` crate 的理由：
//!
//! 1. **零新增依赖**——`windows` crate 已是 tauri 的传递依赖（经 tao / webview2-com），
//!    提为直接依赖不增加任何编译单元；`keyring` 会拉进一套新的 crate 生态。
//! 2. **存储位置不变**——密文仍留在 `config.json`，不需要第二个文件，也就没有
//!    「配置文件在、凭据库丢了」这类新的不一致状态。
//! 3. **凭据绑定当前用户 + 机器**，这正是我们要的威胁模型：防的是网盘同步、
//!    终端管理采集、恶意脚本批量读取，而不是本机同用户下的提权。
//!
//! 密文以带 DSM1 前缀的 base64 存放，
//! 迁移靠 `CONFIG_SCHEMA_VERSION` 区分（见 `config.rs` 的读写路径）。
//!
//! 加密失败时拒绝写入凭据，保留旧配置；解密失败则提示重新配置。

use base64::Engine;

/// 密文前缀。用于把「DPAPI 密文」与「用户手工填进配置里的明文」区分开——
/// 后者在迁移期是合法输入，不能当成损坏数据。（DPAPI 密文是二进制，base64 后
/// 不可能是这个前缀，因为 `DSM1:` 含 `:`，不在标准 base64 字母表内。）
const CIPHER_PREFIX: &str = "DSM1:";

/// 加密一个凭据字段。返回带前缀的 base64 密文。
///
/// 失败时返回 `None`，调用方拒绝保存，禁止回退明文。
pub fn encrypt(plaintext: &str) -> Option<String> {
    let cipher = platform::protect(plaintext.as_bytes())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&cipher);
    Some(format!("{CIPHER_PREFIX}{encoded}"))
}

/// 解密一个凭据字段。
///
/// 返回 `Some` 表示「这是一个密文字段且解开了」；返回 `None` 表示
/// 「不是密文格式」（调用方应当把它当明文用，这是迁移期与手工编辑的正常情况）。
/// 密文格式但解不开时返回 `Some(Err(..))`，交由调用方告警。
pub fn decrypt(stored: &str) -> Option<Result<String, String>> {
    let encoded = stored.strip_prefix(CIPHER_PREFIX)?;
    let cipher = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) => bytes,
        Err(error) => return Some(Err(format!("密文不是合法 base64：{error}"))),
    };
    Some(match platform::unprotect(&cipher) {
        Some(bytes) => {
            String::from_utf8(bytes).map_err(|error| format!("明文不是合法 UTF-8：{error}"))
        }
        None => Err("DPAPI 解密失败（凭据可能来自另一台机器或另一个用户）".to_string()),
    })
}

/// 是否为本模块产出的密文格式。
pub fn is_ciphertext(stored: &str) -> bool {
    stored.starts_with(CIPHER_PREFIX)
}

#[cfg(windows)]
mod platform {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    /// 附加熵。增加一点「必须知道这是哪个应用的凭据」的绑定强度。
    const ENTROPY: &[u8] = b"DeepSeekMonitorWindows/config";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// 把 DPAPI 返回的堆内存拷进 Vec 后释放。DPAPI 用 LocalAlloc 分配，
    /// 必须用 LocalFree 归还，不能交给 Rust 的分配器。
    unsafe fn take_blob(out: &CRYPT_INTEGER_BLOB) -> Option<Vec<u8>> {
        if out.pbData.is_null() {
            return None;
        }
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let owned = slice.to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut std::ffi::c_void)));
        Some(owned)
    }

    pub fn protect(plaintext: &[u8]) -> Option<Vec<u8>> {
        let input = blob(plaintext);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // CRYPTPROTECT_UI_FORBIDDEN：后台同步路径上不能弹任何 UI。
        let ok = unsafe {
            CryptProtectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok.is_err() {
            return None;
        }
        unsafe { take_blob(&output) }
    }

    pub fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
        let input = blob(cipher);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok.is_err() {
            return None;
        }
        unsafe { take_blob(&output) }
    }
}

/// 非 Windows：无 DPAPI，直接不做加密（返回 None，调用方回退明文）。
#[cfg(not(windows))]
mod platform {
    pub fn protect(_plaintext: &[u8]) -> Option<Vec<u8>> {
        None
    }

    pub fn unprotect(_cipher: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 是否在 Windows 上运行。
    ///
    /// 复评 F16：原实现用 `cfg!(windows) && encrypt("probe").is_some()` 决定是否跳过，
    /// 于是 Windows 上 DPAPI 真的坏掉时测试会「静默 return」，测试框架仍记为通过。
    /// 现在区分两件事：平台是否支持（编译期决定），以及加密是否真的可用（必须断言）。
    fn on_windows() -> bool {
        cfg!(windows)
    }

    /// 非 Windows 平台明确跳过，并在测试名里体现「未在真实加密环境验证」。
    macro_rules! require_windows {
        () => {
            if !on_windows() {
                eprintln!("跳过：DPAPI 仅在 Windows 可用，本测试未验证真实加密");
                return;
            }
        };
    }

    #[test]
    fn 密文带前缀_明文不带() {
        require_windows!();
        // Windows 上加密必须真的可用：失败即测试失败，不允许静默通过。
        assert!(
            encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用：安全存储无法工作，测试必须失败而不是跳过"
        );
        let cipher = encrypt("sk-secret").unwrap();
        assert!(is_ciphertext(&cipher));
        assert!(!is_ciphertext("sk-secret"));
        assert!(!is_ciphertext(""));
    }

    #[test]
    fn 加密后能原样解回() {
        require_windows!();
        // Windows 上加密必须真的可用：失败即测试失败，不允许静默通过。
        assert!(
            encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用：安全存储无法工作，测试必须失败而不是跳过"
        );
        for plain in ["sk-abcdefghijklmnop", "含中文的凭据", "", "a"] {
            let cipher = encrypt(plain).unwrap();
            let back = decrypt(&cipher).unwrap().unwrap();
            assert_eq!(back, plain, "往返应一致：{plain}");
        }
    }

    #[test]
    fn 密文里不出现明文() {
        require_windows!();
        // Windows 上加密必须真的可用：失败即测试失败，不允许静默通过。
        assert!(
            encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用：安全存储无法工作，测试必须失败而不是跳过"
        );
        let plain = "sk-verysecretvalue123456";
        let cipher = encrypt(plain).unwrap();
        assert!(!cipher.contains(plain), "密文不应包含明文");
    }

    #[test]
    fn 同一明文两次加密_密文不同() {
        require_windows!();
        // Windows 上加密必须真的可用：失败即测试失败，不允许静默通过。
        assert!(
            encrypt("probe").is_some(),
            "Windows 上 DPAPI 不可用：安全存储无法工作，测试必须失败而不是跳过"
        );
        // DPAPI 每次调用使用新的随机会话密钥，因此密文必然不同。
        // 这也意味着不能靠比较密文判断凭据是否变化。
        let a = encrypt("sk-same").unwrap();
        let b = encrypt("sk-same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn 非密文格式_返回_none() {
        assert!(decrypt("sk-plaintext-key").is_none());
        assert!(decrypt("").is_none());
        // 前缀相似但不对
        assert!(decrypt("DSM2:AAAA").is_none());
    }

    #[test]
    fn 前缀正确但内容损坏_返回错误而非恐慌() {
        let broken = format!("{CIPHER_PREFIX}这不是合法-base64!!");
        let result = decrypt(&broken);
        assert!(matches!(result, Some(Err(_))), "损坏密文应返回 Err");
    }

    #[test]
    fn 解不开的密文_不恐慌() {
        // 合法 base64 但不是本机 DPAPI 产出的密文——模拟「配置从别的机器拷来」
        let foreign = format!("{CIPHER_PREFIX}AAAA");
        let result = decrypt(&foreign);
        assert!(
            matches!(result, Some(Err(_))),
            "异机密文应返回 Err 而非 panic"
        );
    }
}
