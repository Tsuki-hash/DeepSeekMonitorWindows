# 第 27 轮：checksum 释放证据与负变异

## 状态与边界

仅修改测试、测试夹具和文档并静态审阅。**未运行构建、测试、PowerShell 脚本、helper 编译、安装包或应用；未提交。全部新增验收仍为 NOT RUN。**

当前 `release-checksum.ps1` 已有输出和源快照两处 `Dispose`。本轮修复的是测试可假通过，不是声称已发现生产泄漏：

- 旧字符串检查把 `IndexOf(output.Dispose)` 与源释放位置直接比较。删除输出释放后返回 `-1`，仍可能满足“小于”。
- 旧 Windows 检查先等待子进程退出再重开文件。即使生产未显式释放，OS 结束进程也会关闭句柄，不能据此证明 finally 正确。
- 先关闭输出再制造 Flush 错误，同样不能证明错误路径最后执行了释放。

第五组 `checksum-pure`、原逐断言/唯一末尾汇总协议和失败传播不变。源码结构检查不代替 Windows 实测，合成 Windows 验收也不代替真实发行包验收。

## 纯函数与结构回归

入口仍是 `scripts/verify-release-checksum.static-tests.ps1`。不执行生产主流程，也不执行任何负变异主流程。

1. AST 中 `$output.Dispose()` 与 `$snapshot.Dispose()` 各存在且唯一；每个都是所属 finally 的唯一无条件语句。
2. 对应资源获取赋值必须存在且唯一，紧接各自 try/finally；输出 try 直接嵌套在源快照 try 内。确认结构后才比较 AST 偏移，不存在 `-1` 当作顺序正确的分支。
3. 唯一 `Write-Output $outputPath` 必须在顶层、外层完整 try/catch 之后。
4. 负变异分别删除每个 Dispose、互换两个 Dispose、重复每个 Dispose、把输出 Dispose 放进永不执行分支/只留注释，以及删除/重复/提前成功输出，都必须被同一个结构检查拒绝。
5. 新输出绑定检查必须以原 SafeFileHandle 和输出路径调用，处于真实 Flush/读回之后、输出 try 最后且早于两层释放；缺失、重复、条件化和移到释放后四种变异必须拒绝。

用户可在 PowerShell 7+ 自行运行原入口或包含第五组的 `scripts/verify-release-version.static-tests.ps1`。完成需零退出码、非零连续真实断言和唯一末尾完成汇总；本说明不是通过记录。

## Windows 活进程释放矩阵

入口仍是 `scripts/verify-release-checksum.windows-tests.ps1`，只接受新建证据根，不接受真实包路径。脚本副本、合成字节、helper 副本与探针文件都在隔离目录中；合成 `.exe` 永不启动，不修改真实发行产物。

在新的 PowerShell 宿主里以 `&` 调用生产脚本副本。生产脚本返回（含 `exit 1`）后，**同一个宿主进程**立刻对源和 sidecar 各做独占读写重开及重命名/复原。宿主持有两个对象的强引用，防止 GC/finalizer 代替生产 Dispose。保存探针后宿主等待事件，父测试确认 PID 一致、原宿主仍存活、每项证据唯一且结果正确，才允许测试清理与进程退出。

三条生产路径各自交叉三个释放版本，共九个用例：

- 正常成功。
- 只写一个字节后抛出异常，保留部分 sidecar。
- 测试专用 `FileStream` 子类在实际 `Flush(true)` 调用处抛错，**不提前关闭句柄**。

每条路径都运行未变异版本、删除输出 Dispose 的副本、删除源快照 Dispose 的副本。未变异版本的四个探针都须成功，输出 Dispose 计数为一。删除哪个释放，对应对象的重开和重命名就必须失败，且必须是实际 Win32 32/33，不接受 ACL、路径丢失等其他错误冒充。释放门禁必须拒绝这两个负变异；测试只在收集并验收证据之后主动清理它们。

`live-release-probe.json` 保留生产与宿主 PID、生产退出码、强引用状态、Flush/Dispose 调用次数、四项探针结果与错误。每个用例仍有原格式 `result.json`、stdout/stderr；`result.json` 另标记 `disposalMutation` 和 `releaseAccepted`。生产退出码不与宿主结束码混淆。旧“进程退出后可重开”场景保留为终态检查，明确不作为生产 Dispose 证据。

## 输出绑定的 Windows 场景

完整设计见 [输出绑定回归说明](REVIEW27_CHECKSUM_BINDING_REGRESSIONS.md)。同一 Windows 套件另包含：

- 独立正向能力夹具：保持空普通文件的 ReadWrite/FileShare.None 句柄，用真实 `FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES`、share 7 和 `FSCTL_SET_REPARSE_POINT` 原位设置 symlink；核对文件 ID 未变和原始 reparse 数据，目标字节不变。不能用 `CreateSymbolicLinkW` 创建另一个文件替代。
- 从原句柄取得真实卷 GUID 路径。真实绑定 helper 对转换前普通对象须成功，对转换后原对象须以明确的“非普通/存在 reparse”错误拒绝。这样即使完整主流程在 Write/Flush 更早失败，也有独立 helper 分支证据。
- 在真实 `BEFORE_WRITE` 屏障，先证实输出的数据写与 rename 被 32/33 拒绝，再把空 sidecar 原位改成指向合成源或哨兵的 reparse。主流程不得输出成功，源/哨兵/旁路字节不变，异常输出本体与原始 reparse 数据保留。
- 仅在隔离副本把待校验路径改成源路径，要求不同文件 ID 失败，原 sidecar 不删除。此处不改写源文件。

权限或 API 能力不足时，整套显式失败/NOT RUN，不生成完整成功汇总。Developer Mode 下 `CreateSymbolicLinkW` 成功不能证明原生 FSCTL 的所需权限成立；测试不更改系统权限或配置。

## 用户执行与证据

```powershell
pwsh -NoProfile -File scripts/verify-release-checksum.static-tests.ps1
pwsh -NoProfile -File scripts/verify-release-checksum.windows-tests.ps1 `
  -EvidenceDirectory 'C:\release evidence\round27-checksum-unique'
```

第二条要求 Windows、PowerShell 7+ Core、本机 NTFS、已存在且仅自己使用的普通父目录，以及当前进程具备实际 reparse 操作能力。证据根必须全新，根及祖先不含通配字符。可用不同已安装版本和不同新根另行验收；不得改用真实安装包作可写夹具。

完整通过仍要求零退出码、全部逐断言通过、唯一 `RELEASE_CHECKSUM_WINDOWS_SUMMARY`、`summary.json.completed=true`，并与实际 case/result、assertions 和新增 live/capability/reparse 证据一致。任何缺项、超时、权限失败或未完成汇总均不得记录为通过。真实包始终标记 `NOT RUN`。
