<div align="center">
  <img src="public/assets/deepseek-color.png" width="64" height="64" alt="DeepSeek Monitor icon" />
  <h1>DeepSeek Monitor Windows</h1>
  <p>
    <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-2563eb?style=flat-square" alt="Windows 10 / 11" />
    <img src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT License" />
  </p>
  <p>
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWin/releases/latest">Download</a> ·
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWin/issues">Feedback</a> ·
    <a href="README.md">简体中文</a> / <a href="README_EN.md">English</a>
  </p>
</div>

A small panel that pins your DeepSeek balance and usage to the Windows system tray. One click on the icon shows how much credit is left, what you spent today and this month, and how each model is consuming tokens and cache.

Windows 10 / 11 only. Built with Tauri 2, React 18, and Rust.

**This project is not an official DeepSeek product and is not affiliated with DeepSeek.**

The current source adds persistent Account / Agent / History navigation. Open Agent directly for projects and sessions; exports and archives live under Data, and collection controls under Collection settings. Version 1.3.0 includes adjustable transparency, full history, trend readings, and collapsed zero-usage models. Download it from [GitHub Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWin/releases/tag/v1.3.0).

## Screenshots

The 1.3.0 installer was updated on 2026-10-10 with this feature set and UI changes.

| Dark skin | Light skin |
| :---: | :---: |
| <img src="screenshots/dashboard-dark.png" width="330" alt="DeepSeek Monitor Windows dashboard, dark skin"> | <img src="screenshots/dashboard-light.png" width="330" alt="DeepSeek Monitor Windows dashboard, light skin"> |

<details>
<summary>View model details</summary>

<img src="screenshots/detail-dark.png" width="330" alt="Model details: monthly metrics and the last seven days">

</details>

<details>
<summary>View usage history</summary>

<img src="screenshots/history-light.png" width="330" alt="Usage history: period queries, original model details and manual export">

<img src="screenshots/local-usage-light.png" width="330" alt="Local agent usage: projects, sessions and generation speed">

</details>

*These screenshots show the local, unreleased 1.3.0 build with sample data, not a real account. Final model names will be checked when the model launches.*

<details>
<summary>View balance and budget reminder settings</summary>

<img src="screenshots/alerts-settings-light.png" width="330" alt="View balance and budget reminder settings">

</details>

## Why this exists

DeepSeek only publishes a balance endpoint. There is no account-level usage API. The usage page on the web console shows spending, but not a per-model breakdown of cache hits, cache misses, and output — and it cannot sit on your desktop for a glance.

This project combines three things:

- **Balance** — calls `/user/balance` directly with your official API key.
- **Usage** — reuses a usage token derived from a web login session to call the platform's internal endpoints, retrieving monthly spending, total tokens, request count, and cache detail.
- **Presentation** — merges both into a narrow tray-resident panel that stays off the taskbar.

## Install and get started

### Install

Download the latest published `x64-setup.exe` installer from [Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWin/releases/latest). Installing over an older version does not require uninstalling it first.

Requirements: Windows 10 or Windows 11, plus the Microsoft Edge WebView2 Runtime (included with Windows 11; install separately on Windows 10 if missing).

### Set your API key

Open the dashboard → Settings in the top right → the `API Key` section. Paste your key (created on the API Keys page of the DeepSeek platform) and click **验证并保存** (Validate and save). Once it validates, the Settings page shows your current balance and the dashboard starts refreshing.

### Sync usage

Usage needs a second credential. See "Two credentials, don't mix them" below.

### Day-to-day use

- The close button in the top right **hides the panel to the tray**; it does not quit.
- Left-click the tray icon: show or hide the panel.
- Right-click the tray icon to show the dashboard, see the last queried balance, or quit. Hover also shows the last successful balance; failed refreshes mark it as old data. Missing data or invalid credentials hide the amount. Hiding the panel does not trigger extra queries for the tray.
- Under **外观 → 桌面快捷操作**, optionally keep the panel on top or use **Ctrl + Alt + D** to show/hide it. Both default to off. Shortcut conflicts and save failures show an error and restore the previous settings.
- **关于 → 帮助与诊断 → 检查更新** compares against the latest official GitHub release, distinguishing a new release, the current release and a development version ahead of the published version. **查看发行页面** opens the release page separately. Checking is manual; no update is downloaded or installed automatically.
- Model rows show the current month; the chart shows the last seven days, including today, using UTC+8 accounting dates.
- The small “峰” (peak, muted amber) / “谷” (off-peak, muted teal) badge beside the balance update time follows Beijing time. Click for the next transition and rules; off-peak prices are half of peak prices. Holiday exclusions use the full published 2026 State Council holiday ranges, while make-up weekends remain off-peak. Potential peak windows in uncovered years show “—” pending calendar verification. This is a rule-based indication; actual charges follow the platform bill.
- Balance and usage have separate update times displayed in the computer's local time zone. Usage failures preserve successful data from the same accounting month. Previous-month totals are hidden after a month change, and new dates without fetched data remain unknown. Details and retry or synchronization actions are available.
- Hover to preview daily data, click to pin it, or use Tab and Enter / Space. Esc dismisses details, which appear below the chart.

