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

- 原脚本仅从 `verify-release.ps1` 的 AST 提取纯函数，对文件名版本、内存 PE 头、合成版本资源三组输入执行断言，不运行发行校验主流程。
- 每次断言输出一行 `RELEASE_VERSION_ASSERT`，完整结束后输出唯一的 `RELEASE_VERSION_SUMMARY`。共享入口要求顺序编号、三组各有非零执行、计数一致、全部成功和真实退出码 0。零断言、只有汇总、旧的一句 PASS、未完成、重复／损坏的汇总都不能通过。
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
- 发行记录重新解析原始输出，并核对本机平台、命令、范围、清单、结论与计数。旧 schema、缺日志、篡改／不一致的字段都记为 `ERROR`。完整结构化日志写入发行记录后才清理该次临时日志。
- 源码门禁、安装包哈希、实际包来源及安装使用验收是不同证据。即使门禁 PASS 且记录哈希，也不能声称安装／升级或全部真机交互已验收。

发行版本共享入口的 `--log-file` 另生成 schema v1 的 `release-version-pure-functions` JSON：记录原始 pwsh 命令、平台、真实退出码（未启动／被信号终止为 null，不伪填 1）、信号、启动错误、完整 stdout/stderr、逐断言与三组执行数。发行记录重新解析原始记录并核对结论、命令、退出状态与计数，缺日志、旧 schema 或字段不一致记为 ERROR。表格中的退出码是共享入口的退出码，嵌入 JSON 中 `powershell.code` 是实际 pwsh 的退出码，两者不可混淆；`assertions` 是断言数，不能与 Rust 的测试函数数混称。

旧日志保留其原始含义：可阅读旧中文跳过标记作诊断，但不能把旧 schema、旧 PASS 文案或本次执行缺失的证据升级成通过。两类门禁日志都在嵌入完整发行记录后才清理本次临时文件。

## 供维护者执行的命令

以下命令**尚未执行**。请在最终提交的干净 Windows 工作区中运行；输出文件可放在仓库外，以免证据生成期间造成工作区变脏。

```powershell
# 只验证门禁的拒绝行为，使用合成进程输出，不证明 DPAPI/Win32 已运行。
node --test scripts/tests/release-gates.test.mjs

# 包含 settings-transactions、desktop-ui-regressions、usage-fidelity、history-lifecycle、chart-accessibility。
# 每个 .tsx 输出为独立 .mjs，再由 node --test 的文件级进程隔离执行。
npm run test:components

# 版本纯函数回归的共享入口，只用合成输入，不检查真实安装包。
node scripts/run-release-version-tests.mjs --log-file ..\version-functions-1.3.1.json

# 真正执行 Rust（不可用上面的故障注入通过记录替代）。
node scripts/run-rust-tests.mjs --log-file ..\rust-1.3.1.json

# 两条完整入口都包含版本纯函数回归；后一条重新执行门禁并记录实际候选包哈希。
npm run verify
npm run release:record -- --out ..\release-1.3.1.md --installer <实际候选安装包路径>
```

需确认真实 Windows 日志中的 11 项全部为 PASS，且 `counts.executed`、完成行及汇总一致。还需按 [本机验收清单](ACCEPTANCE_1.3.1.md) 检查安装升级、DPAPI、凭据提交与缓存监听的真实行为。

## 故障注入回归（新增文本，未运行）

门禁脚本回归包含：非 Windows 常规单测、非 Windows 冒充全部 Windows 完成行、中文跳过、英文标记、stderr 标记、混合执行但缺一个必需项、忽略必需项、零测试、全忽略、只有汇总无完成行、总数不符、重复完成行、过滤测试、cargo 失败、工具启动失败、缺日志、旧 schema、篡改计数／清单／平台／架构／范围／命令／原始输出，以及组件门禁失败／零测试／无可解析计数。另保留完整合成成功路径和 Windows CRLF 输出路径。

版本纯函数注入另覆盖：pwsh 不可用、脚本缺失、非零原生退出但输出声称成功、信号中止、空输出、旧 PASS 文案、零断言、仅汇总、缺失／重复／损坏汇总、损坏断言、编号／计数不一致、失败断言但退出 0、缺一组、未完成、只有 stderr 证据、中英文与 stderr 跳过标记、缺日志及篡改计数／退出码／命令／组清单／覆盖／平台／架构／范围／原始输出。合成通过路径验证非 Windows 的纯函数可通过，但整体 Windows 发布仍不得通过。所有新增注入仅已编写，尚未运行。

故障注入在临时子进程中模拟平台与工具结果，生产脚本没有跳过平台或覆盖检查的开关。注入测试通过只能证明拒绝逻辑按预期工作，不能计作 Windows 原生覆盖。
