# 第 21 轮：安装包校验绑定同一文件快照

## 状态和范围

以下实现、回归脚本和操作步骤仅已编写并静态审阅。**没有执行项目构建、测试、PowerShell 脚本、安装包或应用，也没有 Windows 实机通过记录。** 用户在本机完成验证后，另行保存实际结果。

原 `verify-release.ps1` 分别按路径计算 SHA-256、读取二进制、读取 PE 版本。若在这些步骤之间重打包、签名覆盖或替换路径，可能把 A 的哈希和 B 的内容/版本组合成静态 PASS。末尾再次比较哈希不足以处理 A → B → A。

## 修复后的证据边界

- 先以 `FileAccess.Read + FileShare.Read` 打开候选文件，拒绝并发写入和删除共享。已有可写/可删除句柄与该打开方式冲突时，不等待另一个版本、不重新尝试换包，直接保守阻断。所有检查结束后在 `finally` 释放句柄。
- `release-file-snapshot.cs` 从实际句柄取得本机 NTFS 卷 GUID 规范路径和卷序列号/文件 ID。规范路径不依赖可能重新映射的盘符。由根到叶以 **GENERIC_READ** 打开父目录且不共享写入/删除，再确认路径仍指向原文件 ID；仅请求 `FILE_READ_ATTRIBUTES` 不足以充当共享锁，不能替代这里的访问模式。
- 父目录链拒绝重解析点。完整锁链中的每个祖先都保留一个不可删/改名的子项，而 NTFS 不允许给非空目录设置重解析点。不能错误地把“不共享写入”本身说成可以阻止一切属性类 reparse 操作。构建锁链时若路径已变化、不能规范化或身份不一致，必须失败封闭。
- 文件共享限制作用于 NTFS 文件对象，因此从另一 hardlink 写入也应被拒绝。规范目标的祖先改名被目录句柄阻止。输入 junction/别名若能解析到支持的规范目标，则检查的是输出中明确列出的**被锁文件**；别名本身后来被重新指向，不会改变这次捕获的字节或让资源改从新目标读取。
- 只读一次完整字节数组。SHA-256、仓库字符串、PE 基本结构以及 **RT_VERSION 版本资源全部来自同一个数组**。不再调用 `.NET FileVersionInfo.GetVersionInfo`，因为它可能把未锁定 `.mui` 侧车中的字符串与 exe 的固定字段合并，不能作为“所有字段来自此安装包”的保证。
- `release-pe-version.cs` 解析 PE32/PE32+ 的资源 RVA、资源三级目录、固定版本字段和全部语言字符串表。要求 VERSIONINFO 使用唯一 numeric 名称 ID 1；校验目录 named/numeric 分区及 numeric ID 严格升序、无重复，不能把 Windows 不采用的任意名称当作版本资源。另检查边界、截断、重叠节、块长度、UTF-16、重复字段和严格八位十六进制表键；不存在或不能可靠解析时为 INCONCLUSIVE。多个语言资源/字符串表都须满足原版本规则，不能只挑一个匹配语言。
- 本校验器还要求唯一 `VarFileInfo/Translation` 与全部 `StringTable` 一一匹配。不把缺失映射或仅存在任意语言表解释成可用版本，不猜测 Windows 的默认语言回退；缺失、重复或不一致为 INCONCLUSIVE。**这是保守的支持限制，不是 Windows 规定 VarFileInfo 必需**，部分合法但省略 Var 的 PE 也会被阻断；真实 NSIS 兼容性仍须用户验收。
- 原文件名 token、stable `x.y.z`/`x.y.z.0`、固定 revision、可缺省 ProductVersion、预发行标记、仓库证据和三态优先级保持：确定哈希错误/旧仓库为 FAIL / 1；其他不足为 INCONCLUSIVE / 2；全部静态要求满足才为 PASS / 0。已发现的 FAIL 不会被后续锁、I/O 或资源异常清除。

这是有意保守的本机 NTFS 方案。非 Windows、网络共享、FAT/ReFS、无法取得卷 GUID、目录访问权限不足、共享锁冲突、无法确认身份、资源布局不支持或读取失败，都不能报 PASS。不要关闭这些检查以获得绿色结果。长路径和 Unicode 路径也须实际验收；支持与否以本机 API 是否完整成功为准，不能静默降级。

句柄只在校验期间提供保证，不能保证结束后发布文件永远不被修改。仍须对最终发布附件使用独立可信哈希；静态 PASS 不证明提交来源、签名有效性、安装/升级或检查更新的真实行为。

## 三类回归不能互相替代

### 1. 原有版本纯函数门禁

```powershell
pwsh -NoProfile -File scripts/verify-release-version.static-tests.ps1
```

原三组 AST 规则断言保留，并新增第四组 `pe-bytes`：同一进程实际运行下一节的纯字节脚本，清空并核对其退出码，验证返回的逐次断言及唯一末尾完成对象（含计数），再汇入原协议。`npm run verify` 与 `npm run release:record -- ...` 都经既有共享入口强制执行四组并保留真实证据；旧三组、缺脚本/编译失败、部分记录提前返回、完成记录缺失/重复/非末尾/计数错误、显式非零退出、零记录或缺 `pe-bytes` 不能通过。该门禁仍没有打开真实候选包，不验证文件锁或主流程竞争，不能拿它的 PASS 作为这次竞态已实机通过的证据。

### 2. 新增纯字节解析回归

```powershell
pwsh -NoProfile -File scripts/verify-release-pe-bytes.static-tests.ps1
```

