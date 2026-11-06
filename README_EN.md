<div align="center">
  <img src="public/assets/deepseek-color.png" width="64" height="64" alt="DeepSeek Monitor icon" />
  <h1>DeepSeek Monitor Windows</h1>
  <p>
    <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-2563eb?style=flat-square" alt="Windows 10 / 11" />
    <img src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT License" />
  </p>
  <p>
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest">Published releases</a> ·
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWindows/issues">Report an issue</a> ·
    <a href="README.md">简体中文</a> / <a href="README_EN.md">English</a>
  </p>
</div>

DeepSeek balance and platform usage in the Windows system tray. Open a compact panel to check credit, spending, model tokens, cache details and usage history.

**This is an unofficial project, not affiliated with DeepSeek.** Built for Windows 10 / 11 with Tauri 2, React 18 and Rust.

## Status: 1.3.1 is unreleased and awaiting acceptance

Version 1.3.1 is under repair and review. The current source focuses on DeepSeek accounts, platform usage and history; multi-tool agent statistics have been removed. This README describes the current source, not features already available in published installers.

No compilation, test execution, installer build or Windows acceptance testing was performed for this refocus. The maintainer will compile and test locally. Previous-version test results do not establish that 1.3.1 passes. Use the actual assets and release notes on [GitHub Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest) for published versions.

- [1.3.1 upgrade and old-data notes](docs/UPGRADE_1.3.1.md)
- [1.3.1 local acceptance checklist](docs/ACCEPTANCE_1.3.1.md)
- [Changelog](CHANGELOG.md)

Old screenshots show removed controls and are no longer used in this README. New 1.3.1 screenshots will need to be captured after local acceptance.

## Scope

- DeepSeek account balance, availability and last successful query time.
- Platform-reported spending, request counts, model tokens and cache details.
- Platform usage history with original model IDs and manual CSV / JSON exports.
- Tray controls, light/dark themes, transparency, always-on-top, a visibility shortcut and optional balance/budget reminders.

The app no longer provides other tools' project/session statistics, directory scanning, WSL sources, background collection, snapshots or automatic retention. Existing files remain on the user's computer and are not automatically deleted. See the upgrade notes for the boundary.

## Two data sources, two credentials

| Data | Source | Credential | Limitation |
| --- | --- | --- | --- |
| Account balance | Official public DeepSeek API: `https://api.deepseek.com/user/balance` | DeepSeek API key | Does not supply the account usage history used by this app |
| Tokens, requests, spending and history | Internal platform web endpoints: `https://platform.deepseek.com/api/v0/usage/amount` and `/api/v0/usage/cost` | Platform web-session token | Not a stable public API; sessions expire and paths, fields or authentication may change |

The API key and usage token **are not interchangeable**. Either feature can be configured independently. The app does not automatically verify that both credentials belong to the same account; check that yourself.

An official balance endpoint does not make the usage endpoints public APIs. Usage comes from platform responses, not other tools' local logs or estimates based on balance differences. The DeepSeek platform bill remains authoritative.

## Install and get started

### Install

Download a published Windows x64 installer from [Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest). There is no accepted 1.3.1 release installer yet.

Windows 10 / 11 and Microsoft Edge WebView2 Runtime are required. Install WebView2 first if it is missing.

### Balance only

1. Open **API Key** in Settings.
2. Enter a key created on the DeepSeek platform.
3. Select **验证并保存** to validate and save it, then query the balance.

Web sign-in is not needed for balance queries.

### Platform spending and history

1. Open **用量同步 Token** in Settings.
2. Select **网页登录自动同步** and sign in through the DeepSeek login window.
3. The app captures the session token from requests in that window, validates it against the usage endpoint, then saves it and refreshes usage.

You can cancel while waiting. Canceling or closing the window should allow a new attempt. Tokens expire and must then be synchronized again. This flow uses only the DeepSeek platform session; it does not need credentials for other tools.

As a fallback, expand **方式二：手动粘贴 token**. In the developer-tools Console of your signed-in `platform.deepseek.com` tab, inspect:

```js
JSON.parse(localStorage.userToken).value
```

Run this only on your own DeepSeek page. Paste the result into the app, not into an issue, chat or log attachment. If the key is absent, the platform may have changed its sign-in implementation; do not treat an unknown value as a valid token.

## Daily use and data meaning

- Closing the panel hides it to the tray. Choose **退出** in the tray menu to quit. Left-click the tray icon to show or hide the panel.
- Balance and usage refresh independently and have separate states. Network failures may preserve clearly marked stale data; invalid credentials require reconfiguration. Missing, invalid or unqueried values must not be treated as zero.
- Platform dates and months follow UTC+8. Last-update timestamps use the computer's local time. A previous-month snapshot must not continue to be labeled as the current month.
- The dashboard groups models; history preserves original platform model IDs. Current mappings live in `model_slot()` in `src-tauri/src/usage.rs`. Unmapped models receive a fallback display rather than silently disappearing.
- Invalid or missing costs, tokens and request counts remain unknown. Explicit valid zero values remain zero. Missing cost does not mean free usage and cannot support a tokens-per-yuan calculation.
- The pricing-period badge is a rule hint, not a replacement for current platform pricing or actual bills.
- Panel auto-refresh defaults to off and pauses when hidden. Enabled balance/budget reminders have independent checks, described below.
- Settings cover theme, transparency, autostart, always-on-top and a visibility shortcut. The shortcut defaults to off; conflicts should produce a visible error.
- Update checks are manual requests to GitHub release metadata. The app does not automatically download or install an update.

### History and exports

