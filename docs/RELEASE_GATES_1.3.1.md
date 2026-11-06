# 1.3.1 发布源码门禁与证据

**当前为待执行说明，不是通过记录。此次修改未在此环境编译、运行测试或启动应用。维护者须在本机完成验证。**

## 开发结果和发布结果分开

- `node scripts/run-rust-tests.mjs` 可在依赖齐全的非 Windows 开发环境运行剩余 Rust 单测，但 Windows 发布覆盖必须记为 `NOT RUN`，退出码为 2。实际编译／测试失败仍优先记为 `FAIL` 或 `ERROR`，不能被“平台不支持”掩盖。
- 发布级 `PASS` 要求 Windows 本机、明确的 MSVC 编译目标、非零真实测试完成行、与完成行一致的唯一 libtest 汇总，以及全部发布必需 Windows 用例实际完成。非 Windows 即使打印全部 `ok` 也不能通过。
- `scripts/verify.ps1` 与 `scripts/release-record.mjs` 共用该门禁，并都必需执行发行版本纯函数回归。未执行、跳过、过滤或缺失覆盖不得被改写成绿色通过，也不能删除相应检查来放行。
- `NOT RUN:` 是统一的未执行标记；门禁兼容识别旧中文 `跳过：`，并检查 stdout 和 stderr。测试正常 return 产生的原始 `passed` 不足以证明断言执行。
- 已删除的多工具 Agent 引擎与目录能力探针退出产品范围，不恢复、不运行，也不计作通过。

## 必需发行版本纯函数回归

两条完整入口 `npm run verify` 和 `npm run release:record -- ...` 均通过 `scripts/run-release-version-tests.mjs` 调用 `pwsh -NoProfile -File scripts/verify-release-version.static-tests.ps1`，无需维护者额外记住单独命令。要求 PowerShell 7+ 可用；缺少 pwsh、脚本或被提取的函数均阻断，不允许跳过后继续报通过。

- `verify.ps1` 和纯函数脚本均有 `#requires -Version 7.0`，并在开始工作前检查当前进程的 `$PSVersionTable.PSVersion` 和 Core edition。纯函数脚本先输出唯一的 `RELEASE_VERSION_RUNTIME`：版本及各数值段、版本来源、当前进程实际可执行文件路径及取值来源。共享入口核对主版本至少为 7、版本文本与数值段一致、来源及路径有效；缺失／损坏／重复／迟到的运行时证据不能通过。取值失败直接阻断，不能只因命令名是 pwsh 就视作 PowerShell 7，也不能用另一个 `pwsh --version` 进程代替。
- 前三组从 `verify-release.ps1` 的 AST 提取纯函数，检查文件名版本、内存 PE 头、合成版本字段。第 21 轮新增第四组 `pe-bytes`：同一 pwsh 进程实际执行 `verify-release-pe-bytes.static-tests.ps1`，编译并调用真实 C# 字节解析器，以合成 PE 运行断言；不是只检查脚本存在，也不是只提取 AST。第 26 轮新增独立第五组 `checksum-pure`：同进程实际执行 `verify-release-checksum.static-tests.ps1`，检查真实 checksum 纯函数、源码接线与父完成协议。五组均不运行发行校验或 checksum 主流程。
- 纯字节子脚本逐次输出 `PE_BYTE_ASSERT`；checksum 子脚本逐次输出 `RELEASE_CHECKSUM_PURE_ASSERT`，完整结束才输出 `RELEASE_CHECKSUM_PURE_SUMMARY`。两个子脚本均以 `-PassThru` 返回带序号的真实断言对象和末尾唯一完成对象（kind、schemaVersion、scope、completed、assertions/passed/failed）。父脚本分别先清空再核对各自的 `LASTEXITCODE`，校验末尾完成记录、逐断言顺序和计数后才汇入 `RELEASE_VERSION_ASSERT`，最后输出唯一 `RELEASE_VERSION_SUMMARY`。checksum 对象还严格核对整数计数/序号、布尔结果与非空字符串标签，字符串 `"1"` 或 `"true"` 不能冒充类型正确的证据。
- 共享入口要求连续编号、按清单顺序执行、五组各有非零断言、计数一致、全部成功和真实退出码 0。子脚本缺失、异常、C# 编译/解析失败、部分记录后提前返回或 `exit 0`、显式非零 exit、重复/非末尾完成、计数不符、零记录、缺任一组、旧三/四组证据均不能通过。只有 checksum 原始字符串、未通过父对象校验的 PASS 或仅第五组输出都不足以放行。子脚本在同一已报告运行时执行，不另用一个 pwsh 版本查询冒充运行时证据。
- 真实非零退出、启动错误或信号优先于输出里的成功声明；`NOT RUN:` 与旧中文 `跳过：` 在 stdout/stderr 中均被识别，不能降级为 PASS。
- 纯函数可在装有 pwsh 的非 Windows 环境执行；它的 PASS 不改变 Windows 原生门禁的 NOT RUN，也不代表真实 PE 版本、安装包来源、安装或升级已验收。