仅用合成 PE 字节和原版本规则验证：PE32/PE32+、缺省 ProductVersion、多语言表全部检查、缺失/错配 Translation、固定字段与文本冲突、预发行标记、表键空白/非 hex、重复 FileVersion、非标准名称 ID 2、目录分区错位、语言 ID 乱序/重复、目录/数据 RVA 越界、错误目录层级、短块、签名错误、部分 VA 重叠及截断。它不运行发行校验主流程，也不测试 Windows 共享模式。所有新增断言仍待用户执行。

另从父入口 AST 提取真实的返回协议校验纯函数，对缺完成、仅完成、错计数、未完成、重复/非末尾完成、虚假 passed/failed、坏序号、失败/非布尔断言和非零退出进行合成故障注入；完整记录须能通过。这些协议断言与 C# 解析断言一起计入 `pe-bytes`，仍只是源码回归证据。

### 3. 必需的 Windows 真实主流程屏障回归

```powershell
pwsh -NoProfile -File scripts/verify-release-snapshot.windows-tests.ps1 `
  -StableInstallerPath 'C:\release files\DeepSeekMonitor_1.3.1_x64-setup.exe' `
  -EvidenceDirectory 'C:\release evidence\round21-new-run'
```

这是发布前必须完成的独立 Windows 验收，不与跨平台源码门禁合并计数。非 Windows 必须保持未执行，不能冒充通过。要求 PowerShell 7+ Core、本机 NTFS 和当前源码版本的真实 PE。证据目录必须尚不存在。脚本只读取提供的原件，所有写入、替换和签名失效的修改都仅发生在新建隔离目录中；**不会执行、安装、签名该 PE，也不会构建项目**。

- B 为当前真实 PE 的隔离副本，追加当前仓库明文 marker，使仓库辅助证据可控。A 从 B 的副本修改固定 FileVersion build 位，文本保持不变。自算哈希只用于构造回归，不是发行来源证明；这些副本不应发布。
- 先对未插入屏障的完整脚本副本验证 B 为静态 PASS / 0，A 为真实固定版本不符的 INCONCLUSIVE / 2。若输入版本不受支持、自带旧仓库字符串、缺资源或文件锁环境不支持，测试必须失败，不能跳过该基线后宣称竞态通过。
- 用命名事件，在完整脚本副本中的“哈希完成后”和“版本读取前”两个固定位置暂停。不是依赖 `Sleep` 猜时序，也不替换哈希、PE 解析或文件锁实现；生产脚本仅有注释锚点，没有测试参数或绕过检查的开关。
- 每个屏障分别尝试：同路径覆盖、原子替换、重命名 A 后换 B、删除 A 后换 B、A → B → A、另一 hardlink 写入、父目录改名后重建路径。修改必须明确因 sharing/lock violation 被拒；普通权限错误不算成功。主流程继续后必须仍报告 A 的哈希和不符的固定版本，INCONCLUSIVE / 2，不能静态 PASS。即便结束哈希等于 A，也不能代替“修改确被拒绝”的证据。
- 子进程退出后同一修改必须可成功，以排除错误路径/ACL 造成的假阳性。另有**明确标成 helper-only** 的同进程案例：Open 期间拒写、Dispose 后文件可写且祖先可改名、Open 在更深父目录锁冲突时回收已获取的叶/祖先句柄。不能单凭子进程退出后可写，声称 `Dispose` 已验证。
- 额外主流程案例覆盖已有可写句柄、空格路径、缺期望哈希、错误哈希优先、普通文本不能冒充 PE、旧仓库 FAIL 优先，以及先发生哈希 FAIL 再抛资源解析异常仍保持 FAIL / 1；非标准版本名称 ID 2、目录分区错位也走完整脚本，要求 INCONCLUSIVE / 2。
- 每例保存完整 stdout/stderr、真实退出码、屏障名称、修改结果/异常和断言。全部完成才生成独立 scope 为 `release-snapshot-windows-main-flow` 的 summary；helper-only 断言单独标识，安装验收仍为 NOT RUN。超时、未到屏障、进程失败、未完成或缺少汇总都不能作为通过。

## 仍需用户完成的 Windows 文件/路径验收

1. 在原始最终安装包上直接运行未插桩的 `verify-release.ps1`，使用独立来源的 SHA-256；保留规范被锁路径、文件 ID、哈希、所有资源表和退出码。压缩内容里找不到当前仓库仍 INCONCLUSIVE，不能借测试副本的 marker 给原包放行。
2. 在含空格/中文的路径、超过 260 字符的路径及经 NTFS junction 输入别名的路径上分别运行。能确认同一目标时应与普通路径结果一致；不能确认时明确 INCONCLUSIVE，不可混用别名的新文件。
3. 对真实带多个语言资源的 NSIS 样本检查所有输出表。与 Windows 属性页的版本值比较仅作旁证，因为属性页也可能读取 MUI。解析器遇到未知合法格式应留存原字节及资源结构再补支持，不能删掉检查放行。
4. 文件校验期间由另一个进程/签名工具尝试写入，预期写入者收到共享冲突或校验在最初获取锁时 INCONCLUSIVE；不能一边成功改包一边得到混合证据 PASS。工具如果改用另一个输出文件，应在其完成后重新校验真正的最终附件。
5. 静态校验之外，另行完成安装、升级、检查更新、托盘、通知、DPI 等人工验收。本轮没有执行这些动作。

相关 Windows 规则：

- [CreateFile：访问权限与共享模式](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Reparse points：目录必须为空](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)
- [GetFileVersionInfoEx：MUI 版本信息合并](https://learn.microsoft.com/en-us/windows/win32/api/winver/nf-winver-getfileversioninfoexw)