Use **历史** to query this month, last month, the last 30 days, a selected month or all history. All-history queries load in batches and can be continued or stopped. Platform retention and availability are not guaranteed. Unloaded or missing months do not mean zero usage.

Successful months should remain available after failures. Resolve authentication or rate-limit errors first; individual failed months can be retried with **只重试失败月份**. History caches are tied to the usage session. Changing or clearing the token must invalidate old caches and late responses so they cannot enter another account's view.

CSV exports daily records inside the selected range. JSON range summaries use the same daily records; original full-month responses are kept separately as `sourceMonthlySnapshots`, with their coverage stated. Exports exclude API keys, session tokens and cookies, but still contain account spending information. Choose carefully where to store or share them.

### Balance and budget reminders

The master reminder switch defaults to off. Once enabled and saved, reminders check independently while the app is in the tray; quitting stops them. Low-balance rules support CNY only. Budget rules use platform spending for the current month; they notify but cannot restrict spending.

Rules require valid, fresh responses. Missing data or invalid credentials cannot establish that a budget has been exceeded. Quiet hours default to 22:00–08:00 in the computer's local time. Windows notification settings may still suppress a notice. Submitted to the system does not mean seen by the user.

## Credentials and old data

The API key and usage token are stored in:

```text
%APPDATA%\DeepSeekMonitorWindows\config.json
```

On Windows, credentials use DPAPI encryption tied to the current Windows user and machine. Copying the file elsewhere may make them undecryptable and require reconfiguration. This does not protect against malicious software running as that user. Do not upload or share the configuration file.

- **清除 Key** removes the stored API key only.
- **清除 Token** removes the stored usage token but keeps the web sign-in session.
- **退出并忘记账户** removes this app's usage token and web sign-in data, while preserving the API key and other settings.
- None of these operations automatically removes old `config.json.corrupt-*` backups, manual copies or old agent data. Historical backups may contain plaintext credentials and need separate, careful handling by the user.

A corrupt configuration or invalid encoding produces an error and leaves the original file intact, without creating a new ordinary backup or silently resetting settings. Safely repair or move the file before retrying; do not upload it for troubleshooting. Legacy plaintext credentials still have an encryption migration path. A failed write is reported and must not be mistaken for completed encryption on disk.

Web sign-in data normally lives under `%LOCALAPPDATA%\com.deepseek.monitor.windows\EBWebView`. DeepSeek login and token synchronization still use this app's web sign-in data. This is separate from the removed multi-tool collector.

The current source no longer reads, scans, migrates or uploads old agent collection settings, caches, snapshots or retained records. It does not automatically delete those files or original tool logs. Removing the feature does not mean those files have been erased.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Balance works but usage fails | The credentials are separate. Resynchronize the usage token and check for rate limits or changes to the internal platform endpoints |
| Balance fails | Check the API key, network and balance error. A web-session token cannot replace the API key |
| Missing history months or a cost shown as “—” | Check the selected range and data notices. Missing platform data is not zero |
| Login synchronization keeps waiting | Cancel and retry, or paste a valid token manually. Avoid repeatedly starting concurrent attempts |
| No balance in the tray | There may be no successful snapshot or the credentials may be invalid. A value retained after an ordinary network failure should be marked stale |
| Agent page is gone after upgrading | The feature was removed. Existing files were not automatically deleted; see the upgrade notes |

When reporting issues, include the version, reproduction steps, expected result and actual result. Redact account information. Do not attach API keys, tokens, cookies, original configuration files or unchecked logs.

## Development and acceptance

The source requires Node.js 22.6+, npm, Rust 1.88+, Windows MSVC and Visual Studio Build Tools 2022 with Desktop development with C++. These are commands for local execution, **not evidence that they were run or passed for this change**:

```powershell
npm ci
npm run tauri:dev
npm run check:version
npm test
npm run test:components
npm run lint
npm run build
npm run tauri:check
npm run verify
npm run tauri:build
```

`verify` requires PowerShell 7+. The current scripts define its exact steps. The source no longer downloads or bundles a multi-tool statistics engine. After building an installer, use the [acceptance checklist](docs/ACCEPTANCE_1.3.1.md) to check installation, upgrades, tray behavior, login, credentials and data boundaries. Static review, old-version test results or matching version numbers cannot replace that acceptance.

The Rust release gate requires complete mandatory coverage on a Windows host. Non-Windows development runs are explicitly `NOT RUN`, never release passes. See the [release gate evidence guide](docs/RELEASE_GATES_1.3.1.md) for required tests, counts and recording commands.

`src/` contains the frontend, `src-tauri/src/` the backend, `scripts/` local verification/release tools, and `docs/` upgrade/acceptance notes. Requests live in `deepseek_api.rs`; usage rules in `usage.rs` / `usage_history.rs`; login synchronization in `token_sync.rs` / `sync_session.rs`; credentials and configuration in `credentials.rs` / `config.rs`.

## Origin, license and disclaimer

This project directly continues the Windows code baseline of [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows), following the product concept and visual direction of the earlier macOS project [JayHome137/DeepSeekMonitor](https://github.com/JayHome137/DeepSeekMonitor). Thanks to both upstream authors and their contributors.

This repository maintains DeepSeek compatibility, accounting logic and the Windows experience on that baseline. Narrowing the feature scope does not change its attribution.

Licensed under MIT. See [LICENSE](LICENSE). Existing copyright and license notices are retained.

Follow DeepSeek's terms and use reasonable request frequencies. Platform pages, session behavior and internal usage endpoints may change without notice. Continued availability is not guaranteed. Displayed values are for reference; DeepSeek's platform is authoritative for balances, charges and prices.
