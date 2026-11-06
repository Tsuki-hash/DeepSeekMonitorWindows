# 第 25 轮：Windows 双屏障硬链接夹具逐字绑定

## 状态与问题

本轮仅编写源码、回归文本并静态审阅。**未运行构建、测试、PowerShell 脚本、安装包或应用；没有 Windows 实测通过记录，也未提交。** 以下步骤由用户在 Windows 本机执行。原有[真实主流程及证据边界](REVIEW21_RELEASE_SNAPSHOT_REGRESSIONS.md)继续适用。

受支持的 PowerShell 7.4.7 会把 `New-Item -ItemType HardLink -Target` 的目标解释为通配模式。当前夹具同时有真实 `run [ab]` / `parent with spaces [ab]` 与匹配的 `run a` / `parent with spaces a`：调用可以成功，却把 alias 链到 decoy。此时从 alias 写入未被生产目标的共享锁拒绝，属于夹具误绑定，不是共享锁失效。

不能通过删除方括号、删除旁路文件、提高 PowerShell 最低版本、使用不存在的 `New-Item -LiteralPath`，或依赖版本有差异的 `WildcardPattern.Escape` 来掩盖问题。

## 修复与接线

- 新增测试专用 `scripts/release-snapshot-test-hardlink.cs`，通过 Unicode、`ExactSpelling`、`SetLastError` 的 `CreateHardLinkW` 接收完整逐字路径。既不走 PowerShell provider，也不做转义、复制替代、删除后重试或失败跳过。生产 `verify-release.ps1` 与 `release-file-snapshot.cs` 的锁行为不变。
- Windows 屏障脚本把新 helper 复制进隔离的 `run [ab]/scripts`，通过 `Add-Type -LiteralPath` 加载。`run a/scripts` 中保留同名 `#error` 诱饵，误加载必须立即失败。
- 目标、alias、decoy 均由脚本在新的证据根内创建。用户原始安装包仅被读取，不成为硬链接目标。每例真实目录与旁路目录继续保留两段方括号模式，并断言完整目标模式确实匹配 decoy。
- 启动子进程前、子进程到达指定屏障后及释放后分别用 `GetFileInformationByHandle` 比较 **卷序列号 + file index 高/低 32 位**：alias 必须与真实 target 相同，两者必须与 decoy 不同。后两阶段还必须与启动前保存的 target 身份相同。相同内容、相同哈希、文件大小、路径字符串及链接创建成功都不能替代此身份断言。
- 身份探测只请求 metadata（访问掩码 0），共享 read/write/delete，并以 `SafeFileHandle`/`using` 释放每个句柄；它不负责提供受测共享锁。叶节点为目录或重解析点时拒绝作为普通文件夹具。此 helper 不是供不可信并发环境使用的通用路径安全 API；验收目录由用户独占，勿用 junction/网络盘/同步目录代替本机隔离 NTFS 目录。
- 每个失败的 Win32 调用立即保存 `Marshal.GetLastWin32Error()`，以 `Win32Exception.NativeErrorCode` 连同操作、路径保留。硬链接不支持、跨卷、权限、路径已存在及身份探测失败都中止该次回归，不记为共享锁成功，也不生成完成汇总。
- 两个屏障仍使用原 `File.Copy(replacement, alias, true)` 修改操作。只接受 sharing/lock violation（32/33），普通 ACL 错误不算成功。子进程释放句柄后原操作必须成功，且身份仍相同、真实目标已变为 B、decoy 文本未变。这里的内容哈希只检查修改结果，不用于证明硬链接身份。

## 待执行的双版本主流程矩阵

准备当前源码版本的真实稳定 PE、本机 NTFS、两个互不复用的证据根（必须尚不存在）。证据根及祖先不含通配元字符，内部 `run [ab]` 等路径由脚本生成。普通用户权限即可；不要靠管理员身份掩盖权限问题。两次运行使用同一个输入原件与同一份修复源码。

分别指定实际安装的 pwsh 完整路径；下面第二个目录是占位名称，须替换成**已确认修复该 provider 行为的 PowerShell 版本**，并记录其精确版本。不能仅凭“新版”判定修复，也不能用第二次结果代替 7.4.7 的结果。

```powershell
& 'C:\Tools\PowerShell-7.4.7\pwsh.exe' -NoProfile -File scripts/verify-release-snapshot.windows-tests.ps1 `
  -StableInstallerPath 'C:\release files\DeepSeekMonitor_1.3.1_x64-setup.exe' `
  -EvidenceDirectory 'C:\release evidence\round25-ps747'

& 'C:\Tools\PowerShell-fixed\pwsh.exe' -NoProfile -File scripts/verify-release-snapshot.windows-tests.ps1 `
  -StableInstallerPath 'C:\release files\DeepSeekMonitor_1.3.1_x64-setup.exe' `
  -EvidenceDirectory 'C:\release evidence\round25-fixed'
```