## Two credentials, don't mix them

This is the most common pitfall: balance and usage are **not** queried with the same thing.

|  | API key | Usage token |
| --- | --- | --- |
| Where it comes from | DeepSeek platform → API Keys page | Session token after signing in to platform.deepseek.com |
| What it is for | Account balance | Usage and spending |
| Interchangeable | No | No |

**Why usage needs a token**: DeepSeek publishes no account-level usage API, so the app reuses the same endpoints the web console calls, which requires your login session. The token is a session credential — as sensitive as the API key, and it expires.

### Method 1: automatic sync through web login

In the `用量同步 Token` section of Settings, click **网页登录自动同步** (Sync via web login) and sign in through the DeepSeek login window that opens.

The app hooks the network requests the page makes, reads the Bearer token straight out of the `Authorization` header, verifies that it can actually call the usage endpoint, and only then saves it and refreshes the data.

> Sign-in can take time. Use Cancel Sync to stop waiting. Tokens are saved only after validation; cancelled requests cannot save credentials later.
### Method 2: paste it manually (fallback)

Click **方式二：手动粘贴 token** to expand. Sign in to platform.deepseek.com in a browser, press F12 to open DevTools, **switch to the Console tab**, and run at the `❯` prompt:

```js
JSON.parse(localStorage.userToken).value
```

Copy the returned string, paste it into the field, and click **保存 Token**.

If it returns `undefined` (the platform may have renamed the storage key), run this instead to list candidate keys and copy the token-looking value from the result:

```js
Object.entries(localStorage).filter(([k]) => /token/i.test(k))
```

**The usage token expires. When usage stops loading, just sync it again.**

## Model naming and billing

DeepSeek launched V4.1 Flash on 2026-09-10 and renamed the model from `deepseek-v4-flash` to `deepseek-flash`. There is a catch: **the old model names were not disabled — they were routed to the new model for compatibility**, so during the transition a single billing period can contain both old and new names. Here is how this project handles it:

| `model` returned by the platform | Which row it lands in |
| --- | --- |
| `deepseek-flash` | V4.1 Flash |
| `deepseek-v4-flash` | V4.1 Flash (**summed**) |
| `deepseek-v4-flash-vision-exp` | V4.1 Flash (**summed**) |
| `deepseek-v4-pro` | V4 Pro |

Names that map to the same row are **summed, not overwritten** — otherwise, whenever old and new names coexist, part of the usage would be silently dropped with no visible sign in the interface.

Two more things worth knowing:

- **V4 Pro is available.** Tracked separately from V4.1 Flash, with its own tokens, cost, and cache stats.
- **Unclassified tokens are counted anyway.** V4.1 Flash takes image input natively. If the platform reports a token type this project has not classified yet, those tokens are still counted in the total and shown as 其他（未归类） in the charts, rather than being silently dropped.
- **Models that are not mapped yet get a fallback row.** If the platform reports a model name this project has not mapped yet (for example right after a new model launches), its usage is aggregated into an 其他 row (tokens, cost and request count summed) instead of disappearing. Official mapping for new models still goes through `model_slot()`.

## What the numbers on screen mean

### Dashboard

| Where | Meaning |
| --- | --- |
| Account balance | Total credit from the official `/user/balance` endpoint, including granted and topped-up amounts |
| Today / This month | Spending fields from the platform usage endpoint |
| Model rows | That model's token total and cost this month, plus tokens per yuan (T/¥); the line below is the cache hit rate |
| Cache detail chart | A 7-day stacked bar chart with three segments: input (cache hit), input (cache miss), and output |

### Detail page

Click any model row on the dashboard. It shows that model's request count, token total, and a per-day token breakdown.

