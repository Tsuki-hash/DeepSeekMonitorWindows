# 1.3.1 升级与旧数据说明

状态：**未发布、未验收**。本文件描述当前源码收束后的行为与本机核验要求，不表示升级安装包已经生成或通过测试。

## 保留与移除

当前版本只处理 DeepSeek 账户和平台用量：

- 余额：DeepSeek 官方公开 API `https://api.deepseek.com/user/balance`，使用 API Key。
- Token、请求数、消费和历史：DeepSeek 平台内部 `/api/v0/usage/amount` 与 `/api/v0/usage/cost`，使用网页登录会话 Token。会话会过期，内部接口不保证稳定。
- 保留模型明细、历史导出、托盘、主题、桌面设置和余额／预算提醒。
- 保留 DeepSeek 网页登录、Token 自动同步／手动填写与本应用登录数据管理。

多工具 Agent 的项目／会话统计、目录和 WSL 来源、后台采集、快照、自动留存及相应导出已移除。它们不再作为后台任务启动，也没有当前界面或 IPC 入口。

## 旧文件不会自动删除

移除功能不会擦除你在旧版本中生成的数据，也不会上传这些旧数据。当前源码不再访问、迁移或清理旧 Agent 的配置、缓存、快照和留存文件，不扫描其他工具的日志、WSL 或 SQLite 数据库。

旧文件可能仍在默认配置目录 `%APPDATA%\DeepSeekMonitorWindows\` 中，包括：

- `local-usage-enabled.json`
- `local-usage-background-enabled.json`
- `local-usage-sources.json`
- `local-usage-archive.json`
- `local-usage-retention-enabled.json`
- `local-usage-retention.json`
- 上述文件对应的旧 `.tmp` 文件
- `local-usage-engine/` 缓存目录

这些名称用于识别旧文件，不是自动清理清单。自定义配置位置、手动导出和备份也可能存在；不能仅凭这个列表断言已找全数据。其他工具自己的原始日志和数据库不会被本应用删除。

源码的开发／打包流程不再准备或捆绑统计引擎；用户既有构建目录里的 `tokscale.exe` 不会因此自动消失。当前改动没有新增针对这些文件的卸载清理。

如需保留旧记录，应在升级前自行决定是否使用旧版本已有的导出功能。新版本不提供旧 Agent 记录的查看、导出或清理界面。确认不再需要恢复后，才自行处理已确认的旧文件；不要整目录删除 DeepSeek 的配置或登录数据来代替确认。

## DeepSeek 账户数据是另一回事

`config.json` 仍用于 DeepSeek API Key、用量 Token 和应用设置。Windows 上凭据用 DPAPI 加密，绑定当前用户和机器。

| 操作 | 清除内容 | 保留内容 |
| --- | --- | --- |
| 清除 Key | 已保存的 API Key | 用量 Token、网页登录数据及其他设置 |
| 清除 Token | 已保存的用量 Token | API Key、网页登录数据及其他设置 |
| 退出并忘记账户 | 本应用的用量 Token 与网页登录数据 | API Key 及其他设置 |

这些操作都不会自动删除旧 Agent 数据、历史 `config.json.corrupt-*` 备份或手动副本。旧备份可能包含明文凭据，不能因为当前配置已加密或已清除就认定备份也安全。

DeepSeek 登录缓存通常位于 `%LOCALAPPDATA%\com.deepseek.monitor.windows\EBWebView`，仍用于本应用登录同步。不要把保留这条登录链误认为仍在采集其他工具的数据。

配置损坏或无效编码会明确报错并保留原件，不生成新的普通备份、不静默重置。旧明文凭据的加密迁移仍保留；写入失败必须按提示处理。

## 升级前后需要确认

1. 记录当前使用的版本、DeepSeek 配置状态和重要外观偏好，不记录凭据内容。
2. 按需保管旧数据。功能移除后原文件可能仍存在，但不再有对应查看入口。
3. 用实际生成的候选安装包完成覆盖升级，不把开发服务器页面当作安装验收。
4. 确认账户与历史可用、旧 Agent 入口消失，而且旧文件未被应用访问、改写或删除。
5. 在 [本机验收清单](ACCEPTANCE_1.3.1.md) 中记录实际结果。失败、未执行或受阻都需明确记录。

## English summary

**1.3.1 is unreleased and has not passed local acceptance.** The current source keeps DeepSeek balance, platform usage/history and related desktop features. Balance uses the official public `/user/balance` API with an API key. Usage uses the platform's internal `amount` / `cost` endpoints with a web-session token; these are not stable public usage APIs.

Multi-tool agent collection, project/session statistics, WSL sources, snapshots and retention have been removed. Their old settings, caches and records remain on the computer: the current app no longer accesses, scans, migrates, uploads or automatically deletes them. It does not delete other tools' original logs/databases. Existing `tokscale.exe` files in old build directories are not automatically removed either. File removal is not a claimed outcome of this upgrade.

The filenames above identify known old data, not an automatic cleanup list or a complete inventory of custom locations and manual copies. The new version cannot view or export those records. Decide whether to keep or export them before upgrading; do not delete the whole application directory as a shortcut.

DeepSeek web login and token synchronization remain. Clearing the API key, clearing the token and forgetting web sign-in have different scopes; none deletes old agent data, historical configuration backups or manual copies. Backups may contain plaintext credentials. The Windows build, installer upgrade and these data boundaries still require local verification.
