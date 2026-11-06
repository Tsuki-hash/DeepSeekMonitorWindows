# 第 18 轮：安装包静态版本检查

> 第 21 轮已进一步修复校验期间的并发替换：持有 Windows 本机 NTFS 拒写/拒删句柄，哈希、PE/仓库及 RT_VERSION 全部取同一字节快照；不再通过可能合并外部 MUI 的 FileVersionInfo 读取正式校验字段。新的限制、独立回归和未执行的 Windows 验收见 [同一文件快照回归说明](REVIEW21_RELEASE_SNAPSHOT_REGRESSIONS.md)。下面提及 FileVersionInfo 的历史实现和人工观察步骤，不代表当前主流程仍使用该 API。

> 第 24 轮同步说明：第 18 轮“末行报告纯函数回归 PASS”是旧输出约定，不能作为当前门禁通过证据。当前必须有同一进程的 PowerShell 运行时行、四组非零逐断言（含 `pe-bytes`）、唯一完整汇总和真实成功退出码。旧三组日志或单独的 PASS 文案均不够；原始门禁日志现一律保留、不自动删除。详见 [当前发布门禁](RELEASE_GATES_1.3.1.md)。

## 修复范围与验收状态

`scripts/verify-release.ps1` 原先使用无边界的文件名子串匹配，源码 `1.3.1` 会误认 `1.3.10`。文件名、哈希和明文仓库地址都符合时，即使输入不是 PE 或没有版本资源，也可能得到静态 PASS。

本次修改仅编写并静态审阅，**未运行回归脚本、发行校验、构建、安装包或应用**。下面的命令和预期结果供用户在 Windows 本机验收，不代表已有执行结果。

## 判定规则

- 文件名版本改为完整 token 匹配。`1.3.10`、`11.3.1`、`1.3.1.0`、`1.3.1-beta` 和 `1.3.1+build` 都不能冒充源码 `1.3.1`。支持通常的下划线、空格和版本前连字符分隔；其他重命名形式可能 INCONCLUSIVE。
- 文件名始终只是辅助证据。另行检查 DOS/PE/COFF、optional header 与 section table 的基本结构，然后调用 .NET `FileVersionInfo.GetVersionInfo` 读取真实文件的版本资源。只读，不加载、不执行、不解包安装程序。
- 对 stable 源码 `x.y.z`，要求 PE `FileVersion` 文本完整等于 `x.y.z` 或 `x.y.z.0`，且固定数字 FileVersion 必须恰为 `x.y.z.0`。仅去掉文本首尾空白，不截取前缀、拆出子串、吞掉非零 revision 或忽略后缀。
- NSIS 模板的 `ProductVersion` 文本可能缺失，因此它不是必需字段，也不能替代 `FileVersion`。若存在，则同样必须完整匹配上述两种形式。`FileVersion` 文本缺失，即使固定数字或 ProductVersion 匹配，也为 INCONCLUSIVE。
- PE 标记为预发行版、版本资源缺失/不可读、固定和文本字段冲突、未知格式或版本不符，均保守记为 INCONCLUSIVE。源码若带 prerelease/build metadata、四段版本、前导零或数字超出 UInt16 范围，也不猜测 NSIS 映射，保持 INCONCLUSIVE。将来如需增加兼容格式，应先留存真实构建产物的字段证据并补回归，而不是放宽为子串或仅比较三段数字。
- 没有改动原 SHA-256、当前/旧仓库明文检索及三态优先级：哈希不符或发现旧仓库仍 FAIL（退出 1）；没有确定错误但任一检查不充分为 INCONCLUSIVE（退出 2）；只有所有要求满足才静态 PASS（退出 0）。缺少期望哈希、没有找到当前仓库或文件名不符的原因继续累计，不会被 PE 成功清除。

