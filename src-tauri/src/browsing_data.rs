//! 等 WebView2 真正清理完成后再允许登录；不把发起请求当成清理成功。
use crate::sync_session::SyncSession;
use tauri::{Emitter, Manager, WebviewWindow};

#[cfg(windows)]
pub async fn clear(window: &WebviewWindow) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile2, ICoreWebView2_13},
    };
    use windows::core::Interface;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let app = window.app_handle().clone();
    let fallback_app = app.clone();
    let dispatch = window.with_webview(move |webview| {
        let callback_sender = sender.clone();
        let callback_app = app.clone();
        let result: windows::core::Result<()> = unsafe {
            (|| {
                let profile = webview
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile2>()?;
                profile.ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(Box::new(
                    move |status| {
                        callback_app.state::<SyncSession>().finish_clear();
                        // This unowned event also fires on failure and after a
                        // timeout. It only restores appearance preferences; it
                        // must never clear the durable privacy marker or claim
                        // success. The owning command checks `status` below.
                        let _ = callback_app.emit("browsing-data-cleared", ());
                        if let Some(tx) = callback_sender
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take()
                        {
                            let _ =
                                tx.send(status.map_err(|e| format!("清理网页登录数据失败：{e}")));
                        }
                        Ok(())
                    },
                )))
            })()
        };
        if let Err(error) = result {
            app.state::<SyncSession>().finish_clear();
            if let Some(tx) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(Err(format!("无法清理网页登录数据：{error}")));
            }
        }
    });
    if let Err(error) = dispatch {
        fallback_app.state::<SyncSession>().finish_clear();
        return Err(error.to_string());
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("网页登录数据清理未收到完成回执，请重启应用后重试".into()),
        // 超时后不能允许新登录，旧清理仍可能完成；锁由完成回调释放。
        Err(_) => Err("监控 Token 已清除，网页登录数据仍在清理；完成前无法重新同步".into()),
    }
}

#[cfg(not(windows))]
pub async fn clear(window: &WebviewWindow) -> Result<(), String> {
    window.app_handle().state::<SyncSession>().finish_clear();
    Err("会话清理仅支持 Windows".into())
}
