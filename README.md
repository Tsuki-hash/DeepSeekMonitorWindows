<div align="center">
  <img src="public/assets/deepseek-color.png" width="64" height="64" alt="DeepSeek Monitor icon" />
  <h1>DeepSeek Monitor Windows</h1>
  <p>
    <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-2563eb?style=flat-square" alt="Windows 10 / 11" />
    <img src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT License" />
  </p>
  <p>
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest">已发布版本</a> ·
    <a href="https://github.com/Tsuki-hash/DeepSeekMonitorWindows/issues">反馈问题</a> ·
    <a href="README.md">简体中文</a> / <a href="README_EN.md">English</a>
  </p>
</div>

把 DeepSeek 的余额和平台用量放进 Windows 托盘。打开面板，查看账户余额、消费、模型 Token、缓存明细和历史趋势。

**本项目不是 DeepSeek 官方产品，与 DeepSeek 公司无关。** 面向 Windows 10 / 11，使用 Tauri 2、React 18 和 Rust。

## 当前状态：1.3.1 未发布、未验收

1.3.1 正在修复与评审，当前源码只保留 DeepSeek 账户、平台用量与历史功能，已移除多工具 Agent 统计。本说明描述当前源码，不代表现有发行包已包含这些改动。

本轮未编译、未运行测试、未生成安装包，也未进行 Windows 使用验收；编译与使用测试由维护者在本机完成。旧版本的测试记录不作为 1.3.1 的通过证据。下载请以 [GitHub Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest) 实际附件和版本说明为准。

- [1.3.1 升级与旧数据说明](docs/UPGRADE_1.3.1.md)
- [1.3.1 本机验收清单](docs/ACCEPTANCE_1.3.1.md)
- [变更记录](CHANGELOG.md)

旧截图包含已移除的入口，已从当前说明撤下；1.3.1 截图待本机验收后更新。

## 做什么

- 查看 DeepSeek 账户余额、可用状态及最近成功查询时间。
- 查看平台返回的消费、请求数、模型 Token 与缓存命中明细。
- 查询平台用量历史，按原始模型 ID 查看记录，手动导出 CSV / JSON。
- 提供托盘显隐、深浅主题、透明度、置顶、快捷键和可选余额／预算提醒。

应用不再提供其他工具的项目／会话统计、目录扫描、WSL 来源、后台采集、快照或自动留存。旧数据仍留在本机，不会因功能移除而自动删除；详见升级说明。

## 两路数据，两种凭据

| 内容 | 来源 | 所需凭据 | 限制 |
| --- | --- | --- | --- |
| 账户余额 | DeepSeek 官方公开 API：`https://api.deepseek.com/user/balance` | DeepSeek API Key | 不提供本项目所需的账户用量历史 |
| Token、请求数、消费、历史 | DeepSeek 网页平台内部接口：`https://platform.deepseek.com/api/v0/usage/amount` 与 `/api/v0/usage/cost` | 平台网页登录会话 Token | 非公开稳定 API；会话会过期，路径、字段和鉴权可能变化 |

API Key 和用量 Token **不能互换**，也不能由其中一个自动推算另一个。可以只配置余额，或只配置平台用量。应用尚未自动核对两种凭据是否属于同一账户，使用时请自行确认。

余额来自官方 API，不代表用量接口也属于公开 API。用量是平台返回的数据，不是从本机其他工具日志推算，也不是用余额差额估算消费。最终扣费请以 DeepSeek 平台账单为准。

## 安装与上手

### 安装

