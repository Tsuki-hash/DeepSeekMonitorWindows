#requires -Version 7.0
# 第 26 轮待执行回归：只创建不可执行的合成字节，不接受/启动真实安装包。
# 本轮仅编写及静态审阅，未运行。本机 NTFS + PowerShell 7+；证据不自动删除。
param(
    [string]$EvidenceDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('release checksum evidence ' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core') {
    throw 'NOT RUN: 本回归要求 Windows、PowerShell 7+ Core 和本机 NTFS。'
}
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
Add-Type -LiteralPath @((Join-Path $PSScriptRoot 'release-snapshot-test-hardlink.cs'), (Join-Path $PSScriptRoot 'release-checksum-test-fixtures.cs'))
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-checksum.ps1'))
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$root = [IO.Path]::GetFullPath($EvidenceDirectory)
if ($root.StartsWith('\\') -and -not $root.StartsWith('\\?\')) { throw '证据必须使用本机 NTFS，不使用 UNC。' }
if ($root.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { throw '证据必须使用本机 NTFS，不使用扩展 UNC。' }
if (-not $root.StartsWith('\\?\')) { $root = '\\?\' + $root }
# Native CREATE_DIRECTORY fails atomically if the evidence root already exists.
# All later files use CreateNew; the suite never removes or overwrites old data.
[DeepSeekMonitor.ReleaseVerification.Tests.LiteralChecksumFixtures]::CreateFreshDirectory($root)
$script:assertions = [Collections.Generic.List[object]]::new()
$script:caseNumber = 0

function New-Directory([string]$Path) {
    [DeepSeekMonitor.ReleaseVerification.Tests.LiteralChecksumFixtures]::CreateFreshDirectory($Path)
}
function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Write-NewText([string]$Path, [string]$Text) { Write-NewBytes $Path ($utf8.GetBytes($Text)) }
function Same-Bytes([byte[]]$Left, [byte[]]$Right) {
    return [Convert]::ToBase64String($Left) -ceq [Convert]::ToBase64String($Right)
}
function Assert-Case([bool]$Condition, [string]$Label) {
    $row = [ordered]@{ index = $script:assertions.Count + 1; label = $Label; passed = $Condition }
    $script:assertions.Add($row)
    Write-Host ('RELEASE_CHECKSUM_WINDOWS_ASSERT ' + ($row | ConvertTo-Json -Compress))
    if (-not $Condition) { throw "断言失败：$Label" }
}
function Assert-SharingDenied([scriptblock]$Action, [string]$Label) {
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception }
    if ($null -ne $failure) {
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    }
    $code = if ($null -ne $failure) { $failure.HResult -band 0xffff } else { 0 }
    Assert-Case ($code -in @(32, 33)) "$Label：必须是真实 sharing/lock violation，实际码 $code"
}
function Open-Writer([string]$Path) {
    $handle = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]7)
    $handle.Dispose()
}
function Assert-SameIdentity([string]$Alias, [string]$Target, $Original, [string]$Label) {
    $left = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($Alias)
    $right = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($Target)
    Assert-Case ($left.IsSameFile($right) -and $right.IsSameFile($Original)) $Label
}

try {
    $run = Join-Path $root 'run [ab]'
    $decoy = Join-Path $root 'run a'
    New-Directory $run
    New-Directory $decoy
    $scripts = Join-Path $run 'scripts'
    $decoyScripts = Join-Path $decoy 'scripts'
    New-Directory $scripts
    New-Directory $decoyScripts
    Write-NewBytes (Join-Path $scripts 'release-file-snapshot.cs') ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'release-file-snapshot.cs')))
    Write-NewText (Join-Path $decoyScripts 'release-file-snapshot.cs') '#error WILDCARD_DECOY_MUST_NOT_BE_COMPILED'
    $scriptPattern = [Management.Automation.WildcardPattern]::new($scripts, [Management.Automation.WildcardOptions]::IgnoreCase)
    Assert-Case ($scriptPattern.IsMatch($decoyScripts)) '完整源码路径确有旁路匹配；证据根及祖先不得含通配字符'

    function New-Case([string]$Label, [switch]$LongPath) {
        $script:caseNumber += 1
        $caseRoot = Join-Path $run ('case ' + $script:caseNumber)
        $decoyRoot = Join-Path $decoy ('case ' + $script:caseNumber)
        New-Directory $caseRoot
        New-Directory $decoyRoot
        $parent = Join-Path $caseRoot '合成文件 [cd]'
        $decoyParent = Join-Path $decoyRoot '合成文件 c'
        New-Directory $parent
        New-Directory $decoyParent
        if ($LongPath) {
            while ($parent.Length -lt 300) {
                $parent = Join-Path $parent 'long path 中文 abcdefghijklmnopqrstuvwxyz'
                $decoyParent = Join-Path $decoyParent 'long path 中文 abcdefghijklmnopqrstuvwxyz'
                New-Directory $parent
                New-Directory $decoyParent
            }
        }
        $target = Join-Path $parent "合成 安装包 [ef] ' 测试.exe"
        $decoyTarget = Join-Path $decoyParent "合成 安装包 e ' 测试.exe"
        [byte[]]$bytes = $utf8.GetBytes("Synthetic fixture only. NOT an executable. abc $($script:caseNumber)`n")
        [byte[]]$sentinelBytes = $utf8.GetBytes('Sentinel must remain unchanged: ' + $script:caseNumber)
        [byte[]]$decoyBytes = $utf8.GetBytes('Wildcard decoy must remain unchanged: ' + $script:caseNumber)
        $sentinel = Join-Path $caseRoot '哨兵 [xy].bin'
        Write-NewBytes $target $bytes
        Write-NewBytes $sentinel $sentinelBytes
        Write-NewBytes $decoyTarget $decoyBytes
        $pattern = [Management.Automation.WildcardPattern]::new($target, [Management.Automation.WildcardOptions]::IgnoreCase)
        Assert-Case ($pattern.IsMatch($decoyTarget)) "$Label：输入完整路径确有不同字节旁路匹配"
        return [pscustomobject]@{
            Number = $script:caseNumber; Label = $Label; Root = $caseRoot; Parent = $parent
            Target = $target; InputPath = $target; Sidecar = ($target + '.sha256'); Bytes = $bytes
            Sentinel = $sentinel; SentinelBytes = $sentinelBytes; Decoy = $decoyTarget; DecoyBytes = $decoyBytes
            Writer = $null; Alias = (Join-Path $caseRoot '源文件硬链接.bin')
        }
    }

    function Invoke-ChecksumCase {
        param($Case, [ValidateSet('', 'AFTER_HASH', 'BEFORE_WRITE', 'BEFORE_FLUSH')][string]$Barrier = '',
            [scriptblock]$Mutation, [string]$FaultMarker = '', [string]$FaultCode = '')
        $caseSource = $source
        $ready = $null
        $resume = $null
        $process = $null
        $outputTask = $null
        $errorTask = $null
        try {
            if ($Barrier) {
                $id = [guid]::NewGuid().ToString('N')
                $readyName = "Local\release_checksum_ready_$id"
                $resumeName = "Local\release_checksum_resume_$id"
                $ready = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $readyName)
                $resume = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $resumeName)
                $marker = "# RELEASE_CHECKSUM_TEST_$Barrier (test copies only; no runtime bypass)"
                if (($caseSource.Split($marker, [StringSplitOptions]::None)).Count -ne 2) { throw "屏障锚点不唯一：$marker" }
                $injection = @'
$readyEvent = [Threading.EventWaitHandle]::OpenExisting('__READY__')
$resumeEvent = [Threading.EventWaitHandle]::OpenExisting('__RESUME__')
try {
    $null = $readyEvent.Set()
    if (-not $resumeEvent.WaitOne(60000)) { throw 'test barrier timed out' }
}
finally { $readyEvent.Dispose(); $resumeEvent.Dispose() }
'@
                $caseSource = $caseSource.Replace($marker, $injection.Replace('__READY__', $readyName).Replace('__RESUME__', $resumeName))
            }
            if ($FaultMarker) {
                $marker = "# RELEASE_CHECKSUM_TEST_$FaultMarker (test copies only; no runtime bypass)"
                if (($caseSource.Split($marker, [StringSplitOptions]::None)).Count -ne 2) { throw "故障锚点不唯一：$marker" }
                $caseSource = $caseSource.Replace($marker, $FaultCode)
            }
            $scriptPath = Join-Path $scripts ('checksum case ' + $Case.Number + '.ps1')
            Write-NewText $scriptPath $caseSource
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $pwsh
            $start.UseShellExecute = $false
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $start.StandardOutputEncoding = $utf8
            $start.StandardErrorEncoding = $utf8
            foreach ($arg in @('-NoProfile', '-File', $scriptPath, '-InstallerPath', $Case.InputPath)) { $start.ArgumentList.Add($arg) }
            $process = [Diagnostics.Process]::Start($start)
            $outputTask = $process.StandardOutput.ReadToEndAsync()
            $errorTask = $process.StandardError.ReadToEndAsync()
            if ($Barrier) {
                Assert-Case ($ready.WaitOne(60000)) "$($Case.Label)：真实主流程到达 $Barrier"
                & $Mutation $Case
                $null = $resume.Set()
            }
            if (-not $process.WaitForExit(60000)) { throw '校验和子进程未按时结束。' }
            $result = [pscustomobject]@{
                label = $Case.Label; barrier = $Barrier; fault = $FaultMarker; exitCode = $process.ExitCode
                stdout = $outputTask.GetAwaiter().GetResult(); stderr = $errorTask.GetAwaiter().GetResult()
            }
            Write-NewText (Join-Path $Case.Root 'result.json') ($result | ConvertTo-Json -Depth 4)
            return $result
        }
        finally {
            # Evidence I/O can fail too. It must not strand the child, source
            # writer or named events, nor turn an incomplete run into success.
            try {
                try {
                    if ($null -ne $resume) { $null = $resume.Set() }
                    if ($null -ne $process) {
                        if (-not $process.HasExited -and -not $process.WaitForExit(10000)) { $process.Kill($true); $process.WaitForExit() }
                        if ($null -ne $outputTask) { Write-NewText (Join-Path $Case.Root 'stdout.txt') ($outputTask.GetAwaiter().GetResult()) }
                        if ($null -ne $errorTask) { Write-NewText (Join-Path $Case.Root 'stderr.txt') ($errorTask.GetAwaiter().GetResult()) }
                    }
                }
                finally { if ($null -ne $process) { $process.Dispose() } }
            }
            finally {
                try { if ($null -ne $Case.Writer) { $Case.Writer.Dispose(); $Case.Writer = $null } }
                finally {
                    try { if ($null -ne $ready) { $ready.Dispose() } }
                    finally { if ($null -ne $resume) { $resume.Dispose() } }
                }
            }
        }
    }

    function Assert-Result($Case, $Result, [bool]$Success) {
        Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($Case.Target)) $Case.Bytes)) "$($Case.Label)：源文件逐字节不变"
        Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($Case.Sentinel)) $Case.SentinelBytes)) "$($Case.Label)：哨兵逐字节不变"
        Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($Case.Decoy)) $Case.DecoyBytes)) "$($Case.Label)：旁路逐字节不变"
        if ($Success) {
            Assert-Case ($Result.exitCode -eq 0 -and [string]::IsNullOrWhiteSpace($Result.stderr)) "$($Case.Label)：退出 0，无错误输出"
            $reported = $Result.stdout.TrimEnd([char[]]"`r`n")
            Assert-Case ($reported.StartsWith('\\?\Volume{') -and $reported -notmatch '[\r\n]') "$($Case.Label)：只输出实际规范卷路径"
            $identity = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($Case.Sidecar)
            Assert-SameIdentity $reported $Case.Sidecar $identity "$($Case.Label)：报告路径与实际 sidecar 身份相同"
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($Case.Bytes)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            $expected = $utf8.GetBytes($hash + '  ' + [IO.Path]::GetFileName($Case.Target) + "`n")
            Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($Case.Sidecar)) $expected)) "$($Case.Label)：完整无 BOM UTF-8 校验和与合成输入匹配"
            Open-Writer $Case.Sidecar
        }
        else {
            Assert-Case ($Result.exitCode -ne 0 -and -not [string]::IsNullOrWhiteSpace($Result.stderr)) "$($Case.Label)：明确失败并保留错误"
            Assert-Case ([string]::IsNullOrWhiteSpace($Result.stdout)) "$($Case.Label)：没有假成功路径"
        }
        Open-Writer $Case.Target
        Assert-Case $true "$($Case.Label)：结束后源/输出句柄已释放"
    }

    foreach ($long in @($false, $true)) {
        $case = New-Case ('新输出，长路径=' + $long) -LongPath:$long
        if ($long) { Assert-Case ($case.Target.Length -gt 300) '长路径输入确实超过 300 字符' }
        Assert-Result $case (Invoke-ChecksumCase $case) $true
    }
    $case = New-Case '已有普通 sidecar'
    Write-NewBytes $case.Sidecar $case.SentinelBytes
    $identity = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($case.Sidecar)
    Assert-Result $case (Invoke-ChecksumCase $case) $false
    Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($case.Sidecar)) $case.SentinelBytes)) '已有普通输出零改动'
    Assert-SameIdentity $case.Sidecar $case.Sidecar $identity '已有普通输出没有被删除后重建'
    foreach ($destination in @('Target', 'Sentinel')) {
        $case = New-Case "已有指向 $destination 的 sidecar 硬链接"
        $target = $case.$destination
        $identity = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($target)
        [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::Create($case.Sidecar, $target)
        Assert-SameIdentity $case.Sidecar $target $identity '启动前确认真实硬链接身份，不以相同字节冒充'
        Assert-Result $case (Invoke-ChecksumCase $case) $false
        Assert-SameIdentity $case.Sidecar $target $identity '失败后硬链接及目标身份仍保留'
    }
    $case = New-Case '已有输出目录'
    New-Directory $case.Sidecar
    Assert-Result $case (Invoke-ChecksumCase $case) $false
    Assert-Case ([IO.Directory]::Exists($case.Sidecar)) '已有输出目录未删除'
    $case = New-Case '启动前已有源文件写句柄'
    $case.Writer = [IO.FileStream]::new($case.Target, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]7)
    Assert-Result $case (Invoke-ChecksumCase $case) $false
    Assert-Case (-not [IO.File]::Exists($case.Sidecar)) '源锁失败不创建 sidecar'

    foreach ($kind in @('ordinary', 'hardlink')) {
        $case = New-Case "hash 后并发创建 $kind 输出"
        $mutation = if ($kind -eq 'ordinary') {
            { param($c) Write-NewBytes $c.Sidecar $c.SentinelBytes }
        } else {
            { param($c) [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::Create($c.Sidecar, $c.Sentinel) }
        }
        Assert-Result $case (Invoke-ChecksumCase $case -Barrier AFTER_HASH -Mutation $mutation) $false
        Assert-Case ((Same-Bytes ([IO.File]::ReadAllBytes($case.Sidecar)) $case.SentinelBytes)) '并发创建者的输出未被覆盖'
        if ($kind -eq 'hardlink') {
            $identity = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($case.Sentinel)
            Assert-SameIdentity $case.Sidecar $case.Sentinel $identity '并发 sidecar 确实链接哨兵'
        }
    }
    foreach ($barrier in @('AFTER_HASH', 'BEFORE_FLUSH')) {
        $case = New-Case "$barrier 源文件、硬链接、祖先及输出锁"
        [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::Create($case.Alias, $case.Target)
        $identity = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralHardLink]::ReadIdentity($case.Target)
        Assert-SameIdentity $case.Alias $case.Target $identity '并发修改夹具启动前的硬链接身份正确'
        $mutation = {
            param($c)
            Assert-SameIdentity $c.Alias $c.Target $identity '屏障时硬链接身份仍相同'
            Assert-SharingDenied { Open-Writer $c.Target } '直接写入源文件'
            Assert-SharingDenied { Open-Writer $c.Alias } '经硬链接写入源文件'
            Assert-SharingDenied { [IO.File]::Move($c.Target, ($c.Target + '.moved')) } '重命名源文件'
            Assert-SharingDenied { [IO.Directory]::Move($c.Parent, ($c.Parent + '.moved')) } '重命名源文件祖先'
            if ($barrier -eq 'BEFORE_FLUSH') {
                Assert-SharingDenied { Open-Writer $c.Sidecar } '写入尚未完成的 sidecar'
                Assert-SharingDenied { [IO.File]::Move($c.Sidecar, ($c.Sidecar + '.moved')) } '重命名尚未完成的 sidecar'
            }
        }
        Assert-Result $case (Invoke-ChecksumCase $case -Barrier $barrier -Mutation $mutation) $true
        Assert-SameIdentity $case.Alias $case.Target $identity '结束后源文件与硬链接身份不变'
        Open-Writer $case.Alias
        [IO.Directory]::Move($case.Parent, ($case.Parent + '.released'))
        [IO.Directory]::Move(($case.Parent + '.released'), $case.Parent)
        Assert-Case $true '同一进程结束后祖先重命名可完成，生产锁已释放'
    }
    foreach ($fault in @(
        @{ Label = '部分写入后异常'; Marker = 'BEFORE_WRITE'; Code = '$output.Write($record, 0, 1); throw [IO.IOException]::new("injected partial write failure")'; Length = 1 },
        @{ Label = 'Flush 在关闭的句柄上失败'; Marker = 'BEFORE_FLUSH'; Code = '$output.Dispose()'; Length = -1 },
        @{ Label = '同长度内容读回不一致'; Marker = 'BEFORE_FLUSH'; Code = '$output.Position = 0; $output.WriteByte(0)'; Length = -1 }
    )) {
        $case = New-Case $fault.Label
        Assert-Result $case (Invoke-ChecksumCase $case -FaultMarker $fault.Marker -FaultCode $fault.Code) $false
        Assert-Case ([IO.File]::Exists($case.Sidecar)) "$($fault.Label)：新建但未确认的证据保留"
        if ($fault.Length -ge 0) { Assert-Case (([IO.FileInfo]::new($case.Sidecar)).Length -eq $fault.Length) '部分写入未被删除或偷偷重写' }
        Open-Writer $case.Sidecar
    }
    foreach ($badInput in @('missing', 'directory')) {
        $case = New-Case "拒绝 $badInput 输入"
        $case.InputPath = if ($badInput -eq 'missing') { Join-Path $case.Root '不存在.exe' } else { $case.Parent }
        Assert-Result $case (Invoke-ChecksumCase $case) $false
        Assert-Case (-not [IO.File]::Exists($case.Sidecar)) '无效输入不生成 sidecar'
    }
    # Deliberately last: lack of symlink privileges must fail, not silently skip
    # these assertions or emit a completed summary for the whole suite.
    foreach ($destination in @('Target', 'Sentinel', 'missing')) {
        $case = New-Case "已有指向 $destination 的 sidecar 符号链接"
        $target = if ($destination -eq 'missing') { Join-Path $case.Root '未创建目标.bin' } else { $case.$destination }
        [DeepSeekMonitor.ReleaseVerification.Tests.LiteralChecksumFixtures]::CreateFileSymbolicLink($case.Sidecar, $target)
        $before = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralChecksumFixtures]::ReadSymbolicLinkEvidence($case.Sidecar)
        Assert-Case (-not [string]::IsNullOrEmpty($before)) '启动前确认符号链接本体身份和原始 reparse 数据'
        Assert-Result $case (Invoke-ChecksumCase $case) $false
        $after = [DeepSeekMonitor.ReleaseVerification.Tests.LiteralChecksumFixtures]::ReadSymbolicLinkEvidence($case.Sidecar)
        Write-NewText (Join-Path $case.Root 'symlink-evidence.json') ([ordered]@{ before = $before; after = $after } | ConvertTo-Json)
        Assert-Case ($before -ceq $after) '失败后符号链接本体身份及原始目标数据不变，未删除重建或改向'
        if ($destination -eq 'missing') { Assert-Case (-not [IO.File]::Exists($target)) '悬空符号链接未创建目标文件' }
    }
    $summary = [ordered]@{
        scope = 'release-checksum-windows-synthetic-files'; completed = $true
        cases = $script:caseNumber; assertions = $script:assertions.Count; passed = $script:assertions.Count; failed = 0
        powershell = $PSVersionTable.PSVersion.ToString(); executable = $pwsh
        realInstaller = 'NOT RUN'; evidence = $root
    }
    Write-NewText (Join-Path $root 'summary.json') ($summary | ConvertTo-Json -Depth 4)
    Write-Host ('RELEASE_CHECKSUM_WINDOWS_SUMMARY ' + ($summary | ConvertTo-Json -Compress))
}
catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    Write-NewText (Join-Path $root 'failure.json') ([ordered]@{
        error = $exception.ToString(); code = ($exception.HResult -band 0xffff)
        completed = $false; casesStarted = $script:caseNumber; assertions = $script:assertions.Count
    } | ConvertTo-Json -Depth 4)
    throw
}
finally {
    Write-NewText (Join-Path $root 'assertions.json') (ConvertTo-Json -InputObject @($script:assertions.ToArray()) -Depth 4)
    Write-Host "证据保留：$root"
}
