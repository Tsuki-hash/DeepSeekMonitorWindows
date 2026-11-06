# 第 22 轮：NSIS 版本资源兼容与拒绝边界

## 当前状态

仅完成源码修改、官方生成器对照和静态审阅。**未执行构建、项目测试、PowerShell 脚本、安装包、应用或 Windows 实机验收。以下预期都不是已获得的通过结果。** 本轮没有读取用户 NSIS 缓存或真实发行 exe，因此没有确认其实际编译器版本和资源布局。

`package-lock.json` 锁定 `@tauri-apps/cli` 2.11.2；该版本 Windows bundler 默认下载 NSIS 3.11。它也会复用已存在且满足检查的工具目录，故“默认下载 3.11”不能证明用户当前缓存或候选包实际由 3.11 产生。当前 `tauri.conf.json` 只配置 installerIcon，没有自定义 NSIS 模板或语言列表；默认模板的 VIAddVersionKey 没有 `/LANG`，通常生成一个语言版本资源。多语言资源是合法 NSIS 扩展覆盖，不声称当前项目必然生成多份资源。

## 可核对的官方源码差异

1. [Tauri CLI 2.11.2 的 bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)：NSIS_URL 指向 nsis-3.11.zip，并存在已有工具目录复用分支。
2. [同版本 installer.nsi](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)：使用 VIProductVersion，并写入 FileVersion 及 ProductVersion 文本；校验器仍保留其他 NSIS 模板可缺 ProductVersion 文本的既有支持。
3. [NSIS v311 ResourceVersionInfo.cpp](https://github.com/nsis-dev/nsis/blob/v311/Source/ResourceVersionInfo.cpp)（读取时文件 blob 为 `97d797a14e6800aa174563f1a0c1628db9894efb`）：构造器把 VS_FIXEDFILEINFO 清零，只初始化 signature、OS、type，故 dwStrucVersion 为 0。ExportToStream 把 StringTable、StringFileInfo、VarFileInfo 的空容器 wType 写为 0；字符串叶仍为 1，Translation 叶仍为 0。
4. 同一 ExportToStream 只输出被选中的一个 StringTable，Translation 却输出所有已声明语言，当前语言在第一项。[build.cpp 的 AddVersionInfo](https://github.com/nsis-dev/nsis/blob/v311/Source/build.cpp) 则按每个语言调用 ExportToStream，写入 RT_VERSION / numeric ID 1 / 对应 LANGID。
5. [NSIS v311 script.cpp](https://github.com/nsis-dev/nsis/blob/v311/Source/script.cpp) 的 VIProductVersion 分支设置固定 ProductVersion，未指定 VIFileVersion 时也设置固定 FileVersion；代码页来自语言配置，并不固定为 Unicode 的 04B0。

Windows 的 [VS_FIXEDFILEINFO](https://learn.microsoft.com/en-us/windows/win32/api/verrsrc/ns-verrsrc-vs_fixedfileinfo)、[StringFileInfo](https://learn.microsoft.com/en-us/windows/win32/menurc/stringfileinfo)、[StringTable](https://learn.microsoft.com/en-us/windows/win32/menurc/stringtable)、[VarFileInfo](https://learn.microsoft.com/en-us/windows/win32/menurc/varfileinfo) 定义用于核对字段长度、类型和含义。支持 NSIS 的已知序列化变体不代表任意未知布局都可用。

## 修复的精确边界

- 固定结构仍须 root key 正确、root type=0、value length=52、signature=FEEF04BD、完整位于资源边界。结构版本仅支持 0 和 00010000，不把任意值当作已知结构。
- 三类空容器仅接受 type 0 或 1，value length 必须为 0；字符串叶仍 type=1、UTF-16 完整且以 NUL 终止，Translation 叶仍 type=0、非空、长度为 4 的倍数且值不越界。
- 本地每个 StringTable 都必须在自己的 Translation 内声明。通常保留本地映射集合等于表集合的规则。
- 唯一跨资源例外是可识别的 NSIS 分语言布局：结构版本为 0、所有空容器为 0、每个资源恰好一个表、表语言等于该资源 LANGID，Translation 第一项指向本表。每个额外语言/代码页必须有实际对应资源，目标也须满足该布局，并与来源拥有相同的 Translation 全集。缺目标、错代码页、目标只有部分映射、先列其他语言或未声明本表，都不能通过。不是把相等检查简单改成子集。
- 全部资源和全部表先完整解析，再返回给既有版本规则；第二语言固定/文本/ProductVersion 不符仍阻断。未知结构、重复目录 ID、错误 ID 1、错 named/numeric 分区、重复字段、损坏或截断等拒绝保持。
- 对缺 VarFileInfo、Windows 可能支持但这里无法确定的语言回退，以及其他跨资源布局，仍保守 INCONCLUSIVE。这是校验器支持边界，不是宣称这些文件一定不合法。
- 文件快照、NTFS 锁、SHA-256、仓库证据、最终三态优先级均未放宽。所有版本字段仍只来自已哈希的同一 byte[]，不回退到路径读取或 FileVersionInfo/MUI。

## 已编写但未运行的字节回归

`scripts/verify-release-pe-bytes.static-tests.ps1` 保留原断言和完成协议，新增按上述 NSIS 源码序列化方式构造的资源。它不是“真实 NSIS exe”，也不是已执行的 NSIS 构建结果。

- 已知结构版本和容器类型的 2×2 组合；单资源内 0/1 容器混用。
- 标准及 NSIS 单语言资源的 PE32/PE32+，NSIS 1252 代码页的小写表键。
- 两个独立语言叶、不同代码页 1252/936、Translation 各自当前语言优先；确认返回全部表。
- 第二资源的 FileVersion 文本、固定 build、ProductVersion 文本冲突，均不可借第一资源的正确版本通过。
- 未知结构版本/容器类型、非空容器、错误叶类型、坏签名、重复 Translation 块/条目、长度不完整、值越界及根块截断。
- 多余 Translation 无目标、错误目标语言/代码页、缺反向映射、首项不匹配、未引用的表、非已知跨资源形状。
- overlay 中的签名诱饵不能成为固定字段偏移；一个资源内多个表返回相同偏移，修改必须去重。

用户运行：

```powershell
pwsh -NoProfile -File scripts/verify-release-pe-bytes.static-tests.ps1
pwsh -NoProfile -File scripts/verify-release-version.static-tests.ps1
```

第一项只验证合成字节和版本规则；第二项经既有父入口核对全部四组断言和完成协议。没有实际输出前，不能记录为 PASS。

## Windows 实测矩阵：全部待用户执行

每种样本独立记录：来源/构建提交、实际 NSIS 路径和版本（由用户确认）、原件 SHA-256、是否标准/单语言/多语言、实际 PE32 或 PE32+、PowerShell/Windows 版本、执行时间、结果和证据目录。不要从安装包文件名的 x64 推断 PE32+，NSIS 的安装器 stub 架构可能与被安装应用不同。

| 样本/用例 | 预期 | 当前状态 |
| --- | --- | --- |
| 当前项目最终原始 NSIS 候选包，独立可信 SHA-256 | 无结构误拒；其他既有证据满足才静态 PASS，不足则 INCONCLUSIVE | NOT RUN |
| 该候选包的隔离 B/A 副本，分别运行完整主流程 | B 静态 PASS/0；A 每个真实版本资源的 fixed build 改变，INCONCLUSIVE/2 | NOT RUN |
| 同一 B/A，AFTER_HASH 和 BEFORE_VERSION 各 7 类修改 | 全部共享冲突；仍输出 A 哈希/A 版本；结束后同一修改可成功 | NOT RUN |
| NSIS 3.11 单语言真实样本，保留实际 0/0 结构证据 | 完整解析全部表，保留原版本规则 | NOT RUN |
| 由用户准备的合法多语言 NSIS 3.11 对照样本，至少两叶且不同代码页 | 每叶自己的表，Translation 全集兑现；每叶均被校验；逐资源固定偏移不同 | NOT RUN |
| 标准资源编译器的 00010000/1 对照样本，按可用样本覆盖 PE32/PE32+ | 保留标准资源兼容；多表同 root 的修改仅一次 | NOT RUN |
| 缺映射、第二语言冲突、未知结构或截断的隔离副本 | 不可静态 PASS，哈希不匹配的既有 FAIL 不能被资源异常清除 | NOT RUN |
| 同进程 helper-only 锁释放/中途失败回收；原包空格/中文/长路径/junction | 符合上一轮明确的独立验收条件，不以子进程退出替代 Dispose 证据 | NOT RUN |

多语言和标准对照样本是额外格式验证，不应修改当前项目打包配置来冒充实际发行产物。无对应样本就保留 NOT RUN，不用合成 PE 填充“真实样本”结果。

```powershell
pwsh -NoProfile -File scripts/verify-release-snapshot.windows-tests.ps1 `
  -StableInstallerPath 'C:\release files\DeepSeekMonitor_1.3.1_x64-setup.exe' `
  -EvidenceDirectory 'C:\release evidence\round22-default-new-run'
```

该脚本只读原件、不运行安装包。全部修改仅发生于新的隔离证据目录；A/B 可能失去签名有效性，绝不能发布。A 的改动目标来自完整资源解析器给出的 `FixedFileInfoOffset`，去重后逐表复读核验，不再扫描全文件的 signature/structureVersion。以当前 1.3.1 稳定版本为例，B 固定版本应为 1.3.1.0，A 异或 build 位后为 1.3.0.0，文本仍与 B 相同；实际值以读取结果为准。`source-resource-evidence.json` 保存原件 SHA-256、真实资源路径、结构版本、固定偏移、共同文本版本和 A/B 实际固定版本；实际编译器版本仍需另记，布局相似不证明工具来源。

每个屏障仍执行原来的覆盖、原子替换、重命名、删除、A→B→A、hardlink 和父目录改名用例。全部完成后才生成 summary；缺样本、编译 helper 失败、超时或未到屏障不能算通过。完整细节见 [快照验收说明](REVIEW21_RELEASE_SNAPSHOT_REGRESSIONS.md)。静态 PASS 也不替代最终原包独立哈希、安装、升级、检查更新和其他 Windows 人工验收。