从 [Releases](https://github.com/Tsuki-hash/DeepSeekMonitorWindows/releases/latest) 下载已发布版本的 Windows x64 安装包。1.3.1 当前尚无已验收发行包。

运行需要 Windows 10 / 11 与 Microsoft Edge WebView2 Runtime。若系统缺少 WebView2，需先安装。

### 只看余额

1. 打开设置中的「API Key」。
2. 填入在 DeepSeek 开放平台创建的 API Key。
3. 点「验证并保存」，验证成功后查询余额。

无需为余额功能登录平台网页。

### 平台消费与历史

1. 打开设置中的「用量同步 Token」。
2. 点「网页登录自动同步」，在 DeepSeek 登录窗口完成登录。
3. 应用从该窗口的请求中捕获会话 Token，验证可调用用量接口后保存并刷新。

等待期间可以取消；取消或关闭窗口后，应能重新开始。Token 会过期，失效后需要重新同步。此流程只同步 DeepSeek 平台会话，不会要求你提供其他工具的凭据。

自动同步不可用时，可展开「方式二：手动粘贴 token」。在已登录 `platform.deepseek.com` 的浏览器开发者工具 Console 中查看：

```js
JSON.parse(localStorage.userToken).value
```

只在你自己的 DeepSeek 页面执行。复制结果到应用的 Token 输入框并保存，不要把 Token 发到 Issue、聊天或日志附件。若该存储键不存在，平台可能已调整登录实现，不应把未知内容当作有效 Token。

## 日常使用与数据口径

- 关闭窗口会隐藏到托盘；右键托盘选择「退出」才会结束应用。左键托盘图标可显示／隐藏面板。
- 余额与用量独立刷新、独立显示状态。网络失败可能保留明确标记的旧数据；凭据失效需要重新配置。缺失、异常或未查询的数据不能当作零。
- 平台自然日和自然月按 UTC+8 记账；最近更新时间按电脑本地时区显示。跨月后，上月快照不能继续被标成「本月」。
- 首页按模型组汇总，历史保留平台原始模型 ID。当前源码在 `src-tauri/src/usage.rs` 的 `model_slot()` 中维护映射；未知模型保留兜底展示，不应静默丢弃。
- 金额、Token 或请求数缺失／无效时显示未知；明确返回的合法零仍显示零。费用缺失不表示免费，T/¥ 也不能据缺失金额计算。
- 计价时段标签只提供规则提示，不替代平台价格或实际账单。
- 自动刷新默认关闭。面板隐藏后暂停面板轮询；开启的余额／预算提醒有独立检查，见下节。
- 设置可调整主题、透明度、自启、置顶和显隐快捷键。快捷键默认关闭，冲突时应显示失败原因。
- 「检查更新」只手动查询 GitHub 发行版本，不自动下载安装。

### 用量历史与导出

在「历史」中选择本月、上月、近 30 天、指定月份或全部历史。全部历史分批加载，可继续查询更早月份或停止。平台是否保留并返回某个月份由平台决定，未加载或缺失月份不表示零用量。

查询失败时，已成功月份应保留。鉴权或限流错误需先处理；单月失败可「只重试失败月份」。历史查询缓存与当前用量会话绑定，更换或清除 Token 后旧缓存和迟到响应不应混入新账户。

CSV 导出所选范围内的每日记录；JSON 的范围汇总与每日记录一致，原始整月来源另放在 `sourceMonthlySnapshots` 并注明范围。导出不含 API Key、会话 Token 或 Cookie。导出文件仍含账户消费信息，请自行决定如何保管与分享。

### 余额与预算提醒

提醒总开关默认关闭。在设置中开启并保存后，应用在托盘驻留时也会独立检查；退出应用后停止。低余额只支持人民币余额，预算使用平台当月费用，只提醒、不限制消费。

提醒依赖有效的最新响应。缺失数据或失效凭据不能用于判断已超预算。夜间免打扰默认按电脑本地时间 22:00–08:00 生效；Windows 设置仍可能阻止通知显示。「已提交系统」不等于用户已看见。

## 凭据与旧数据

API Key 和用量 Token 保存在：

```text
%APPDATA%\DeepSeekMonitorWindows\config.json
```

在 Windows 上使用 DPAPI 加密，绑定当前 Windows 用户和机器。复制配置到另一用户或电脑后可能无法解密，需要重新配置。加密不能防止以当前用户身份运行的恶意程序；不要上传或分享配置文件。

- 「清除 Key」只移除保存的 API Key。
- 「清除 Token」移除保存的用量 Token，保留网页登录会话。
- 「退出并忘记账户」清除本应用的用量 Token 和网页登录数据，保留 API Key 与其他设置。
- 以上操作都不会自动删除历史版本的 `config.json.corrupt-*` 备份、手动副本或旧 Agent 数据。旧备份可能含明文凭据，需由使用者确认后自行安全处理。

配置损坏或编码无效时，应用报错并保留原文件，不生成新的普通备份、不静默重置。先安全修复或移走文件，再重试；不要上传原文件排障。旧明文凭据仍有加密迁移路径，迁移写入失败会提示，不应误认为已经加密落盘。

网页登录缓存通常位于 `%LOCALAPPDATA%\com.deepseek.monitor.windows\EBWebView`。DeepSeek 登录与 Token 同步仍会使用本应用的网页登录数据，这不属于已移除的多工具统计。

当前源码不再读取、扫描、迁移或上传旧 Agent 的采集配置、缓存、快照和留存文件，也不自动清理这些文件或任何原始工具日志。功能移除不等于数据已擦除。

## 排障

| 现象 | 建议 |
| --- | --- |
| 余额正常，用量失败 | 两路凭据不同。重新同步用量 Token，并查看是否为限流或平台内部接口变化 |
| 余额失败 | 核对 API Key、网络与余额错误提示，不要用网页登录 Token 替代 API Key |
| 历史缺少月份或费用为「—」 | 查看范围和数据提示，不要把平台未返回的数据解释成零 |
| 登录同步一直等待 | 取消后重试，或手动粘贴有效 Token；不要反复点击启动多个同步 |
| 托盘没有显示余额 | 可能尚无成功快照，或凭据已失效；普通网络失败的旧值应有旧数据标识 |
| 升级后找不到 Agent 页 | 该功能已移除，旧文件未自动删除；查看升级说明 |

反馈问题时提供版本、操作步骤、期望与实际表现，并遮盖账户信息。不要附带 API Key、Token、Cookie、配置原件或未经检查的日志。

## 开发与验收

源码工具链要求 Node.js 22.6+、npm、Rust 1.88+、Windows MSVC 与 Visual Studio Build Tools 2022 的 C++ 桌面开发组件。以下为供本机执行的命令，**不是本轮已执行或通过的记录**：

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

`verify` 需要 PowerShell 7+；具体步骤以当前仓库脚本为准。源码不再下载或打包多工具统计引擎。安装包生成后，还需按 [验收清单](docs/ACCEPTANCE_1.3.1.md) 检查实际安装、升级、托盘、登录、凭据和数据边界。静态阅读、旧版本测试记录或版本号一致，都不能代替这些验收。

主要目录：`src/` 为前端，`src-tauri/src/` 为后端，`scripts/` 为本机校验与发版工具，`docs/` 为升级和验收说明。余额／平台请求在 `deepseek_api.rs`，用量规则在 `usage.rs` / `usage_history.rs`，登录同步在 `token_sync.rs` / `sync_session.rs`，凭据与配置在 `credentials.rs` / `config.rs`。

## 来源、许可与免责声明

本项目直接承接 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) 的 Windows 代码基线，并沿用更早的 macOS 原项目 [JayHome137/DeepSeekMonitor](https://github.com/JayHome137/DeepSeekMonitor) 的产品思路与视觉方向。感谢两代上游作者与贡献者。

本仓库在上游基础上继续维护 DeepSeek 接口适配、统计口径与 Windows 体验。功能收束不改变上游归属。

采用 MIT License，详见 [LICENSE](LICENSE)。保留原有版权与许可声明。

请遵守 DeepSeek 的使用条款并合理控制请求频率。平台页面、会话机制和内部用量接口可能随时变化，本项目不保证持续可用。余额和用量展示仅供参考，实际余额、费用及价格以 DeepSeek 平台为准。