两次都须独立满足：

1. `summary.json` 记录实际 PowerShell 版本和当前可执行文件路径；子进程继续使用这一可执行文件，不依赖 PATH 中的另一个 pwsh。整体脚本退出 0、唯一末尾完成汇总存在且 `completed=true`。安装验收仍为 `NOT RUN`。
2. `AFTER_HASH 经 hardlink 写入` 与 `BEFORE_VERSION 经 hardlink 写入` 两例均有 `hardlink-identity-before-process.json`，其中 alias/target 的三项身份字段逐项相同、与 decoy 不同；两段方括号和可匹配旁路均存在。
3. 各例 `hardlink-identity-at-barrier.json` 再次满足身份前置条件；`result.json` 记录指定屏障、`mutationDeniedBySharing=true` 和真实共享冲突。主流程退出 2、结论 INCONCLUSIVE，仍报告 A 的哈希及 A 的版本不符，不出现静态 PASS。
4. 各例 `hardlink-identity-after-release.json` 仍证明链接正确。断言记录显示释放后**同一**修改成功、B 已到达真实 target、decoy 未变。不能只看子进程结束后“可以打开文件”。
5. 其余覆盖不减少：有/无旁路源码树的 LiteralPath 探针、其余六类修改的双屏障、已有可写句柄冲突、同进程 helper-only Dispose/中途失败释放检查均执行。不得以硬链接两例通过冒充整套验收通过。
6. 将证据根更换为含中文但无通配符的全新目录再执行一次，内部仍保留 `[]` 与 decoy，确认 Unicode API 的实机行为。长路径仍须按原文档另行验证，不能从普通路径通过推断。

## 待执行的失败及防假阳性矩阵

以下只在新的、可丢弃的隔离副本中操作，不改真实发行文件、不改系统 ACL、不删除现有证据目录。可使用单独的临时 PowerShell 进程以 `Add-Type -LiteralPath` 加载该测试 helper。此处列的是待执行场景，**尚未执行**。

- **误链 decoy**：只在临时脚本副本把 `Create($alias, $target)` 的第二参数改为 `$decoyTarget`。启动主流程前必须身份断言失败；不得等到共享锁断言失败才发现夹具错了。恢复副本后重跑，两屏障才可完成。
- **同字节非硬链接**：在另一个临时副本用普通复制生成 alias，哪怕 alias 与 target 字节完全相同，启动前身份检查仍须失败。不得改身份比较为哈希或长度比较。
- **同字节 decoy**：让 decoy 与 target 内容相同但保持独立文件，真正链接 target 的 alias 仍通过身份前置条件；链到 decoy 的 alias 必须失败。此反例仅用于证明身份比较与内容无关，不算完整屏障套件的通过记录。
- **链接已存在**：在可丢弃目录预建 alias，调用 `LiteralHardLink.Create` 必须失败并保留实际原生错误码，已有 alias 及目标不得被删除/覆盖；不得自动变成成功或复制。
- **目标不存在/不可访问**：使用新隔离目录下不存在的目标，或仅在该临时夹具中设置明确的拒绝权限。保留 Win32 原始错误码（例如 2/3/5，以实际 API 返回为准），不把它算作 32/33 的锁成功；权限改动结束后由用户恢复，勿指向原始包或系统目录。
- **跨卷**：若本机有两个本地 NTFS 卷，各新建可丢弃目录，把 target 与 alias 放在不同卷。创建须失败，保留 API 返回码（通常为 17），不回退为复制或悄悄把 alias 放回目标卷。没有第二个卷时明确记为该额外场景未执行，不宣称通过。
- **句柄释放**：成功/失败身份读取后，在同进程直接对可丢弃文件执行独占打开或重命名。应成功，证明身份探测未遗留自己的限制性句柄；这项不能替代生产 helper 的既有 Dispose 回归。
- **接线失效**：在临时源码副本中删除新 helper 或破坏其编译，应在进入 hardlink 屏障前失败，不能忽略并继续生成整套完成汇总。将加载改回 `Add-Type -Path` 时，同名 `#error` 旁路必须阻止假通过。

失败时查看对应 `case N/failure.json` 的 `nativeErrorCode`、异常文本及已生成的身份文件、stdout/stderr；缺少完成汇总意味着整套回归未完成。发生身份不符的失败没有 Win32 错误码是正常的：它是明确的夹具前置条件失败，不应伪造原生码。

## 源码门禁与证据边界

`scripts/tests/release-gates.test.mjs` 新增三组静态接线断言，保护新 helper 的逐字加载、`CreateHardLinkW` Unicode 声明、原生错误保存、三字段身份比较及屏障前校验顺序，并禁止恢复 `New-Item ... HardLink` 或 `WildcardPattern.Escape` 替代路线。源代码门禁通过仍不是 Windows API、共享锁或版本矩阵的实测结果。本轮没有执行该门禁。