## 必需 Windows 覆盖

精确清单位于 `scripts/run-rust-tests.mjs` 的 `REQUIRED_WINDOWS_TESTS`，目前共 11 项：

1. DPAPI 密文前缀、加密解密往返、明文不泄露、同明文不同密文，4 项。
2. 配置凭据密文落盘、旧明文迁移、已加密配置重复读取不改写，3 项。
3. 同秘密重新加密不制造账户变化、凭据版本只在成功提交后改变，2 项。
4. 缓存目录不存在时失败回退、真实目录变更通知及静默超时，2 项。

删除、重命名、忽略或条件编译排除其中一项都会阻断门禁。用例需要改名时，应同时评审替代测试及清单，不把清单缩减当作修复。

## 日志的含义

`node scripts/run-rust-tests.mjs --log-file ...` 生成 schema v3 的 JSON，包括实际运行平台、架构、命令及明确 MSVC 目标、必需集合、逐测试完成行、逐必需项结论、完整 stdout/stderr、退出状态和原因。

- `rawCounts` 是 libtest 原始汇总，只供诊断。
- `counts` 仅在 Windows 发布覆盖完整通过时才可用；其他结论为 null，不以部分和或正常 return 凑通过数。
- `executed` 是已完成测试函数数，即 passed + failed，不是 assert 表达式数量。ignored 不算执行。
- 发行记录重新解析原始输出，并核对本机平台、命令、范围、清单、结论与计数。旧 schema、缺日志、损坏 UTF-8／JSON、篡改／不一致的字段都记为 `ERROR`，不以原文件自称的 PASS 放行。
- 源码门禁、安装包哈希、实际包来源及安装使用验收是不同证据。即使门禁 PASS 且记录哈希，也不能声称安装／升级或全部真机交互已验收。

发行版本共享入口的 `--log-file` 另生成 schema v2 的 `release-version-pure-functions` JSON：记录原始 pwsh 命令、平台、真实退出码（未启动／被信号终止为 null，不伪填 1）、信号、启动错误、完整 stdout/stderr、逐断言与五组执行数，以及 `powershell.runtime` 内同一执行进程的版本和来源。沿用历史 scope 和未改变结构的 schema，但 `requiredSuites` 必须精确为 `filename`、`pe-header`、`pe-version`、`pe-bytes`、`checksum-pure`，不能删除原四组；旧三/四组日志即使自称 schema v2 也不能通过。发行记录重新解析原始记录并核对运行时、结论、命令、退出状态与计数，缺日志、旧 schema（含 v1）或字段不一致记为 ERROR。运行时行和完成汇总各自的协议版本仍为 1，不等同于外层日志的 schema v2。表格中的退出码是共享入口的退出码，嵌入 JSON 中 `powershell.code` 是实际 pwsh 的退出码，两者不可混淆；`assertions` 是断言数，不能与 Rust 的测试函数数混称。

### 必需的 Windows 文件快照验收

五组源码门禁可跨平台执行，但不提供 Windows 文件共享/目录锁证据。发布前还必须在本机 NTFS 上按 [第 21 轮说明](REVIEW21_RELEASE_SNAPSHOT_REGRESSIONS.md) 执行 `verify-release-snapshot.windows-tests.ps1`，使用真实当前版本 PE，完成哈希后/版本前双屏障和句柄释放回归。这是独立的必需发行验收，不自动纳入源码纯函数计数；非 Windows 必须标为未执行，不能从五组源码 PASS 或合成故障注入推导它已通过。

### 必需的 Windows checksum 合成验收

`verify-release-checksum.windows-tests.ps1` 是另一项独立必需验收，当前为 **NOT RUN**。按 [第 26 轮说明](REVIEW26_CHECKSUM_SIDECAR_REGRESSIONS.md) 在 Windows、PowerShell 7+、本机 NTFS 的全新证据根执行。它只使用新建的不可执行合成字节，覆盖已存在 sidecar、hardlink/符号链接、并发创建、源与输出持锁、失败不覆盖/不删除，以及字面路径；不得把真实包设为破坏性夹具。需要符号链接权限时不得跳过后报整套通过。

两条源码入口不自动运行这个 Windows 套件；发行记录单独标记 `NOT RUN（本源码入口不执行）`，它不混入五组 assertions 或源码命令汇总。维护者须另存实际退出码、完整完成记录及证据目录。纯函数通过、Windows 合成套件通过、真实候选包的校验和生成、真实安装/升级验收是四种不同证据，不能互相替代。