静态 PASS 只表示这些静态检查一致。版本资源可以被复制或修改，PE 结构检查不是完整 Windows 加载器验证，哈希也只表示与给定值一致。**文件名和 PE 元数据都不能证明安装包绑定当前提交，更不能代替安装后检查更新、托盘、通知、DPI、升级等验收。** 提交绑定仍须可信构建来源、对应发布产物和独立获取的哈希证据。

## 独立回归脚本文本

第 18 轮新增 `scripts/verify-release-version.static-tests.ps1` 时，通过 PowerShell AST 提取三个纯函数验证文件名边界、PE 结构内存 fixture 和版本字段 fixture。当前入口还强制运行 `pe-bytes` 第四组，仍不执行发行校验主流程或任何安装包。用户可自行运行：

```powershell
pwsh -NoProfile -File scripts/verify-release-version.static-tests.ps1
```

当前预期：真实退出码为 0，有 `RELEASE_VERSION_RUNTIME`、四组非零 `RELEASE_VERSION_ASSERT` 及唯一完整的 `RELEASE_VERSION_SUMMARY`，计数和运行时来源一致。仅看到旧 PASS 字样或部分断言不能放行。即使这些要求满足，也不能证明真实 NSIS 产物的字段格式、Windows 文件锁或安装行为正确，仍需下一节及第 21 轮独立本机验收。

## Windows 本机发行验收

1. 在当前源码树中使用真实待发布 NSIS 安装包，先只读观察资源。将示例路径替换为实际文件：

   ```powershell
   $installer = 'C:\path\DeepSeekMonitor_1.3.1_x64-setup.exe'
   [Diagnostics.FileVersionInfo]::GetVersionInfo($installer) |
       Format-List FileVersion, FileMajorPart, FileMinorPart, FileBuildPart, FilePrivatePart, ProductVersion, IsPreRelease
   ```

   源码为 `1.3.1` 时，受支持的 FileVersion 文本为 `1.3.1` 或 `1.3.1.0`，固定字段为 `1 / 3 / 1 / 0`。ProductVersion 可空，非空必须一致。保留实际字段输出；未知格式不得改名或忽略检查后宣称通过。

2. 对照独立可信的发布/构建记录取得 SHA-256，再运行校验。不要把本机刚计算的哈希当成已经核实发布来源的证据：

   ```powershell
   pwsh -NoProfile -File scripts/verify-release.ps1 -InstallerPath $installer -ExpectedSha256 '<独立取得的64位SHA-256>'
   $LASTEXITCODE
   ```

   只有文件名、PE 版本、给定哈希、仓库检查都充分时预期静态 PASS / 0。压缩内容中找不到当前仓库仍应 INCONCLUSIVE / 2，这是已有保守规则，不能为获得 PASS 放宽。

3. 对安装包的临时副本检查文件名边界：仅把副本文件名中的 `1.3.1` 改为 `1.3.10`，其他条件不变，预期包含“文件名与版本不匹配”且不能 PASS。不要改动原发布文件。

4. 使用隔离临时目录制作普通文本 fixture，内容只含 `Tsuki-hash/DeepSeekMonitorWindows`，文件名使用源码当前版本并以 `.exe` 结尾。仅对这个 fixture 计算自己的匹配哈希后交给校验脚本，**不要启动它**。预期 PE 结构不足、INCONCLUSIVE / 2，即使哈希、文件名、仓库字符串都匹配也不能 PASS。这里自算哈希仅用于回归构造，不是发布来源证明。

5. 若有已知旧版本或无版本资源的真实 PE 样本，在副本上核对：改名不能掩盖真实 FileVersion 不一致或缺失；预期 INCONCLUSIVE / 2。错误哈希仍应 FAIL / 1；普通文本 fixture 加入 `Tsuki-hash/DeepSeekMonitorWin/releases` 后，即使 PE 不能判定，也必须保留 FAIL / 1 优先级。未提供 `-ExpectedSha256` 时必须仍保留缺哈希的 INCONCLUSIVE 原因。

6. 静态验收后，用户另行决定是否安装并完成检查更新、托盘、通知、DPI、升级等人工验收。本次修改没有执行这些动作。
