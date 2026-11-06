#requires -Version 7.0
# 第 21/22 轮真实主流程回归文本；本次修改仅编写/静态审阅，未执行。
# 用户在 Windows 本机 NTFS 上运行。只读用户提供的真实 PE，所有修改仅在新建
# 隔离目录的测试副本中进行；绝不启动、安装或签名候选 PE，不构建项目。
# 这不是既有的 release-version-pure-functions，也不算安装/升级验收。
param(
    [Parameter(Mandatory = $true)][string]$StableInstallerPath,
    [string]$EvidenceDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('release snapshot evidence ' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core') {
    throw 'NOT RUN: 本回归要求 Windows、PowerShell 7+ Core 和本机 NTFS，不能以纯函数测试替代。'
}
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'verify-release.ps1'))
$packagePath = Join-Path $PSScriptRoot '..' 'package.json'
$version = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $evidence) { throw '证据目录必须不存在，避免覆盖已有文件。' }
$null = New-Item -ItemType Directory -Path $evidence
$scriptsDirectory = Join-Path $evidence 'scripts'
$null = New-Item -ItemType Directory -Path $scriptsDirectory
Copy-Item -LiteralPath $packagePath -Destination (Join-Path $evidence 'package.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-file-snapshot.cs') -Destination $scriptsDirectory
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-pe-version.cs') -Destination $scriptsDirectory
Add-Type -Path (Join-Path $scriptsDirectory 'release-pe-version.cs')
$script:CaseNumber = 0
$script:AssertionNumber = 0

function Assert-Case([bool]$Condition, [string]$Label) {
    $script:AssertionNumber += 1
    $record = [ordered]@{
        index = $script:AssertionNumber
        label = $Label
        status = $(if ($Condition) { 'PASS' } else { 'FAIL' })
    } | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $evidence 'assertions.jsonl') -Value $record -Encoding utf8
    Write-Host "RELEASE_SNAPSHOT_ASSERT $record"
    if (-not $Condition) { throw "断言失败：$Label；证据保留在 $evidence" }
}