### Usage history

Invalid platform token counts remain unknown with a data warning; valid zero counts remain zero.

Click **近7日 Tokens ›** on the dashboard to query the current month, previous month or last 30 days. Filter by original model ID, switch between token and cost trends, and expand request counts and cache breakdowns. The dashboard keeps its model groups; history lists aliases and unknown model IDs separately. Missing dates or fields remain unknown rather than becoming zero.

Manual exports include all models: CSV contains daily records within the selected range; JSON also contains complete summaries for the queried months, which can extend beyond a 30-day range. Exports exclude keys, tokens and cookies. CSV uses a UTF-8 BOM and protects against spreadsheet formula injection. Queries use an in-memory cache of up to four months with a five-minute lifetime; changing or clearing the usage session invalidates the cache and late responses.

Platform history retention is not guaranteed. Last-30-day totals only cover returned daily records.

### Local projects and sessions

Local CSV/JSON exports retain the actual statistics month and the computer's UTC offset at collection time. Missing metadata in older snapshots remains null. Saving a session from within a project includes only that project's session records.

The local page's **导出** disclosure exports CSV or JSON for all current records, the selected project or the selected session, preserving unknown values and collection time. Full project paths, internal row IDs, source session titles, conversation bodies and credentials are excluded by default. Paths require explicitly selecting **包含项目完整路径**. CSV uses a UTF-8 BOM and formula-injection protection. Source counts may include token estimates and are not billing evidence.

