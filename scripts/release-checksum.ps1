#requires -Version 7.0
# 为最终安装包生成校验和；不签名、不上传、发布或执行安装包。
# 只支持可确认锁语义的 Windows 本机 NTFS。输出必须是不存在的新文件；
# 已有普通文件、硬链接、符号链接均不覆盖，也不删除后重建。
param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function New-ReleaseChecksumBytes {
    param([AllowEmptyCollection()][byte[]]$Bytes, [string]$FileName)

    if ($null -eq $Bytes) { throw '缺少安装包字节快照。' }
    if ([string]::IsNullOrEmpty($FileName) -or $FileName -eq '.' -or $FileName -eq '..' -or
        $FileName -match '[\x00-\x1f\\/:*?"<>|]') {
        throw '校验和记录需要不含路径分隔符或控制字符的文件名。'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    # Strict UTF-8, without BOM; reject malformed UTF-16 instead of silently
    # replacing filename characters. Exactly two spaces and one LF.
    return ,([Text.UTF8Encoding]::new($false, $true).GetBytes($hash + '  ' + $FileName + "`n"))
}

try {
    if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core') {
        throw '校验和生成要求 Windows、PowerShell 7+ Core 和本机 NTFS；不能在未确认锁语义的平台继续。'
    }
    $installer = Get-Item -LiteralPath $InstallerPath
    if (-not $installer.Exists -or $installer.PSIsContainer) { throw "安装包不是可读文件：$InstallerPath" }
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'release-file-snapshot.cs')
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'release-checksum-binding.cs')
    $snapshot = [DeepSeekMonitor.ReleaseVerification.LockedFileSnapshot]::Open($installer.FullName)
    try {
        # The snapshot keeps the source and every canonical parent locked against
        # writes/deletes until output is flushed, checked and closed. Use its
        # volume-GUID path, not a drive letter/ancestor alias that can be rebound.
        $outputPath = $snapshot.LockedPath + '.sha256'
        [byte[]]$record = New-ReleaseChecksumBytes $snapshot.Bytes ([IO.Path]::GetFileName($snapshot.LockedPath))
        # RELEASE_CHECKSUM_TEST_AFTER_HASH (test copies only; no runtime bypass)
        $output = [IO.FileStream]::new($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            # RELEASE_CHECKSUM_TEST_BEFORE_WRITE (test copies only; no runtime bypass)
            $output.Write($record, 0, $record.Length)
            # RELEASE_CHECKSUM_TEST_BEFORE_FLUSH (test copies only; no runtime bypass)
            $output.Flush($true)
            # Verify bytes via the same exclusively owned handle. The metadata
            # binding check below is no-follow and never reads data by path.
            if ($output.Length -ne $record.Length) { throw '校验和文件长度与预期不符。' }
            $output.Position = 0
            foreach ($expected in $record) {
                if ($output.ReadByte() -ne $expected) { throw '校验和文件逐字节读回不一致。' }
            }
            if ($output.ReadByte() -ne -1) { throw '校验和文件含额外字节。' }
            # FileShare.None does not block FILE_WRITE_ATTRIBUTES. A successful
            # write/flush/readback alone cannot establish that the output is
            # still an ordinary file or that this name denotes our file object.
            # Retain output AND source/ancestor handles throughout this check.
            [DeepSeekMonitor.ReleaseVerification.ChecksumOutputBinding]::Validate($output.SafeFileHandle, $outputPath)
        }
        finally { $output.Dispose() }
    }
    finally { $snapshot.Dispose() }
}
catch {
    # Never delete on failure: a partially written new sidecar is evidence, and
    # path-based cleanup could delete an object replaced after our handle closes.
    [Console]::Error.WriteLine('校验和生成失败，未报告成功；已有输出绝不覆盖，新建但未完成的输出保留供人工核对：' + $_.Exception.Message)
    exit 1
}
# Only advertise a result after write, durable flush, readback, the no-follow
# identity/attribute checks and both disposals succeed. Metadata can still be
# changed later; use trusted directories/ACLs, not this check as an ACL boundary.
Write-Output $outputPath
