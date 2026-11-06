# 1.3.1 本机验收清单

**当前状态：1.3.1 已发布（tag `v1.3.1`，提交 `d7cb1aa`）。** 源码门禁在 Windows 上全部通过，发布记录已绑定该提交与安装包哈希；维护者已在本机完成安装与使用验收。以下清单保留为验收项与判据记录，Windows checksum 与文件快照验收仍为 NOT RUN。

本清单针对 DeepSeek-only 版本。测试账号凭据仅在本机和对应 DeepSeek 服务使用，不粘贴到验收记录、截图或 Issue。旧数据边界可先用专门测试目录中的合成文件确认，避免对唯一副本进行破坏性操作。

## 专项验收导航

以下说明补充具体场景，均为待执行要求，不是通过证据。最终验收须针对同一个候选提交。

- 历史：[失败状态与缓存](REVIEW29_HISTORY_CACHE_REGRESSIONS.md)、[异常日期与导出](REVIEW29_HISTORY_DATE_REGRESSIONS.md)。
- 键盘与焦点：[提示框和峰谷说明](REVIEW31_PROMPT_BADGE_FOCUS_REGRESSIONS.md)。
- 退出与未保存设置：[启动期间的托盘退出请求](REVIEW32_EARLY_QUIT_REGRESSIONS.md)、[退出期间编辑与异步保存](REVIEW32_QUIT_LOCK_REGRESSIONS.md)。
- 退出通知恢复：[监听就绪后通知丢失的恢复](REVIEW33_QUIT_RECONCILIATION_REGRESSIONS.md)。
- 登录等待与恢复：[网页登录等待与状态恢复](REVIEW34_USAGE_SYNC_RECONCILIATION.md)。
- 发布：[当前五组源码门禁及 Windows 独立要求](RELEASE_GATES_1.3.1.md)。早期三组／四组说明只作历史参考，不能作为当前清单。

## 记录模板

- 源码提交 SHA：待填写。
- 工作区是否干净、锁文件是否与提交一致：待核对。
- Windows / WebView2 / Node / npm / Rust / MSVC / PowerShell 版本：待填写。
- 每条命令的退出码、开始时间和原始输出位置：待填写。
- 安装包文件名、大小与 SHA-256：待生成并核对。
- 各场景结论：`PASS` / `FAIL` / `NOT RUN` / `BLOCKED`，并附可复核原因。
- 总结与剩余问题：待填写。不得把 `NOT RUN` 或 `BLOCKED` 写成通过。

## 1. 源码、依赖与构建