Open **项目与会话** from history and select **开启本地统计** to enable local statistics. Following [Token Monitor](https://github.com/Javis603/token-monitor), a pinned Tokscale engine reads native records from OpenCode, Claude Code, ZCode, Hermes, OpenClaw and DeepSeek Harness. Drill down from projects to sessions and inspect original model IDs, input/output/cache/reasoning counts. Missing project attribution or fields stay unknown. This version shows per-model session details for the current local month; individual request details remain pending; background collection is now an independent opt-in; standalone local ZCode databases are now supported.

Speed uses matched output tokens and generation duration. The initial read shows an average for timed records; subsequent performance-counter changes yield a recent tok/s sample. Polling time is never its denominator, and incomplete timing coverage stays unavailable. It updates from persisted records rather than measuring each streamed token.

Counting semantics depend on the tool and parser. For example, Tokscale estimates tokens from text in legacy ZCode logs without measured usage. This version cannot identify measured versus estimated counts per row, so local totals are not billing evidence. The UI does not invent missing attribution or fields absent from the engine report.

Some tools only provide cumulative session totals. Their period attribution follows source timestamps and cannot guarantee an exact daily split for sessions spanning months.

Local statistics include all recorded models and are not matched to the current DeepSeek account, added to platform billing, or used to estimate cost. Collection defaults to this page being visible; background collection is an independent opt-in. Disabling clears in-memory results and leaves engine caches and source logs intact. The UI and IPC expose usage metadata, not conversation bodies or source code, and do not upload it. Engine metadata caches under `local-usage-engine/` next to the app configuration can include source session titles, which the UI does not display. The enable preference is stored in `local-usage-enabled.json` in the same directory.

Expand **采集目录** on the local page to keep the native defaults and add up to three extra user home directories, one per line, such as `D:\AgentData\User` or `\\wsl.localhost\Ubuntu\home\user`. Select the user home containing standard tool subdirectories such as `.claude` or `.hermes`, rather than a project or log file. Supported per-tool paths can be configured in the disclosure below. Saving validates syntax; accessibility is checked during collection. Failed saves preserve preferences; successful saves cancel old collection, clear its snapshot and reset the speed baseline. Preferences stay in `local-usage-sources.json`; source logs are not rewritten or deleted. Native collection retains engine environment-variable rules. Extra homes use the pinned engine's `--home` layout; source-home engine settings can affect aliases and additional paths.

WSL discovery checks registered, running distributions and executes no install, start or Linux commands. Unconfirmed or stopped sources are skipped. Canonical duplicate homes are scanned once, while projects and same-name sessions from different homes stay separate; Linux path case is preserved. Copied logs in different homes can still count twice. Partial failures include only successful sources and mark totals incomplete; total failure retains the previous snapshot. Limits are 30 seconds per engine and 60 seconds overall, with a three-second directory probe and at most one outstanding filesystem probe. Per-source engine caches stay under the application configuration. JSON schemaVersion=2 and CSV include source identity/labels and completeness; full paths remain opt-in and directory-error messages are excluded. Native WSL access, SQLite contention and real tool-version coverage remain unverified.

Expand **采集目录 → 单工具数据路径** to add up to three explicit local or running-WSL data paths, one per tool. OpenCode requires an `opencode.db` or `opencode-<channel>.db` file; WAL/SHM files are rejected. Select Claude Code's projects directory, a Hermes directory containing state.db, OpenClaw's agents directory or DeepSeek Harness's sessions directory. ZCode now accepts a standalone local SQLite file; its per-file WSL entry is unsupported. The user-home entry still supports standard ZCode layouts. You can disable native defaults and collect only specified paths. Failed saves preserve the draft/preferences; successful saves invalidate the old snapshot, speed baseline and selected scope. The engine uses an empty application-owned home and isolated scanner settings, without modifying tool configuration or copying a live database. Avoid adding paths already covered by native/user-home sources: overlaps across sources can count twice. Source identity, failure completeness and caches are isolated. Real tool versions and SQLite contention still require native acceptance.

The default-folded **数据质量** disclosure summarizes field completeness and timing coverage for the current all/project/session view. Model details have compact quality labels. **Unclassified** token provenance means the pinned engine does not distinguish measured versus estimated counts per row; complete fields do not prove measurement. Timing states distinguish matched aggregate counters, partial coverage, unavailable data and unverified alignment. Old snapshots are labelled as previous data. JSON schema2 and CSV add `tokenAccuracy`, `tokenFields` and `timingCoverage` through the existing metadata whitelist. Safe-integer overflow in rows or totals stays unknown, and invalid totals cannot yield a speed.

Per-tool paths now accept deep WSL UNC directories and supported OpenCode database files, such as `\\wsl.localhost\Ubuntu\home\User\.claude\projects`. The registered-running check must confirm the matching distribution before any directory probe. Unconfirmed or stopped sources are skipped; source completeness remains explicit. Server aliases are normalized while Linux path case is preserved. Discovery executes no install/start/Linux commands. Source logs/configuration are not modified, and live databases are not copied. Actual WSL UNC/SQLite behavior remains unverified; examples use synthetic browser callbacks. Individual request details and per-row measured/estimated identification require an expanded engine contract and remain pending.

### Standalone ZCode local database

In **采集目录 → 单工具数据路径**, choose ZCode and a local `.db`, `.sqlite` or `.sqlite3` file. A read-only adapter follows the pinned Tokscale `model_usage` normalization: modern totals determine cache/reasoning-inclusive counts; legacy schemas subtract their known overlaps. Missing session metadata does not alter token rules, and modern NULL totals do not trigger legacy subtraction. Missing, negative or unsafe counts remain unknown. Token provenance stays unclassified; no cost or per-request measurement is invented. Project/session views, matched-counter speed, exports and manual snapshots reuse the existing UI. Mixed snapshots carry `d5e8ad9b+zcode-sqlite-v1`; the pinned engine binary/checksum is unchanged.

This entry rejects WSL/network paths and WAL/SHM sidecars. It queries only usage metadata, without copying the live database, issuing SQL writes/checkpoints or editing tool preferences. SQLite can interact with WAL/SHM coordination files; read-only does not promise no auxiliary-file activity. Limits: 500ms lock wait, 30 seconds per reader within the 60-second collection budget, one outstanding actual worker, query cancellation, 50,000 current-month rows, 16MiB metadata and a 128KiB SQLite length limit. OS-level blocked reads may outlive cancellation; the worker slot is held until they exit. Corrupt/incompatible/locked/oversized/duplicate records fail as an unavailable source; other successful sources remain partial, while total failure retains previous data and reports a source failure reason. Collection uses the computer's local month and start-anchored timestamps, falling back to completion minus positive duration and then file modification time.

Avoid adding a database already covered by native/home sources; overlapping sources can count twice. Synthetic tests do not establish coverage of every ZCode version or native permission/large-database behavior. Automatic session retention and optional background collection are implemented below; request-level details and true token-stream speed remain pending.

![Standalone ZCode path (synthetic data)](screenshots/local-zcode-path-light.png)

### Manual snapshots and saved history

Expand **保存快照与历史归档** on the local page to save the accepted all/project/session view. Saved snapshots have a separate read-only page with CSV/JSON downloads, confirmed single deletion and confirmed clear-all. They never update or add to current totals or one another. Full project paths default to excluded and must be chosen when saving; session IDs and project basenames remain. Internal project keys are hashed. Bodies, credentials and source titles are excluded. `local-usage-archive.json` beside the app configuration stores plain usage metadata (schema1), limited to 12 snapshots and 8MiB total. Full, corrupt or unknown-version stores are not overwritten. Explicit clear-all can recover an unreadable store; it only removes app archives, leaving tool logs and engine caches intact. Unknown counts, unclassified provenance, timing coverage and partial/previous-result flags are retained.

Saving accepts only the backend's current snapshot with its matching timestamp. Disabled/busy collection, changed snapshots, a clock rollback or a previous local month are rejected. Collection spanning local months is rejected; the live view clears old-month totals while saved snapshots keep their original month. Browsing history stops subsequent polling and ignores late UI responses. Manual snapshots cannot recover records never collected and saved, or prove a tool log was deleted. Session retention and background collection are implemented below; individual request records and per-row measured/estimated markers remain pending. Browser examples use synthetic callbacks; native Windows file permissions, restart/log-deletion behavior, DPI and packaged WebView2 still need acceptance. The latest local installer awaits these checks; the 1.3.0 release is available on GitHub.


![Saved local history (synthetic data)](screenshots/local-archive-light.png)

### Background collection (off by default)

Expand **后台采集** and enable **收起后继续采集** after enabling local statistics. This separate setting is stored in local-usage-background-enabled.json and defaults to off. Collection continues outside the local page and while hidden in the tray; quitting stops it. Disabling statistics pauses collection while keeping the background preference; enabling statistics resumes it. Persisted opt-in settings restore at startup. Session retention remains a separate opt-in, and accepted background snapshots participate when it is enabled. Browsing saved history stops foreground polling without disabling configured background collection.

Foreground and background work share one collector. Source or policy changes invalidate and cancel old work. Native directory events only hint that a refresh may be needed, without deriving token counts or deletion claims. Quiet events coalesce for 1.5 seconds; background scan starts are at least five seconds apart, with an approximately 60-second fallback. Failures back off to 120/240/480/600 seconds between attempts. Access events and SQLite shared-memory-only changes are ignored; WAL and data changes remain eligible. The page reads accepted snapshots in background mode rather than launching duplicate scans; manual refresh remains available.

The pinned notify 8.2.0 watcher receives no frontend permissions. One manager and one watcher handle up to 64 candidate tool roots. Database files use a nonrecursive parent watch; whole-home trees are not automatically watched. Missing roots use a nonrecursive existing parent; watches rebuild every minute. Watch failures and uncovered paths fall back to collection. Status exposes counts and sanitized warnings, without full event paths or bodies. WSL roots are never watched; periodic collection still only reads confirmed running distributions. Native environment override paths may lack immediate events, while the engine retains its complete discovery during periodic scans. OS IO may delay directory probes or watcher shutdown.

![Background settings (synthetic IPC)](screenshots/local-background-light.png)

Actual tray/background cadence, installed restart/retention, tool versions, WSL and packaged WebView2/DPI require installer acceptance. Request-level details and per-row measurement provenance remain future engine extensions.

### Automatic session retention (off by default)

Expand **保存快照与历史归档 → 自动会话留存** and enable **自动留存已读取会话**. Accepted scans retain the latest observed session summary (foreground by default, also background when separately enabled), separated by local month, source, tool and session ID. Corrections replace the summary exactly; unchanged records are not rewritten. Missing sessions remain saved, without implying their source logs were deleted. Records never observed cannot be recovered. Retained records never add to current totals or one another.

`local-usage-retention.json` stores schema1 plain usage metadata separately from manual snapshots; `local-usage-retention-enabled.json` stores the opt-in setting. Limits are 128 monthly session records and 8MiB total, with no automatic eviction. Full project paths, bodies, credentials and source titles are excluded; session IDs, project basenames and source IDs remain. Project keys are hashed. Atomic replacement and validation preserve existing records on corruption, unknown schema, stale timestamps, capacity or write failures. A retention failure warns without discarding successfully collected current statistics. Failed preference reads disable the toggle until explicitly reset to off.

**查看会话留存** opens a separate view with CSV/JSON downloads and confirmed single deletion or clear-all. Exports identify `captureKind=automatic-session-checkpoint`; manual snapshots use `manual-snapshot`. Browsing pauses subsequent polling, and saved records remain accessible with statistics disabled. Deletion only removes this app's retained records, leaving manual snapshots, tool logs and engine caches intact. Clearing does not disable retention: another successful scan may save those sessions again. These controls default to collapsed and preserve the accepted dashboard layout.

![Retained sessions (synthetic data)](screenshots/local-retention-light.png)

Session retention and optional background collection are implemented. Request-level details and per-row measurement provenance remain pending. Browser examples use synthetic IPC; installed restart, tool-log cleanup, Windows file IO and packaged WebView2 acceptance remain unrun.

![Data quality (synthetic data)](screenshots/local-quality-light.png)

![WSL per-tool path (synthetic data; native access unverified)](screenshots/local-wsl-tool-path-light.png)

![Per-tool path example (synthetic data)](screenshots/local-tool-paths-light.png)

![Collection directory example (synthetic data)](screenshots/local-sources-light.png)

### Balance and budget reminders

Disabled rules keep their saved amounts, so an empty unsaved input cannot block another active rule. Successfully validating and saving credentials resumes the corresponding paused check, even when the key or token is unchanged; notification deduplication remains in effect.

Open **设置 → 自动刷新 → 余额与预算提醒**, choose your rules and select **保存提醒设置**. The master switch defaults to off. The low-balance threshold defaults to ¥10; the monthly budget defaults to ¥100 and that rule defaults to off. Amounts are editable. Once enabled, independent checks run roughly every five minutes even while the panel is hidden; quitting stops them. This preference is separate from panel auto-refresh.

Low-balance checks support CNY only. Budget checks use platform spending for the current UTC+8 month, exclude local agent statistics and do not stop spending. Only fresh successful, valid responses can trigger notices. Failures back off up to 30 minutes; invalid credentials pause that rule. Credential changes or disabling cancel old checks. The balance key and usage token have not been verified as belonging to the same account, so the rules are evaluated separately.

Low-balance notices have a 24-hour cooldown per credential and threshold. Budget notices are deduplicated per credential, threshold and calendar month, including across restarts. Quiet hours default to on and follow the computer's local time, 22:00–08:00. Automatic notices are suppressed during that window and require a fresh check afterward; old snapshots are not replayed. **发送测试通知** does not query an account, bypasses the app's quiet hours and has a 60-second cooldown. Windows controls whether notifications appear; verify after installation. Submitted to the system does not mean displayed.

Notification bodies omit amounts and credentials. Preferences stay in the local configuration. `alert-receipts.json` stores only deduplication digests, attempt times and system-submission status, bounded to 128 receipts/90 days; it excludes raw keys, tokens and balance/spending samples. A notice is not sent if its attempt record cannot be saved. Failed or incompletely acknowledged submissions retain an attempt cooldown to avoid immediate repeats after restarting.

### Settings

Configure and clear the API key and usage token, autostart on login, refresh interval (1 / 5 / 30 minutes, or 1 hour), and the current version.

The **数据状态与口径** disclosure shows separate data sources, update states and snapshot ages. The balance API key and usage session are configured independently; their account identities have not been automatically matched.

## Where credentials are stored

```text
%APPDATA%\DeepSeekMonitorWindows\config.json
```

Both the API key and the usage token are stored in this file, **encrypted with Windows DPAPI** (`CryptProtectData`; the ciphertext is kept as a base64 string prefixed with `DSM1:`). DPAPI ties the key to the current Windows user and this machine, which means:

- Copying `config.json` alone to another machine or another user account makes the credentials **undecryptable**; the app then asks you to re-enter them (all other settings are preserved).
- Plaintext credentials left behind by older versions (v1.2.1 and earlier) are **re-encrypted automatically** the first time the app reads them — no manual step needed.
- Still do not commit it to any repository, share it, or back it up to cloud storage — encryption only guards against the file being taken, not against a malicious process running as the current user.
- On a shared computer, clear your Key in Settings and use **退出并忘记账户** under **账户隐私** to remove the usage Token and this application's web sign-in data. **清除 Token** alone does not remove web sign-in caches.

The WebView2 cache created by the web login lives at `%LOCALAPPDATA%\com.deepseek.monitor.windows\EBWebView`. It is local runtime data and should not be committed either.

## Development

### Requirements

- Node.js 22.6+ and npm
- Rust 1.88+, MSVC toolchain recommended
- Visual Studio Build Tools 2022 with `Desktop development with C++`

The minimum versions have been verified on Windows MSVC: Node.js 22.6.0 with npm 10.8.2 passed frontend tests and builds; Rust 1.88.0 passed backend builds and tests.

### Commands

The native collector is pinned to Tokscale `d5e8ad9b`; its Windows x64 asset is about 25 MiB. `npm run local-usage:prepare` downloads it and verifies SHA-256. Tauri development and packaging run this preparation first; a verified cached asset can be reused offline. Runtime collection disables online pricing and never downloads an engine. The generated executable stays out of Git; its manifest and MIT notices are tracked. Node/Rust minimum versions remain unchanged.

```powershell
git clone https://github.com/Tsuki-hash/DeepSeekMonitorWin.git
cd DeepSeekMonitorWin
npm install
npm run tauri:dev
```

```powershell
npm run tauri:check    # cargo check (all targets)
npm run check:version  # verify the version number is consistent across config files
npm test               # frontend tests (types + cases)
npm run build          # type check + frontend build
npm run tauri:build    # build the NSIS installer
```

`npm run tauri:dev` and `npm run tauri:build` are thin wrappers around `tauri dev` / `tauri build` that detect your Visual Studio Build Tools installation automatically, so no paths need to be configured by hand. Calling `npx tauri dev` directly works just as well.

The version number lives in three places — `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (Tauri 2 does not read `package.json`). Running `npm run check:version` before a release prevents shipping an installer whose name does not match its contents.

**Tests**: the frontend runs TypeScript tests directly through Node 22's built-in `node --test` with `--experimental-strip-types`, so **no test framework such as vitest or jest is involved** — and no devDependency was added for it. The backend is plain `cargo test`:

```powershell
npm test                                  # frontend: tsc -p tsconfig.test.json + node --test
cargo test --manifest-path src-tauri/Cargo.toml --lib   # backend
```

Coverage targets the things that break silently: usage accounting (the model-name table in `model_slot`, the six token kinds and the `PROMPT_TOKEN` double-count boundary in `token_breakdown`, the additive semantics of `merge_model_slot`), config I/O (missing fields in old configs falling back to defaults, corrupt configs being quarantined and reset, atomic writes leaving no temp file, credential encryption and plaintext migration), login token parsing (context-feature matching, truncated input not crashing), and the frontend's cross-month padding and unit thresholds. Change any of those and run the tests first.

This repository **does not use GitHub Actions**. Run `npm run verify` locally (PowerShell 7+) before pushing: version consistency, frontend tests/lint/build, plus `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`.

Optional hardening: `git config core.hooksPath scripts/hooks` enables the repo's pre-push hook, which runs `npm run verify` automatically before every `git push` (skip once with `git push --no-verify`).

The installer is produced in `src-tauri/target/release/bundle/nsis/`. If you see `Visual Studio Build Tools not found`, install Build Tools 2022 and confirm the C++ workload is selected.

### Code layout

```text
DeepSeekMonitorWin/
├── .github/workflows/           # CI (version consistency, frontend tests + build, cargo check/clippy/test)
├── src/                         # Frontend
│   ├── main.tsx                 # The entire UI: dashboard, settings, detail page
│   ├── format.ts                # Pure formatting / date helpers (unit tested)
│   ├── format.test.ts           # Tests for the above
│   └── styles.css               # All styles, including dark and light skins
├── src-tauri/                   # Backend
│   ├── src/lib.rs               # Command wiring, tray, window visibility, HTTP requests
│   ├── src/config.rs            # Config structs and I/O (unit tested)
│   ├── src/credentials.rs       # DPAPI encryption of credentials (unit tested)
│   ├── src/usage.rs             # Usage accounting (unit tested)
│   ├── src/token_sync.rs        # Login token capture and parsing (unit tested)
│   ├── tauri.conf.json          # Window, bundle, and security configuration
│   └── capabilities/            # Tauri permissions
├── public/assets/               # Icons and static assets
├── scripts/check-version.mjs     # verifies the three version numbers agree
└── screenshots/                 # README screenshots
```

The UI consists of `App.tsx`, `components/`, and shared styles. The backend has separate configuration, networking, aggregation, synchronization, and tray modules. The mapping from model name to dashboard row lives in `model_slot()` in `src-tauri/src/usage.rs` — that is where to start when changing or adding a model, and the test covering all four model names sits right next to it.

## FAQ

**Usage keeps failing but balance is fine.**
Different APIs and credentials. Re-sync the usage token, paste a token manually, or retry later. If balance works, the API key is fine.

**The balance loads but usage is always empty.**
They use different credentials. Balance comes from the API key; usage comes from the usage token. Make sure the token is configured.

**It says usage is unavailable, or that no usage token is configured.**
The usage token expired. Go to Settings and either click **网页登录自动同步** again or paste it manually with method 2.

**The login window does nothing, or it stays on 等待登录.**
Signing in takes time, and the page only issues requests once login completes — that is when the token is captured. If nothing happens, close the login window and click the button again.

**The program is still running after I close the window.**
That is by design: closing hides the panel to the tray. To actually quit, right-click the tray icon and choose quit.

**Why is the Pro row always ¥0.00?**
That means almost no `deepseek-v4-pro` calls this month. V4 Pro and V4.1 Flash are tracked separately; if you called Flash, look at the row above.

**Does it hammer the DeepSeek endpoints?**
Dashboard balance and usage are requested when you open the panel (including bringing it back from the tray), refresh manually, or reach the configured auto-refresh interval (off by default, minimum 1 minute). History queries run on entry, range changes or explicit refresh, and can reuse monthly results cached for five minutes. Auto-refresh pauses while the panel is hidden in the tray, so nothing polls in the background.

### When the usage endpoint stops working

Usage goes through the platform's internal endpoint, which can break when the platform changes. Troubleshoot in this order:

1. **Read the error message.** The panel distinguishes "token invalid/expired" (re-sync needed) from "endpoint unavailable / path may have changed" (retry later); balance errors are unrelated to the usage token.
2. **Re-sync the token.** Click 网页登录自动同步 in Settings; after logging in, sync usually completes within a few hundred milliseconds. If the login window is still open, clicking the button a few more times triggers another attempt.
3. **Paste manually as fallback.** Expand 方式二：手动粘贴 token and paste the latest token from your browser.
4. **Check the diagnostics log.** `%LOCALAPPDATA%\com.deepseek.monitor.windows\logs` records each sync's exit reason and candidate verification outcomes (no credential content ever), so you can see where it stopped: no candidates, verification failed, window closed early, or wait timeout.
5. **Still broken.** The platform most likely changed the internal route or auth — watch the Releases page for updates. Balance uses the official API and is unaffected.

## Origin and acknowledgements

This project continues the DeepSeek Monitor family on the Windows desktop. It builds **directly on [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)** and follows the product idea and visual direction of the earlier macOS original, [JayHome137/DeepSeekMonitor](https://github.com/JayHome137/DeepSeekMonitor).

| Generation | Repository | Target platform | Core technology |
| --- | --- | --- | --- |
| Original | [JayHome137/DeepSeekMonitor](https://github.com/JayHome137/DeepSeekMonitor) | macOS menu bar and WidgetKit desktop widget | Swift 5.9+, SwiftUI, AppKit, WidgetKit |
| Second | [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) | Windows desktop | Tauri 2, React, TypeScript, Rust |
| This project | [Tsuki-hash/DeepSeekMonitorWin](https://github.com/Tsuki-hash/DeepSeekMonitorWin) | Windows desktop | Same as the second generation, continued |

- **Thanks to [@JayHome137](https://github.com/JayHome137/DeepSeekMonitor)** for building the macOS version with Swift, SwiftUI, AppKit, and WidgetKit, and for establishing the idea of glancing at your balance and usage from the corner of your desktop. Without that original project, none of the later versions would exist.
- **Thanks to [@Joyi-code](https://github.com/Joyi-code/DeepSeekMonitorWindows)** for porting that idea fully to Windows — rebuilding the interface and backend, handling a large amount of platform detail such as tray residency, frameless windows, and WebView2 login-state synchronization, and open-sourcing both the repository and the installer. **The code baseline of this project comes from that repository.**

Since taking over, the main work here has been following DeepSeek platform API and model changes, correcting usage statistics, and keeping the Windows build usable. This project does not rewrite the implementation; it iterates on the second-generation baseline.

## License and disclaimer

MIT License. See [LICENSE](LICENSE). Consistent with the license declared by both upstream generations.

This project is intended only for learning and research. Follow the DeepSeek terms of use, use the relevant endpoints responsibly, and avoid frequent requests.

DeepSeek page structures, login state, WebView2 cache behavior, and internal usage endpoints may change at any time, and long-term availability is not guaranteed. **API keys and usage tokens are sensitive credentials. Users are responsible for the risks associated with local storage, account security, network requests, and displayed data.**