### 原始证据保全与保留政策

- Rust 和版本门禁都先读取完整原始字节，再将同一快照交给校验器。可信结构与原始归档分开，不能校验一次读取、归档另一次读取。
- 报告中的 `untrusted-gate-file-snapshot` 保存临时路径、读取状态、原始字节数、SHA-256 和完整 Base64 字节。通过校验的日志另展示重新校验后的结构；被拒绝的损坏／旧 schema／篡改日志也保全原始字节，标为 `rejected` 和不可信诊断数据，不渲染其正文为 Markdown，不用其声明恢复 PASS。哈希只证明字节完整性，不证明来源可信。
- `missing` 与 `unreadable` 分开记录读取错误，无法读取时字节和哈希为 null，不伪造空日志。未读取到的原件不删除。空文件则按零字节完整归档，并保持 ERROR。
- **第 24 轮起不自动删除任何原始门禁日志或证据目录**，无论有效／被拒绝，报告写入成功／失败，或只输出 stdout。路径可在最后一次读取之后、删除之前被替换；反复比较字节、哈希或路径不能让按路径删除绑定到归档对象。因此移除清理操作及其前置重读，而不是增加又一次比较。报告仍只归档读取时的 A，不声称之后出现在原路径的 B 也已归档。
- 每轮使用 `mkdtempSync` 新建独立证据目录（POSIX 为 0700），以独占 `wx`、0600 预留两类原件；子入口写入原文件时保留其模式。新建报告也使用 0600。Windows 权限由临时目录继承的 ACL 决定，mode 数字不等于 Windows ACL 加固；请使用仅维护者可访问的 TEMP 和报告位置，原始输出可能包含环境诊断信息。
- **`--out` 必须使用不存在的新路径**。报告同样通过 `wx` 独占创建，已有报告、符号链接或硬链接目标均拒绝覆盖；不能因输出别名指向原件而截断证据，也不通过“先检查存在再写入”的竞态方案。仍要求写入与 flush 成功且逐字节读回一致；目标已存在、写入失败、部分写入、flush 失败、读回失败或内容不一致时退出非零。stderr 明确记录报告是否核对完成、每个快照的 validated／rejected／missing／unreadable 状态和源路径。只输出 stdout 不视作可靠落盘，但同样保留原件。空的预留文件若没有被子入口写入有效证据，也只会得到 ERROR。
- 文件中出现 PASS 文案本身不是成功生成报告的证明。必须同时核对本次命令最终退出码和 stderr，失败写入可能留下不完整或尚未确认的报告。维护者自行保存需要的原件并核实可靠归档后，再决定是否手工清理；脚本不会代替用户清理，也不会删除并发替换到这些路径上的文件。临时目录可能受到系统自身的清理策略影响，不能把暂存当作永久备份。

### 确定路径不作通配符展开

`verify.ps1` 的工作区定位、`verify-release.ps1` 的 C# helper 与 `package.json` 读取，以及纯字节／Windows 回归脚本的 C# 加载均使用 `-LiteralPath`。含 `[ab]` 的真实目录不应被解释为匹配旁路目录 `a` 或 `b`。`Add-Type -Path` 在零通配命中时可能回退到字面路径，因此不能说含方括号必失败，也不能只测一个孤立的方括号目录。`New-Item` 没有 `-LiteralPath`，保留其合法创建接口，不机械替换参数。

Windows 回归在新建证据根中建立 `run [ab]` 和 `run a`，后者含不同版本的 package 与会明确拒绝编译的 C# 诱饵。实际输出、helper 加载和主流程副本位于前者；另建立无旁路目录的 `no match [xy]`，同样检查定位、完整纯字节脚本及稳定主流程。控制夹具的证据根及祖先应选不含通配元字符的普通路径，脚本检查完整路径确实匹配旁路，避免外层方括号导致整条模式零命中而掩盖问题；真正受测的源码／证据目录始终包含方括号。定位探针只执行从真实 `verify.ps1` AST 提取的原始 Set-Location 语句，不执行该入口的构建或测试。纯字节脚本由新 pwsh 进程执行，核对非零断言和唯一完成汇总。这些路径回归的实际结果仍待用户在 Windows 运行，Node 中的源码断言不能代替它们。

旧日志保留其原始含义：可阅读旧中文跳过标记作诊断，但不能把旧 schema、旧 PASS 文案或本次执行缺失的证据升级成通过。

## 供维护者执行的命令

以下命令**尚未执行**。请在最终提交的干净 Windows 工作区中运行；输出文件可放在仓库外，以免证据生成期间造成工作区变脏。每次 `release:record --out` 选择一个尚不存在的新报告文件名，不会覆盖之前的报告。