- [ ] 三处应用版本一致为 1.3.1，锁文件与提交对应。
- [ ] 干净安装依赖后，执行当前 `package.json` 与 `scripts/verify.ps1` 定义的前端类型／单测、组件回归、发行版本纯函数回归、脚本门禁、lint、格式、构建及 Rust 校验。
- [ ] `npm run verify` 与 `npm run release:record -- ...` 均实际执行 `scripts/run-release-version-tests.mjs`，由其启动 `verify-release-version.static-tests.ps1`；核对五组非零且有序的断言、唯一完成汇总及原生退出码 0。保留 `filename`、`pe-header`、`pe-version`，第四组 `pe-bytes` 必须同进程真正运行纯字节脚本和 C# 解析器；第五组 `checksum-pure` 必须同进程运行完整 checksum 纯脚本并校验其独立逐断言/末尾完成对象。两个 PowerShell 入口要求当前进程为 PowerShell 7+ Core；核对实际断言进程输出的唯一运行时版本、取值来源和可执行文件路径，不能用命令名或另一次版本查询代替。低于 7、版本无法取得、缺 pwsh／脚本、异常、非零退出、零断言、提前返回、旧三/四组或旧 PASS 文案、缺证据均不能通过。
- [ ] 发行记录保留版本纯函数的完整 stdout/stderr、真实 pwsh 退出码、信号／启动错误、运行时信息与 schema v2 日志；表格的入口退出码不冒充原生退出码。纯函数计数以 assertions 标注，不能作为真实安装包或安装升级的验收证据。
- [ ] checksum 原始 `RELEASE_CHECKSUM_PURE_ASSERT/SUMMARY` 文本不能单独放行；父入口须核对非零返回对象、连续序号、严格字段类型、唯一末尾完成及匹配计数，再纳入第五组。门禁故障注入和 18 类纯内存完成协议回归须由本机实际执行，不把已编写的断言当作通过记录。
- [ ] Rust 与版本日志使用同一字节快照校验和归档；缺失／损坏／旧 schema／篡改均为 ERROR。被拒绝文件以明确不可信的完整 Base64 字节、字节数和 SHA-256 留在报告中，不只写“缺失”。缺文件、读失败和零字节文件的记录须可区分。
- [ ] 发行记录不会自动删除原始临时证据；成功、失败、stdout-only、日志读失败或并发变化时均须保留原件。可靠归档后由维护者自行决定何时清理；系统临时目录仍可能被系统清理。以最终退出码及 stderr 确认报告生成状态，不以文件中的 PASS 文案替代；失败保留位置见 stderr。
- [ ] 依赖审计结果被真实记录；网络错误或无法取得结果不是“无漏洞”。
- [ ] 测试实际执行数大于零；没有把已移除的 Agent 测试、空集合或跳过计为通过。
- [ ] 按 [发布门禁说明](RELEASE_GATES_1.3.1.md) 在 Windows 本机运行 Rust 门禁：11 项必需 Windows 测试全部真实完成，schema v3 的逐项覆盖、完成行和总数一致。非 Windows／中文跳过／缺必需项的注入均阻断放行。
- [ ] 组件 runner 实际执行 settings-transactions、desktop-ui-regressions、usage-fidelity、history-lifecycle、chart-accessibility、history-trend-interactions、month-accessibility、return-focus、directed-settings-focus、window-visibility、pricing-period-badge 与 quit-request-lifecycle 十二套回归；directed-settings-focus 包含 LeavePromptDialog 提示框回归。焦点套件使用合成节点/事件和可控 RAF，不是真实 DOM 或原生焦点测试。非零计数不替代 Windows 原生窗口、布局和通知验收。
- [ ] 退出相关回归包含 `src/quit-intent.test.ts`、`src/quit-request.test.ts`、`src/quit-interaction.test.ts`、`src-tauri/src/quit_intent.rs` 及 `tests/quit-request-lifecycle.test.tsx`；登录恢复包含 `src/usage-sync-reconcile.test.ts` 及 `tests/settings-transactions.test.tsx`。它们由现有单元、Rust 或组件入口执行，不是额外的组件套件，也不改变五组发行版本纯函数门禁的含义。记录实际执行结果，不将用例文本或合成 IPC 当作 Windows 事件已验证。
- [ ] 按[提示框与峰谷说明回归](REVIEW31_PROMPT_BADGE_FOCUS_REGRESSIONS.md) 验收提示初始 RAF 的同步撤销、安全取消归还与保存/放弃导航；打开峰谷说明后 Tab 到图表日期再按 Escape，图表处理的事件不能关闭说明或把焦点拉回峰谷按钮。另测外部未处理 Escape 关闭说明但保持当前焦点。
- [ ] 开发与打包不运行统计引擎准备，不下载或捆绑该引擎。
- [ ] 执行 Windows NSIS 打包，并记录实际安装包哈希。构建成功仍不等于安装后可用。

## 2. 安装、升级与移除边界

- [ ] 全新安装可以启动，只有 DeepSeek 账户／平台历史及相关设置入口。
- [ ] 覆盖旧版安装后，API Key、用量 Token、主题、透明度等该保留的设置仍可正确读取；无法解密时明确提示。
- [ ] 首次引导只有「只看余额」与「平台消费与历史」，没有 Agent 开启按钮。
- [ ] 不再存在项目／会话、采集目录、WSL、快照、自动留存、旧 Agent 导出和数据管理入口。
- [ ] 旧设置即便曾开启后台采集或自动留存，新版本也不启动这些任务。
- [ ] 用文件访问观察及前后内容核对，确认不会读取、改写或删除 [升级说明](UPGRADE_1.3.1.md) 列出的旧 Agent 文件；“文件仍存在”本身不足以证明未访问。
- [ ] 实际安装包不含旧统计引擎资源；升级／卸载不新增删除原始工具日志和旧 Agent 数据的动作。
- [ ] 后端已无对应 IPC 注册；不能仅凭“界面看不到”判定彻底移除。

## 3. 余额与凭据