function Get-BytesHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Invoke-MainFlow {
    param(
        [string]$Label,
        [byte[]]$Bytes,
        [string]$ExpectedHash,
        [ValidateSet('', 'AFTER_HASH', 'BEFORE_VERSION')][string]$Barrier = '',
        [scriptblock]$Mutation,
        [switch]$ExistingWriter,
        [switch]$HardLink
    )
    $script:CaseNumber += 1
    $caseRoot = Join-Path $evidence ('case ' + $script:CaseNumber)
    $parent = Join-Path $caseRoot 'parent with spaces'
    $null = New-Item -ItemType Directory -Path $parent
    $target = Join-Path $parent "Monitor $version.exe"
    $replacement = Join-Path $caseRoot 'replacement.exe'
    $alias = Join-Path $caseRoot 'hard link.exe'
    [IO.File]::WriteAllBytes($target, $Bytes)
    [IO.File]::WriteAllBytes($replacement, $fixtureB)
    if ($HardLink) { $null = New-Item -ItemType HardLink -Path $alias -Target $target }
    $caseScript = Join-Path $scriptsDirectory ('verify case ' + $script:CaseNumber + '.ps1')
    $ready = $null
    $resume = $null
    $writer = $null
    $process = $null
    $outputTask = $null
    $errorTask = $null
    $denied = $false
    $mutationError = $null
    try {
        $caseSource = $source
        if ($Barrier) {
            $id = [guid]::NewGuid().ToString('N')
            $readyName = "Local\release_snapshot_ready_$id"
            $resumeName = "Local\release_snapshot_resume_$id"
            $ready = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $readyName)
            $resume = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $resumeName)
            $marker = "# RELEASE_SNAPSHOT_TEST_BARRIER_$Barrier (test copies only; no runtime bypass)"
            if (($source.Split($marker, [StringSplitOptions]::None)).Count -ne 2) {
                throw "屏障锚点必须唯一：$marker"
            }
            # 只在脚本的隔离完整副本插入等待；不提取函数、不 mock 版本/哈希/锁。
            # 生产脚本本身没有测试参数、环境开关或可绕过锁的注入接口。
            $barrierCode = @"
`$readyEvent = [Threading.EventWaitHandle]::OpenExisting('$readyName')
`$resumeEvent = [Threading.EventWaitHandle]::OpenExisting('$resumeName')
try {
    `$null = `$readyEvent.Set()
    if (-not `$resumeEvent.WaitOne(60000)) { throw 'Controlled test barrier timed out' }
}
finally { `$readyEvent.Dispose(); `$resumeEvent.Dispose() }
"@
            $caseSource = $source.Replace($marker, $barrierCode)
        }
        [IO.File]::WriteAllText($caseScript, $caseSource, [Text.UTF8Encoding]::new($false))
        if ($ExistingWriter) {
            $writer = [IO.FileStream]::new($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $pwsh
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        foreach ($argument in @('-NoProfile', '-File', $caseScript, '-InstallerPath', $target)) {
            $start.ArgumentList.Add($argument)
        }
        if ($ExpectedHash) {
            $start.ArgumentList.Add('-ExpectedSha256')
            $start.ArgumentList.Add($ExpectedHash)
        }
        $process = [Diagnostics.Process]::Start($start)
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if ($Barrier) {
            if (-not $ready.WaitOne(60000)) { throw "真实主流程未到达屏障：$Label" }
            try {
                & $Mutation $target $replacement $alias $parent
            }
            catch {
                $exception = $_.Exception
                while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
                $nativeCode = $exception.HResult -band 0xFFFF
                $denied = $nativeCode -in @(32, 33) # sharing/lock violation, not a generic permission error
                $mutationError = $exception.ToString()
            }
            finally { $null = $resume.Set() }
        }
        if (-not $process.WaitForExit(60000)) { throw "真实主流程未结束：$Label" }
        $stdout = $outputTask.GetAwaiter().GetResult()
        $stderr = $errorTask.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $caseRoot 'stdout.txt'), $stdout)
        [IO.File]::WriteAllText((Join-Path $caseRoot 'stderr.txt'), $stderr)
        $result = [pscustomobject]@{
            label = $Label
            exitCode = $process.ExitCode
            stdout = $stdout
            stderr = $stderr
            barrier = $Barrier
            mutationDeniedBySharing = $denied
            mutationError = $mutationError
        }
        $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $caseRoot 'result.json') -Encoding utf8
        if ($Barrier) {
            Assert-Case $denied "$Label：屏障内修改明确被共享锁拒绝"
            Assert-Case ((Get-BytesHash ([IO.File]::ReadAllBytes($target))) -ceq (Get-BytesHash $Bytes)) "$Label：屏障释放后仍是完整 A"
            # 同一操作在子进程结束后必须成功，排除 ACL、错误路径等假阳性。
            & $Mutation $target $replacement $alias $parent
            Assert-Case $true "$Label：释放句柄后同一修改可以完成"
        }
        return $result
    }
    finally {
        if ($null -ne $resume) { $null = $resume.Set() }
        if ($null -ne $process) {
            if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
            if ($null -ne $outputTask) {
                [IO.File]::WriteAllText((Join-Path $caseRoot 'stdout.txt'), $outputTask.GetAwaiter().GetResult())
                [IO.File]::WriteAllText((Join-Path $caseRoot 'stderr.txt'), $errorTask.GetAwaiter().GetResult())
            }
            $process.Dispose()
        }
        if ($null -ne $writer) { $writer.Dispose() }
        if ($null -ne $ready) { $ready.Dispose() }
        if ($null -ne $resume) { $resume.Dispose() }
    }
}

function Assert-Verdict($Result, [int]$ExitCode, [string]$Verdict) {
    Assert-Case ($Result.exitCode -eq $ExitCode) "$($Result.label)：退出码 $ExitCode"
    Assert-Case ($Result.stdout.Contains("结论：$Verdict")) "$($Result.label)：结论 $Verdict"
    if ($Verdict -ne 'PASS') {
        Assert-Case (-not $Result.stdout.Contains('结论：PASS')) "$($Result.label)：不能输出静态 PASS"
    }
}

# B 是用户提供的当前版本 PE 的隔离副本，加明文辅助 marker 使成功路径可控。
# 改过的副本不是发行附件，签名可能失效；自算哈希仅用于回归，不是来源证明。
[byte[]]$baseBytes = [IO.File]::ReadAllBytes((Get-Item -LiteralPath $StableInstallerPath).FullName)
$markerBytes = [Text.Encoding]::UTF8.GetBytes("`0Tsuki-hash/DeepSeekMonitorWindows`0")
[byte[]]$fixtureB = [byte[]]::new($baseBytes.Length + $markerBytes.Length)
$baseBytes.CopyTo($fixtureB, 0)
$markerBytes.CopyTo($fixtureB, $baseBytes.Length)
[byte[]]$fixtureA = $fixtureB.Clone()
$baseInfos = @([DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($fixtureB))
# 偏移必须来自完整解析成功的 RT_VERSION 资源，不在全文件扫描签名。
# NSIS 3.11 的 dwStrucVersion=0；overlay/压缩数据中的同签名不能成为修改目标。
# 同一 root 可包含多个 StringTable，因此先去重，防止 XOR 两次又恢复原版本。
$fixedOffsets = @($baseInfos.FixedFileInfoOffset | Sort-Object -Unique)
Assert-Case ($fixedOffsets.Count -gt 0) '找到真实 RT_VERSION 固定字段偏移用于构造不同版本 A'
foreach ($offset in $fixedOffsets) {
    $different = [BitConverter]::ToUInt32($fixtureA, $offset + 12) -bxor [uint32]0x00010000
    [BitConverter]::GetBytes([uint32]$different).CopyTo($fixtureA, $offset + 12)
}
$changedInfos = @([DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($fixtureA))
Assert-Case ($changedInfos.Count -eq $baseInfos.Count) 'A/B 保留同一组真实资源表'
for ($index = 0; $index -lt $baseInfos.Count; $index++) {
    $before = $baseInfos[$index]; $after = $changedInfos[$index]
    Assert-Case ($after.Resource -ceq $before.Resource -and $after.FixedFileInfoOffset -eq $before.FixedFileInfoOffset -and
        $after.FileMajorPart -eq $before.FileMajorPart -and $after.FileMinorPart -eq $before.FileMinorPart -and
        $after.FileBuildPart -eq ($before.FileBuildPart -bxor 1) -and $after.FilePrivatePart -eq $before.FilePrivatePart -and
        $after.FileVersion -ceq $before.FileVersion -and $after.ProductVersion -ceq $before.ProductVersion -and
        $after.IsPreRelease -eq $before.IsPreRelease) "每个实际表的固定 build 已改变、文本保持原样：$($before.Resource)"
}
$sourceHash = Get-BytesHash $baseBytes
$resourceEvidence = @(for ($index = 0; $index -lt $baseInfos.Count; $index++) {
    $before = $baseInfos[$index]; $after = $changedInfos[$index]
    [ordered]@{
        resource = $before.Resource
        fixedFileInfoOffset = $before.FixedFileInfoOffset
        structureVersion = [BitConverter]::ToUInt32($fixtureB, $before.FixedFileInfoOffset + 4)
        fileVersion = $before.FileVersion
        productVersion = $before.ProductVersion
        fixedFileVersionB = '{0}.{1}.{2}.{3}' -f $before.FileMajorPart, $before.FileMinorPart, $before.FileBuildPart, $before.FilePrivatePart
        fixedFileVersionA = '{0}.{1}.{2}.{3}' -f $after.FileMajorPart, $after.FileMinorPart, $after.FileBuildPart, $after.FilePrivatePart
    }
})
[ordered]@{ sourceInstallerSha256 = $sourceHash; resources = $resourceEvidence; actualToolchainVersion = 'User must record; not inferred from PE layout' } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'source-resource-evidence.json') -Encoding utf8
$hashA = Get-BytesHash $fixtureA
$hashB = Get-BytesHash $fixtureB
Assert-Case ($hashA -cne $hashB) 'A/B 是不同字节和哈希'

# 首先执行未经屏障改写的完整主流程。B 不满足现有版本/仓库规则则直接失败，
# 不把缺 fixture、版本不符、原件自带旧仓库、锁不支持记为测试通过。
$stable = Invoke-MainFlow -Label '稳定文件与空格路径' -Bytes $fixtureB -ExpectedHash $hashB
Assert-Verdict $stable 0 'PASS'
$differentVersion = Invoke-MainFlow -Label 'A 的真实固定版本不符' -Bytes $fixtureA -ExpectedHash $hashA
Assert-Verdict $differentVersion 2 'INCONCLUSIVE'
Assert-Case ($differentVersion.stdout.Contains('PE 固定 FileVersion 与源码版本不一致')) 'A 的实际 PE 版本资源确实被判定为不同版本'
Assert-Verdict (Invoke-MainFlow -Label '已有可写句柄冲突' -Bytes $fixtureB -ExpectedHash $hashB -ExistingWriter) 2 'INCONCLUSIVE'
Assert-Verdict (Invoke-MainFlow -Label '未提供期望哈希' -Bytes $fixtureB) 2 'INCONCLUSIVE'
Assert-Verdict (Invoke-MainFlow -Label '确定哈希错误优先' -Bytes $fixtureA -ExpectedHash $hashB) 1 'FAIL'
# 保留合法基本 PE 头，但使资源目录越界，强制真实资源解析异常。
[byte[]]$brokenResource = $fixtureB.Clone()
$peOffset = [BitConverter]::ToInt32($brokenResource, 0x3C)
$optionalOffset = $peOffset + 24
$directoryOffset = if ([BitConverter]::ToUInt16($brokenResource, $optionalOffset) -eq 0x10B) { 96 } else { 112 }
[BitConverter]::GetBytes([uint32]::MaxValue).CopyTo($brokenResource, $optionalOffset + $directoryOffset + 20)
$failedThenUnreadable = Invoke-MainFlow -Label '哈希 FAIL 后资源解析异常' -Bytes $brokenResource -ExpectedHash $hashB
Assert-Verdict $failedThenUnreadable 1 'FAIL'
Assert-Case ($failedThenUnreadable.stdout.Contains('无法读取或核对 PE 版本资源')) '真实资源异常不能清除已经发现的哈希 FAIL'
# 在已通过 B 基线的实际资源树上，仅改 VERSIONINFO 名称 ID，不能靠仍完整的
# VS_VERSION_INFO 字节通过。这里的 RVA 映射仅用于构造 fixture，不作通过证据。
$resourceRva = [BitConverter]::ToUInt32($fixtureB, $optionalOffset + $directoryOffset + 16)
$sectionTable = $optionalOffset + [BitConverter]::ToUInt16($fixtureB, $peOffset + 20)
$resourceRaw = -1
for ($index = 0; $index -lt [BitConverter]::ToUInt16($fixtureB, $peOffset + 6); $index++) {
    $section = $sectionTable + $index * 40
    $virtual = [BitConverter]::ToUInt32($fixtureB, $section + 12)
    $rawSize = [BitConverter]::ToUInt32($fixtureB, $section + 16)
    if ($resourceRva -ge $virtual -and [long]$resourceRva - $virtual -lt $rawSize) {
        $resourceRaw = [int]([BitConverter]::ToUInt32($fixtureB, $section + 20) + [long]$resourceRva - $virtual)
    }
}
Assert-Case ($resourceRaw -ge 0) '主流程畸形 fixture：找到真实资源目录'
$rootEntries = [BitConverter]::ToUInt16($fixtureB, $resourceRaw + 12) + [BitConverter]::ToUInt16($fixtureB, $resourceRaw + 14)
$versionNameEntry = -1
for ($index = 0; $index -lt $rootEntries; $index++) {
    $entry = $resourceRaw + 16 + $index * 8
    if ([BitConverter]::ToUInt32($fixtureB, $entry) -eq 16) {
        $relative = [BitConverter]::ToUInt32($fixtureB, $entry + 4) -band [uint32]0x7FFFFFFF
        $versionNameEntry = $resourceRaw + [int]$relative + 16
    }
}
Assert-Case ($versionNameEntry -ge 0 -and [BitConverter]::ToUInt32($fixtureB, $versionNameEntry) -eq 1) '主流程畸形 fixture：原版本资源名称为 ID 1'
[byte[]]$wrongVersionName = $fixtureB.Clone()
[BitConverter]::GetBytes([uint32]2).CopyTo($wrongVersionName, $versionNameEntry)
Assert-Verdict (Invoke-MainFlow -Label '版本资源非标准名称 ID 2' -Bytes $wrongVersionName -ExpectedHash (Get-BytesHash $wrongVersionName)) 2 'INCONCLUSIVE'
[byte[]]$wrongPartition = $fixtureB.Clone()
[BitConverter]::GetBytes([uint16]([BitConverter]::ToUInt16($fixtureB, $resourceRaw + 12) + 1)).CopyTo($wrongPartition, $resourceRaw + 12)
[BitConverter]::GetBytes([uint16]([BitConverter]::ToUInt16($fixtureB, $resourceRaw + 14) - 1)).CopyTo($wrongPartition, $resourceRaw + 14)
Assert-Verdict (Invoke-MainFlow -Label '资源目录 named 与 numeric 分区错位' -Bytes $wrongPartition -ExpectedHash (Get-BytesHash $wrongPartition)) 2 'INCONCLUSIVE'
$textFixture = [Text.Encoding]::UTF8.GetBytes('Tsuki-hash/DeepSeekMonitorWindows')
Assert-Verdict (Invoke-MainFlow -Label '普通文本不能冒充 PE' -Bytes $textFixture -ExpectedHash (Get-BytesHash $textFixture)) 2 'INCONCLUSIVE'
$legacyFixture = [Text.Encoding]::UTF8.GetBytes('Tsuki-hash/DeepSeekMonitorWindows Tsuki-hash/DeepSeekMonitorWin/releases')
Assert-Verdict (Invoke-MainFlow -Label '旧仓库 FAIL 优先于 PE 无法判定' -Bytes $legacyFixture -ExpectedHash (Get-BytesHash $legacyFixture)) 1 'FAIL'

$mutations = @(
    @{ Label = '同路径覆盖'; Action = { param($target, $replacement) [IO.File]::Copy($replacement, $target, $true) } },
    @{ Label = '原子替换'; Action = { param($target, $replacement) [IO.File]::Replace($replacement, $target, $null) } },
    @{ Label = '重命名 A 再换 B'; Action = { param($target, $replacement) [IO.File]::Move($target, "$target.old"); [IO.File]::Move($replacement, $target) } },
    @{ Label = '删除 A 再换 B'; Action = { param($target, $replacement) [IO.File]::Delete($target); [IO.File]::Move($replacement, $target) } },
    @{ Label = 'A 到 B 再恢复 A'; Action = { param($target, $replacement) [IO.File]::WriteAllBytes($target, $fixtureB); [IO.File]::WriteAllBytes($target, $fixtureA) } },
    @{ Label = '经 hardlink 写入'; HardLink = $true; Action = { param($target, $replacement, $alias) [IO.File]::Copy($replacement, $alias, $true) } },
    @{ Label = '父目录改名后换绑'; Action = { param($target, $replacement, $alias, $parent) [IO.Directory]::Move($parent, "$parent.old"); $null = [IO.Directory]::CreateDirectory($parent); [IO.File]::Copy($replacement, $target) } }
)
foreach ($barrier in @('AFTER_HASH', 'BEFORE_VERSION')) {
    foreach ($mutation in $mutations) {
        $result = Invoke-MainFlow -Label "$barrier $($mutation.Label)" -Bytes $fixtureA -ExpectedHash $hashA `
            -Barrier $barrier -Mutation $mutation.Action -HardLink:([bool]$mutation.HardLink)
        Assert-Verdict $result 2 'INCONCLUSIVE'
        Assert-Case ($result.stdout.Contains("SHA-256：$hashA")) "$($result.label)：报告 A 的哈希"
        Assert-Case ($result.stdout.Contains('PE 固定 FileVersion 与源码版本不一致')) "$($result.label)：版本仍属于 A，不能借 B 得到 PASS"
    }
}

# 以下专门核对 helper 的同进程释放，不冒充上面的真实主流程用例。
# 子进程退出会自动关闭句柄，因此仅“子进程退出后可写”不能证明 Dispose 正确。
Add-Type -Path (Join-Path $scriptsDirectory 'release-file-snapshot.cs')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ReleaseSnapshotTestDirectoryBlocker {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr d, uint c, uint f, IntPtr t);
    public static SafeFileHandle Open(string path) {
        var handle = CreateFileW(path, 0x10000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
        }
        return handle;
    }
}
'@
$lifetimeRoot = Join-Path $evidence 'helper lifetime parent'
$null = [IO.Directory]::CreateDirectory($lifetimeRoot)
$lifetimeFile = Join-Path $lifetimeRoot "Monitor $version.exe"
[IO.File]::WriteAllBytes($lifetimeFile, $fixtureB)
$locked = [DeepSeekMonitor.ReleaseVerification.LockedFileSnapshot]::Open($lifetimeFile)
try {
    $blocked = $false
    try { [IO.File]::WriteAllBytes($lifetimeFile, $fixtureA) }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        $blocked = ($exception.HResult -band 0xFFFF) -in @(32, 33)
    }
    Assert-Case $blocked 'helper-only：同进程 Open 持锁时拒写'
}
finally { $locked.Dispose() }
[IO.File]::WriteAllBytes($lifetimeFile, $fixtureB)
[IO.Directory]::Move($lifetimeRoot, "$lifetimeRoot renamed")
[IO.Directory]::Move("$lifetimeRoot renamed", $lifetimeRoot)
Assert-Case $true 'helper-only：Dispose 后同进程文件可写且祖先可改名'