```powershell
# 只验证门禁的拒绝行为，使用合成进程输出，不证明 DPAPI/Win32 已运行。
node --test scripts/tests/release-gates.test.mjs

# 包含 settings-transactions、desktop-ui-regressions、usage-fidelity、history-lifecycle、chart-accessibility、history-trend-interactions。
# 每个 .tsx 输出为独立 .mjs，再由 node --test 的文件级进程隔离执行。
npm run test:components

# 五组纯函数回归的共享入口，包含 checksum；只用合成输入，不检查真实安装包。
node scripts/run-release-version-tests.mjs --log-file ..\version-functions-1.3.1.json

# 独立必需的 Windows checksum 合成回归，仍为 NOT RUN，详见第 26 轮说明。
# 证据父目录已存在、每次根目录必须全新；不传入真实包。
pwsh -NoProfile -File scripts/verify-release-checksum.windows-tests.ps1 `
  -EvidenceDirectory 'C:\release evidence\round26-checksum-new'

# 真正执行 Rust（不可用上面的故障注入通过记录替代）。
node scripts/run-rust-tests.mjs --log-file ..\rust-1.3.1.json

# 两条完整源码入口都包含五组纯函数回归；后一条重新执行门禁并记录实际候选包哈希。
npm run verify
npm run release:record -- --out ..\release-1.3.1.md --installer <实际候选安装包路径>
```

需确认真实 Windows 日志中的 11 项全部为 PASS，且 `counts.executed`、完成行及汇总一致。还需按 [本机验收清单](ACCEPTANCE_1.3.1.md) 检查安装升级、DPAPI、凭据提交与缓存监听的真实行为。

## 故障注入回归（新增文本，未运行）

门禁脚本回归包含：非 Windows 常规单测、非 Windows 冒充全部 Windows 完成行、中文跳过、英文标记、stderr 标记、混合执行但缺一个必需项、忽略必需项、零测试、全忽略、只有汇总无完成行、总数不符、重复完成行、过滤测试、cargo 失败、工具启动失败、缺日志、旧 schema、篡改计数／清单／平台／架构／范围／命令／原始输出，以及组件门禁失败／零测试／无可解析计数。另保留完整合成成功路径和 Windows CRLF 输出路径。

版本纯函数注入另覆盖：pwsh 不可用、低于 7、版本与数值段不符、版本文本无法解析、版本／可执行文件来源无效、缺少／相对可执行路径、非 Core、运行时证据缺失／损坏／重复／迟到、脚本缺失、非零原生退出但输出声称成功、信号中止、空输出、旧 PASS 文案、零断言、仅汇总、缺失／重复／损坏汇总、损坏断言、编号／计数不一致、失败断言但退出 0、缺一组、未完成、只有 stderr 证据、中英文与 stderr 跳过标记、缺日志及篡改运行时／计数／退出码／命令／组清单／覆盖／平台／架构／范围／原始输出。合成通过路径验证非 Windows 的纯函数可通过，但整体 Windows 发布仍不得通过。

第 26 轮另补 checksum 缺脚本/异常/非零退出但输出声称成功、缺第五组/零断言/提前 `exit 0`、只有原始 checksum 字符串、只第五组而缺原四组、组顺序错误、失败断言、序号/计数不符、部分记录后返回、重复/非末尾汇总的进程输出注入。checksum 纯脚本还提取真实父校验函数，对逐对象完成协议做 18 类纯内存用例；Node 源码断言核对同进程实际调用和错误传播，但不冒充这些 PowerShell 或 Windows 用例已经运行。全部新增回归仅已编写，尚未运行。

原件保全注入覆盖两类日志的损坏 JSON、无效 UTF-8、空文件、旧 schema、篡改字段、文件缺失与读取失败；核对 Base64 还原后的每个字节、长度和 SHA-256，拒绝内容不会作为 Markdown 展示。报告完全写入失败／部分写入／静默截断／flush 失败／读回失败分别覆盖有效与被拒绝证据，检查原件仍完整存在。成功和仅 stdout 输出也分别检查有效／拒绝日志的保留说明。第 24 轮增加 Rust／版本两类 accepted／rejected 快照：在每次实际源读取返回 A 后以 rename 将路径换成未归档 B；若旧实现再次读取，则先恢复 A、再于该末次读取后换 B，重现“比较通过却删除 B”的窗口。修复后只读一次、报告归档 A、路径上的 B 保留；另检查已有报告不变、在真正报告写入前植入指向两类原件的硬链接也不能截断原件，以及 POSIX 原件／目录／新报告无组和其他用户权限。所有新增注入仅已编写，尚未运行。

故障注入在临时子进程中模拟平台与工具结果，生产脚本没有跳过平台或覆盖检查的开关。注入测试通过只能证明拒绝逻辑按预期工作，不能计作 Windows 原生覆盖。