- [ ] 仅配置 API Key 时可查余额，用量未配置不拖慢余额刷新。
- [ ] Key 验证失败不覆盖旧有效 Key；保存成功立即反映在设置、面板和托盘。
- [ ] 失效 Key、断网、超时、限流和格式异常显示可区分状态；旧数据明确标记，失效凭据不继续在托盘展示有效金额。
- [ ] 重新保存有效凭据后恢复查询，不要求重启应用。
- [ ] 保存过程中继续修改草稿，旧请求完成不会清空新输入；离开／退出时的未保存提示行为正确。
- [ ] Windows DPAPI 的读写／旧明文迁移被验证；无法加密写回时明确提示，未发生明文泄露。
- [ ] 损坏 JSON 与无效 UTF-8 报错并逐字节保留原件，不生成新普通备份、不静默重置；错误文案不回显敏感字段。

## 4. DeepSeek 登录与用量

- [ ] 登录窗口仍可打开，完成登录后捕获并验证 DeepSeek 会话 Token，再保存和刷新。
- [ ] 取消、关窗、超时与重试后不存在残留窗口阻挡或旧请求重新保存凭据。
- [ ] 反复点击或同时尝试自动同步／手动保存不会让迟到结果覆盖较新操作。
- [ ] 登录窗口的权限只覆盖所需同步，不能调用主窗口的其他敏感命令。
- [ ] 手动粘贴有效／无效／过期 Token 的行为正确；无效候选不覆盖有效会话。
- [ ] 只配用量 Token 时用量可独立工作；两种凭据来源与“账户尚未自动核对”的提示准确。
- [ ] 清除 Token 后网页登录会话保留；忘记账户后应用 Token 与网页登录数据清除；API Key、外观偏好保留。
- [ ] 清除操作与在途请求交错时，旧结果不能恢复已清除的凭据或账户数据。
- [ ] 设置页等待网页登录时，分别丢弃捕获通知和结束通知、让状态／配置读取失败，再恢复读取；无须第二次点击登录也能继续核对当前会话。只确认终态时显示「同步已结束，当前配置已核对」，不凭已有 Token 或其他配置更新宣称本次成功，不清除手动草稿。
- [ ] 取消、取消时会话已结束、关闭登录窗口、手动保存、清除 Token、忘记账户、开始新会话、离开并重进设置与慢读取交错时，旧结果不覆盖较新配置、反馈或草稿。离页后不残留该页面的定时检查。2 秒是每轮结束后的计划检查间隔，不是 Windows / WebView2 的响应时限保证。

## 5. 统计、历史与导出

- [ ] 与同一账户的平台结果核对金额、Token、请求数和缓存分段；使用固定合成样本覆盖缺字段、显式零、异常数值、模型别名和未知模型。
- [ ] 缺失费用显示未知，不当成 ¥0.00；未知字段不会被部分合计伪装成完整结果。
- [ ] 同日多条、同模型多条记录正确合并，不重复计算输入总量与缓存分段。
- [ ] UTC+8 跨日／跨月后，旧快照不冒充新日或本月数据；日期与本地更新时间各用正确时区。
- [ ] 历史全部加载、停止、继续加载与仅重试失败月份正确保留已成功月份和所选范围。
- [ ] 鉴权、限流、网络或单月异常按实际类型停止／重试，不能形成无界连续请求。
- [ ] 更换或清除用量 Token 时缓存和迟到响应失效，不混入旧账户；切换范围后旧查询不覆盖新范围。
- [ ] CSV 和 JSON 的区间合计与页面一致；JSON 原始整月来源单独标记范围；导出不含凭据、Cookie 或不应包含的数据。
- [ ] 成功查询后注入失败，再切换范围和重新进入历史：旧来源时间、失败月份与 `stale` 标记不因缓存命中而消失；只有真正成功重试才恢复。缓存已释放时保持未知，且与未加载月份、平台未返回日期区分。
- [ ] 非规范日期、不存在的公历日期和错月来源不进入正常日记录、趋势、合计与覆盖天数，页面保留原始日期和排除原因；缺少的真实日期仍未知。合成 31 个合法日各 10 Tokens，再加入异常日期的 900 Tokens，正常合计应为 310、覆盖 31 日，异常 900 独立保留而非变成零。
- [ ] JSON `excludedDateRecords` 标明 `includedInTotals=false`；`monthly.excludedDateRecordCount` 是记录数而非天数。CSV 的 `excluded-invalid-date` / `excluded-outside-query-month` 行七个用量／费用数值列为空，原值仅在 `excluded_models`；来源日期、原因、警告及公式防护保留。异常证据可在所选窗口之外，不能被当作区间记录；`sourceMonthlySnapshots` 的整月汇总也不能加入区间合计。

