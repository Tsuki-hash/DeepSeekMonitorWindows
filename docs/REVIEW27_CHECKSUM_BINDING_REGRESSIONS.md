# 第 27 轮 checksum 输出绑定补强与待执行验收

状态：仅完成源码修改、Win32 文档核对和静态审阅。未编译 helper，未运行 PowerShell、测试、安装包或应用；以下 Windows 行为尚无本轮实测证据。

## 问题边界

`CreateNew + ReadWrite + FileShare.None` 防止覆盖已有输出，并限制其他数据读写/删除句柄，但不等于禁止属性访问。新建的空 sidecar 到首次写入之间，具备相应权限的进程可能用属性句柄对同一对象设置 reparse 数据。旧句柄随后能否继续写入、Flush、读回成功，需要 Windows 实测；不能仅凭源码断言攻击已复现。

本轮补的是成功前缺少的输出对象/路径校验，不声称冻结任意元数据修改，不把不可信目录或 ACL 当成安全边界。测试之后或句柄关闭后仍可发生修改；也不声称把多次 Win32 查询变成原子事务。

## 实现与释放顺序

`scripts/release-checksum.ps1` 保持 `CreateNew` 和两层 `try/finally`，不删除失败产物：

1. 持有源文件及规范卷路径的祖先锁，计算记录，新建独占 sidecar。
2. 用原输出句柄写入、`Flush(true)`、逐字节读回。
3. 在原输出和源/祖先句柄仍持有时调用 `ChecksumOutputBinding.Validate`。
4. 先释放输出，后释放源/祖先；只有所有步骤均无异常才输出成功路径。

新增的 `scripts/release-checksum-binding.cs` 仅检查元数据，不创建、改写或删除对象：

- 原句柄必须可查询，`GetFileType` 必须为磁盘文件，属性排除目录、设备及所有 `FILE_ATTRIBUTE_REPARSE_POINT`，而非只排除符号链接 tag。
- 要求规范本机卷 GUID 路径，并确认句柄所在文件系统为 NTFS。非 NTFS、查询失败、身份不一致都抛出异常。
- 以 `FILE_READ_ATTRIBUTES`、share read/write/delete、`OPEN_EXISTING` 和 `FILE_FLAG_OPEN_REPARSE_POINT` 打开路径最终组件。这个句柄不读数据，不跟随最终 reparse 目标，也不声称提供额外锁。
- 对这个路径句柄执行相同的普通文件/NTFS 检查，比较卷序列号和 64 位文件索引；随后再检查仍持有的原句柄。任一异常都阻止成功输出。
- 辅助元数据句柄由 `using` 释放，原输出句柄仍由脚本自己的 `finally` 释放。

## Windows 验收要求

运行入口是用户自行执行的 `scripts/verify-release-checksum.windows-tests.ps1`。只使用新建、隔离、不可执行的合成文件，保留原始证据，不清理任何对象。

新增场景必须实际经过 `BEFORE_WRITE` 屏障，不能用正常完成后的符号链接创建替代：

1. 对隔离的空普通文件做正向能力检查。持有 `ReadWrite + FileShare.None` 数据句柄时，另开仅含 `FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES` 的属性句柄，发送真实 `FSCTL_SET_REPARSE_POINT`。记录同一文件 ID 被转换、原始 reparse 数据和目标不变。
2. 在生产脚本副本创建 sidecar 后、首次写入前，以同样方式转换真实空 sidecar，记录共享锁仍限制数据写/删除，且转换成功。
3. 恢复子进程，要求非零退出、无成功路径；保留 sidecar 本体身份和 reparse 数据，源、哨兵、旁路文件字节不变。进程终态重开不能证明生产 `Dispose` 已执行，释放证据另看同套测试中的活进程探针。
4. 正常输出须仍通过 metadata-only no-follow 查询，不因仍持有 `FileShare.None` 而误报。另以隔离脚本副本将待校验路径改为源路径，要求身份不匹配失败，原写入输出不删除。
5. 若旧句柄的写入或 Flush 已先失败，只能证明该窗口失败关闭，不能宣称实际执行到了新增绑定检查。需另外覆盖 helper 的非 reparse 身份比较和 reparse 拒绝；保留原始错误阶段。

权限、文件系统或 API 能力不足均不是 PASS。`FSCTL_SET_REPARSE_POINT` 所需权限和 `CreateSymbolicLinkW` 的 Developer Mode 支持不是同一项证据。不得因为普通 symlink 创建成功就认定属性句柄原地转换可用；不得跳过转换步骤后生成完整成功汇总。

纯函数/结构测试只能证明接线与断言结构，不能证明 Windows 分享、reparse、Flush 或文件系统行为已运行。真实安装包验收仍需另外执行。

## Win32 文档核对

- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)：属性/扩展属性访问不受分享标志限制；新句柄的分享方式仍需兼容已有访问。`OPEN_REPARSE_POINT` 打开最终 reparse 对象本体，而非普通解析目标。
- [File Access Rights Constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)：`FILE_READ_ATTRIBUTES = 0x80`，`FILE_WRITE_ATTRIBUTES = 0x100`，二者与文件数据读写权限不同。
- [GetFileType](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletype) 与 [File Attribute Constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)：磁盘类型还需排除目录及 reparse 属性；未知类型也拒绝，不能把 `FILE_ATTRIBUTE_NORMAL` 当作唯一普通文件标志。
- [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle) 与 [BY_HANDLE_FILE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)：卷序列号加文件索引用于比较同时打开的文件身份。ReFS 的 64 位索引不足以保证唯一，因此本实现不接受 ReFS。
- [GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew)：通过句柄查询文件系统，失败不能猜测为 NTFS；SMB 不支持该卷管理函数。
- [FSCTL_SET_REPARSE_POINT](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_reparse_point) 与 [REPARSE_DATA_BUFFER](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer)：测试发送实际控制码和符号链接结构，偏移/长度以字节计，绝对目标的 flags 为 0，并核对调用权限。文档不足以替代目标 Windows 配置下的能力检查。

P/Invoke 静态核对：原生 `DWORD` 使用 `uint`，`BOOL` 使用 `MarshalAs(UnmanagedType.Bool)`，句柄使用 `SafeFileHandle`；宽字符入口显式指定 Unicode 和 `ExactSpelling`，需要保留错误码的入口使用 `SetLastError`。身份结构按原生字段顺序排列，时间字段使用 `FILETIME`。失败分支先保存 Win32 错误再释放无效句柄。