$blockedChild = Join-Path $lifetimeRoot 'blocked child'
$null = [IO.Directory]::CreateDirectory($blockedChild)
$failureFile = Join-Path $blockedChild "Monitor $version.exe"
[IO.File]::WriteAllBytes($failureFile, $fixtureB)
$directoryBlocker = [ReleaseSnapshotTestDirectoryBlocker]::Open($blockedChild)
try {
    $failedOpen = $null
    $rejected = $false
    try { $failedOpen = [DeepSeekMonitor.ReleaseVerification.LockedFileSnapshot]::Open($failureFile) }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        $rejected = $exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 32
    }
    finally { if ($null -ne $failedOpen) { $failedOpen.Dispose() } }
    Assert-Case $rejected 'helper-only：文件已打开后遇到父目录共享冲突必须失败'
    [IO.File]::WriteAllBytes($failureFile, $fixtureB)
    Assert-Case $true 'helper-only：Open 中途失败后同进程源文件可写，无叶句柄泄漏'
}
finally { $directoryBlocker.Dispose() }
[IO.Directory]::Move($lifetimeRoot, "$lifetimeRoot released")
Assert-Case $true 'helper-only：Open 中途失败后先前祖先句柄也已释放'

$summary = [ordered]@{
    schemaVersion = 1
    scope = 'release-snapshot-windows-main-flow'
    completed = $true
    cases = $script:CaseNumber
    assertions = $script:AssertionNumber
    powershell = $PSVersionTable.PSVersion.ToString()
    executable = $pwsh
    fixtureSha256A = $hashA
    fixtureSha256B = $hashB
    sourceInstallerSha256 = $sourceHash
    fixedFileInfoOffsets = $fixedOffsets
    resources = $resourceEvidence
    evidenceDirectory = $evidence
    installationAcceptance = 'NOT RUN'
} | ConvertTo-Json -Depth 5
$summary | Set-Content -LiteralPath (Join-Path $evidence 'summary.json') -Encoding utf8
Write-Host "真实主流程回归完成；未运行安装包或安装验收。证据：$evidence"
Write-Host $summary