## 6. 桌面、提醒与可访问性

- [ ] 实际安装后的托盘显隐、余额更新、旧数据标识和退出可用；关窗只是隐藏。
- [ ] 应用刚启动、前端监听未就绪时点托盘退出，以及监听就绪后退出通知未送达时，均能继续进入当前草稿协商，不要求再次点击才能发现原请求。有草稿时可保存、放弃或取消；取消后旧通知与重复检查不重弹，新点击仍可退出。主窗口恢复失败时不能直接绕过草稿退出。
- [ ] 退出请求读取／确认接收失败时显示恢复入口；重试不复用先前的退出批准。延迟读取、确认接收、页面重建或最终退出命令时，不重复提交退出，也不让旧响应恢复已结束的操作。
- [ ] 最终退出命令发出期间，真实键鼠输入和导航均不可再编辑；失败后恢复新编辑。退出前开始的剪贴板读取、排队登录及排队保存晚到时，不产生新草稿或后续保存；已发送保存的配置回执可同步，但不能消费新草稿或引出第二次退出。此前已请求的清除／忘记账户操作不应被擅自取消。
- [ ] 面板隐藏后停止面板轮询；只有明确开启的余额／预算提醒独立检查。
- [ ] 提醒在有效最新数据上触发；未知数据不触发预算判断，失效凭据暂停，恢复后重新检查。
- [ ] 免打扰、去重与冷却在重启后仍符合设置；在 Windows 中实际看到测试通知，不以“提交成功”代替可见性。
- [ ] 置顶、快捷键冲突、自启、透明度和窗口位置恢复正常；多显示器／缩放变化后可找回窗口。
- [ ] 紧凑／阅读模式、深浅主题和键盘导航没有残留 Agent 控件或不可达焦点；未保存提示可保存、放弃和取消。
- [ ] 手动更新检查正确区分新版、相同版与开发版，不自动下载或安装。

## 7. 发布前收尾

- [ ] 所有必需项都有本次提交对应的结果；失败项已修复并重新验证，或明确作为未解决阻断。
- [ ] 对实际安装包检查版本、资源与哈希，而不是只检查源码配置。
- [ ] 在本机 NTFS 上完成 [文件快照双屏障主流程回归](REVIEW21_RELEASE_SNAPSHOT_REGRESSIONS.md)，保留真实退出码和证据目录。源码纯字节门禁、helper-only 断言或非 Windows 结果不能代替必需的 Windows 主流程验收。
- [ ] **NOT RUN，独立必需：** 按 [checksum 文件验收说明](REVIEW26_CHECKSUM_SIDECAR_REGRESSIONS.md) 运行 `verify-release-checksum.windows-tests.ps1`。在 Windows + PowerShell 7+ + 本机 NTFS 的全新证据根，使用不可执行合成文件核对 hardlink/符号链接、已存在及并发 sidecar、源/输出持锁、失败保留和字面路径；保留真实退出码、唯一完整汇总与原始证据。不能以第五组源码 PASS 代替，也不能把该合成套件作为真实包校验和、安装或升级验收。
- [ ] 用无真实账户信息的演示状态重截当前截图，覆盖账户、历史与设置；不复用旧导航截图冒充新版。
- [ ] README、升级说明与实际行为一致，仍保留 MIT 版权和上游归属。
- [x] 发布状态已按实际发布更新（tag `v1.3.1` → `d7cb1aa`）；验收结论独立记录，不由打标签或上传附件推导。

## English acceptance summary

All checkboxes are pending, not passed. Record the exact source commit, toolchain versions, exit codes, original outputs and installer SHA-256. Run the current repository gates and Windows installer acceptance locally, including all five release-version suites. Verify both clean installation and upgrade, removal of all collector entry points and backend access, preservation of old files, DeepSeek balance/login/usage, credential races, history/export accounting and isolated invalid-date records, tray/reminders and the actual installer contents. Follow the linked scenarios for startup/missed exit notifications, editing during exit and missed web-login notifications. Synthetic events and timers do not prove native Windows behavior. Removed tests, skipped checks and earlier-version results cannot count as passes for 1.3.1. New screenshots and a release claim must wait for actual evidence.
