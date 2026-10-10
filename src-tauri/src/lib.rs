pub mod alerts;
pub mod autostart;
pub mod browsing_data;
pub mod cache_watch;
pub mod commands;
pub mod config;
pub mod credentials;
pub mod deepseek_api;
pub mod desktop;
pub mod error;
pub mod http;
pub mod local_archive;
pub mod local_background;
pub mod local_retention;
pub mod local_sources;
pub mod local_usage;
pub mod sync_script;
pub mod sync_session;
pub mod token_sync;
pub mod tray;
pub mod update_check;
pub mod usage;
pub mod usage_history;
pub mod usage_watcher;
pub mod window_pos;
pub mod zcode_usage;

#[cfg(test)]
mod test_support;

// 命令层在 commands（含权限校验），托盘与显隐在 tray，登录同步在 usage_watcher，
// HTTP 客户端在 http，开机自启在 autostart，面板几何在 window_pos。
// 本文件只做进程装配：插件、共享状态、命令注册、托盘初始化。

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例守卫：必须作为第一个注册的插件。
        // 程序已运行时再次启动 exe，第二个进程不会新开窗口，
        // 而是触发此回调把已有主窗口显示并聚焦，随后第二个进程自行退出。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                tray::show_main_window(&window);
            }
        }))
        .manage(sync_session::SyncSession::default())
        .manage(sync_session::ApiKeySession::default())
        .manage(local_usage::LocalCollector::default())
        .manage(local_background::Runtime::default())
        .manage(desktop::DesktopState::default())
        .manage(update_check::UpdateCache::default())
        .manage(alerts::AlertRuntime::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, key, event| {
                    if key == &desktop::shortcut()
                        && event.state == tauri_plugin_global_shortcut::ShortcutState::Released
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = tray::hide_main_window_inner(&window);
                            } else {
                                tray::show_main_window(&window);
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::hide_main_window,
            commands::is_main_window_visible,
            commands::get_app_config,
            commands::get_diagnostics,
            commands::open_support_page,
            commands::check_app_release,
            commands::get_desktop_options,
            commands::set_desktop_options,
            commands::begin_tray_balance_session,
            commands::update_tray_balance,
            commands::get_alert_status,
            commands::save_alert_options,
            commands::test_alert_notification,
            commands::get_local_usage,
            commands::set_local_usage_enabled,
            commands::scan_local_usage,
            commands::get_local_background,
            commands::set_local_background,
            commands::save_local_archive,
            commands::list_local_archives,
            commands::read_local_archive,
            commands::delete_local_archive,
            commands::clear_local_archives,
            commands::get_local_retention_enabled,
            commands::set_local_retention_enabled,
            commands::list_local_retention,
            commands::read_local_retention,
            commands::delete_local_retention,
            commands::clear_local_retention,
            commands::get_local_sources,
            commands::save_local_sources,
            commands::list_running_wsl,
            commands::save_api_key,
            commands::clear_api_key,
            commands::save_refresh_interval,
            commands::save_auto_refresh_enabled,
            commands::save_autostart,
            commands::fetch_balance,
            commands::save_usage_token,
            commands::clear_usage_token,
            commands::fetch_usage,
            commands::start_usage_sync,
            commands::cancel_usage_sync,
            commands::forget_usage_session,
            commands::usage_token_captured
        ])
        .setup(|app| {
            // 日志在 debug 与 release 都要注册。代码里的 log::warn!（未知模型名、
            // 未归类 token 类型、配置损坏、同步失败原因）在用户机器上必须真正落盘，
            // 否则排障只能靠复现。默认 target 含 LogDir，落盘位置为 app_log_dir()，
            // Windows 下即 %LOCALAPPDATA%\com.deepseek.monitor.windows\logs。
            // release 只记 Warn 及以上，避免常规路径刷日志。
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Info
                    } else {
                        log::LevelFilter::Warn
                    })
                    .build(),
            )?;

            // 启动时恢复主面板上次停留的位置；从未记录过（首次运行）则保持
            // 系统默认位置，不主动贴靠托盘
            if let Some(window) = app.get_webview_window("main") {
                tray::restore_saved_position(&window);
            }

            tray::build_tray(app)?;
            desktop::restore(app.handle());
            alerts::start(app.handle().clone());
            local_background::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
