#requires -Version 7.0
# 源码回归：从 verify-release.ps1 的 AST 提取规则纯函数，另执行同进程纯字节解析及 checksum 纯函数回归，
# 不运行发行校验主流程、
# 不启动/安装应用，不构建，不调用 Get-FileHash 或 FileVersionInfo 读取真实安装包。
# 本文件在第 18/19/20/21/26 轮修改时仅编写/静态审阅，未执行。
# 用户本机运行：pwsh -NoProfile -File scripts/verify-release-version.static-tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
# 在真正执行断言的同一进程取版本，不能用另一个 pwsh --version 代替。
# 取值失败会终止脚本；没有这条可核对的证据，Node 入口不能放行。
$runtimeVersion = $PSVersionTable.PSVersion
if ($null -eq $runtimeVersion -or $runtimeVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') {
    throw '发行版本纯函数回归要求当前进程为 PowerShell 7+ Core。'
}
$runtimeExecutable = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
if ([string]::IsNullOrWhiteSpace($runtimeExecutable) -or -not [System.IO.Path]::IsPathRooted($runtimeExecutable)) {
    throw '无法获取当前 PowerShell 可执行文件来源。'
}
$runtime = [ordered]@{
    schemaVersion = 1
    source = '$PSVersionTable.PSVersion'
    version = $runtimeVersion.ToString()
    major = $runtimeVersion.Major
    minor = $runtimeVersion.Minor
    patch = $runtimeVersion.Patch
    edition = $PSVersionTable.PSEdition
    executableSource = '[System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'
    executable = $runtimeExecutable
} | ConvertTo-Json -Compress
Write-Host "RELEASE_VERSION_RUNTIME $runtime"
$script:AssertionCount = 0
$script:PassedAssertions = 0
$script:FailedAssertions = 0
$script:AssertionSuite = 'filename'
$sourcePath = Join-Path $PSScriptRoot 'verify-release.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }

$names = @('Test-ReleaseFileNameVersion', 'Test-PortableExecutableHeader', 'Get-PeReleaseVersionIssues')
foreach ($name in $names) {
    $matches = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false))
    if ($matches.Count -ne 1) { throw "必须恰有一个函数：$name" }
    . ([scriptblock]::Create($matches[0].Extent.Text))
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    $script:AssertionCount += 1
    $passed = -not ($Actual -cne $Expected)
    if ($passed) { $script:PassedAssertions += 1 } else { $script:FailedAssertions += 1 }
    $row = [ordered]@{
        index = $script:AssertionCount
        suite = $script:AssertionSuite
        label = $Label
        status = $(if ($passed) { 'PASS' } else { 'FAIL' })
    } | ConvertTo-Json -Compress
    Write-Host "RELEASE_VERSION_ASSERT $row"
    if (-not $passed) { throw "${Label}：期望 [$Expected]，实际 [$Actual]" }
}
function Get-CompletedPeByteAssertions {
    param([object[]]$Execution, [int]$ExitCode)
    if ($ExitCode -ne 0) { throw "纯字节解析子脚本非零退出：$ExitCode" }
    if ($Execution.Count -lt 2) { throw '纯字节解析回归缺少断言或完成记录。' }
    $byteSummary = $Execution[-1]
    $byteAssertions = @($Execution[0..($Execution.Count - 2)])
    if ($byteSummary.kind -cne 'release-pe-byte-summary' -or $byteSummary.schemaVersion -ne 1 -or
        $byteSummary.scope -cne 'release-pe-byte-parser' -or $byteSummary.completed -isnot [bool] -or
        -not $byteSummary.completed -or $byteSummary.assertions -ne $byteAssertions.Count -or
        $byteSummary.passed -ne $byteAssertions.Count -or $byteSummary.failed -ne 0) {
        throw '纯字节解析回归未完整完成或记录计数不一致。'
    }
    if ($byteAssertions.Count -le 0) { throw '纯字节解析回归没有实际执行断言。' }
    for ($index = 0; $index -lt $byteAssertions.Count; $index++) {
        $assertion = $byteAssertions[$index]
        if ($assertion.kind -cne 'release-pe-byte-assertion' -or $assertion.index -ne $index + 1 -or
            $assertion.passed -isnot [bool] -or -not $assertion.passed -or [string]::IsNullOrWhiteSpace($assertion.label)) {
            throw '纯字节解析回归返回了失败或无法确认的断言记录。'
        }
    }
    return $byteAssertions
}
function Get-CompletedChecksumAssertions {
    param([object[]]$Execution, [int]$ExitCode)
    if ($ExitCode -ne 0) { throw "checksum 纯函数子脚本非零退出：$ExitCode" }
    if ($Execution.Count -lt 2) { throw 'checksum 纯函数回归缺少断言或完成记录。' }
    $checksumSummary = $Execution[-1]
    $checksumAssertions = @($Execution[0..($Execution.Count - 2)])
    # 除末尾唯一 summary 外只能有顺序断言；重复/提前完成与额外输出一律拒绝。
    if ($checksumSummary.kind -cne 'release-checksum-pure-summary' -or
        $checksumSummary.schemaVersion -isnot [int] -or $checksumSummary.schemaVersion -ne 1 -or
        $checksumSummary.scope -cne 'release-checksum-pure-functions-and-wiring' -or
        $checksumSummary.completed -isnot [bool] -or -not $checksumSummary.completed -or
        $checksumSummary.assertions -isnot [int] -or $checksumSummary.assertions -ne $checksumAssertions.Count -or
        $checksumSummary.passed -isnot [int] -or $checksumSummary.passed -ne $checksumAssertions.Count -or
        $checksumSummary.failed -isnot [int] -or $checksumSummary.failed -ne 0) {
        throw 'checksum 纯函数回归未完整完成或记录计数不一致。'
    }
    if ($checksumAssertions.Count -le 0) { throw 'checksum 纯函数回归没有实际执行断言。' }
    for ($index = 0; $index -lt $checksumAssertions.Count; $index++) {
        $assertion = $checksumAssertions[$index]
        if ($assertion.kind -cne 'release-checksum-pure-assertion' -or
            $assertion.index -isnot [int] -or $assertion.index -ne $index + 1 -or
            $assertion.passed -isnot [bool] -or -not $assertion.passed -or
            $assertion.label -isnot [string] -or [string]::IsNullOrWhiteSpace($assertion.label)) {
            throw 'checksum 纯函数回归返回了失败或无法确认的断言记录。'
        }
    }
    return $checksumAssertions
}
function New-VersionFixture {
    [pscustomobject]@{
        FileVersion = '1.3.1'
        FileMajorPart = 1
        FileMinorPart = 3
        FileBuildPart = 1
        FilePrivatePart = 0
        ProductVersion = '1.3.1'
        IsPreRelease = $false
    }
}

foreach ($name in @('DeepSeekMonitor_1.3.1_x64-setup.exe', 'Monitor-1.3.1.exe', 'Monitor 1.3.1.exe')) {
    Assert-Equal (Test-ReleaseFileNameVersion $name '1.3.1') $true "完整文件名版本 $name"
}
foreach ($name in @('Monitor_1.3.10_x64-setup.exe', 'Monitor_11.3.1.exe', 'Monitor_1.3.1.0.exe',
    'Monitor_1.3.1-beta.exe', 'Monitor_1.3.1+build.exe', 'Monitor_v1.3.1.exe', 'Monitor_1x3x1.exe')) {
    Assert-Equal (Test-ReleaseFileNameVersion $name '1.3.1') $false "拒绝文件名近似版本 $name"
}
Assert-Equal (Test-ReleaseFileNameVersion 'Monitor_1.3.1.exe' '') $false '缺失源码版本'

$script:AssertionSuite = 'pe-header'
# 这是只用于基本结构检查的内存 fixture，不是可执行安装包，更不能代替版本资源。
$pe = [byte[]]::new(512)
$pe[0] = 0x4D; $pe[1] = 0x5A
[BitConverter]::GetBytes([int]64).CopyTo($pe, 0x3C)
[BitConverter]::GetBytes([uint32]0x00004550).CopyTo($pe, 64)
[BitConverter]::GetBytes([uint16]1).CopyTo($pe, 70)
[BitConverter]::GetBytes([uint16]224).CopyTo($pe, 84)
[BitConverter]::GetBytes([uint16]0x10B).CopyTo($pe, 88)
Assert-Equal (Test-PortableExecutableHeader $pe) $true 'PE32 基本结构'
[BitConverter]::GetBytes([uint16]0x20B).CopyTo($pe, 88)
Assert-Equal (Test-PortableExecutableHeader $pe) $true 'PE32+ 基本结构'
Assert-Equal (Test-PortableExecutableHeader ([Text.Encoding]::UTF8.GetBytes('Tsuki-hash/DeepSeekMonitorWindows'))) $false '纯文本不能充当 PE'
Assert-Equal (Test-PortableExecutableHeader ([byte[]]::new(63))) $false '截断 DOS 头'
$badPe = $pe.Clone(); $badPe[0] = 0
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '缺少 MZ'
$badPe = $pe.Clone(); $badPe[64] = 0
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '缺少 PE 签名'
$badPe = $pe.Clone(); [BitConverter]::GetBytes([int]-1).CopyTo($badPe, 0x3C)
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '负 e_lfanew'
$badPe = $pe.Clone(); [BitConverter]::GetBytes([int]500).CopyTo($badPe, 0x3C)
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '越界 PE 头'
$badPe = $pe.Clone(); [BitConverter]::GetBytes([uint16]0).CopyTo($badPe, 70)
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '缺少 section'
$badPe = $pe.Clone(); [BitConverter]::GetBytes([uint16]512).CopyTo($badPe, 84)
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '越界 optional header / section table'
$badPe = $pe.Clone(); [BitConverter]::GetBytes([uint16]0x107).CopyTo($badPe, 88)
Assert-Equal (Test-PortableExecutableHeader $badPe) $false '未知 optional header magic'

$script:AssertionSuite = 'pe-version'
foreach ($version in @('1.3.1', '1.3.1.0', ' 1.3.1 ')) {
    $info = New-VersionFixture; $info.FileVersion = $version; $info.ProductVersion = $version
    Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count) 0 "受支持的 NSIS stable 文本 $version"
}
$info = New-VersionFixture; $info.ProductVersion = $null
Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count) 0 'ProductVersion 可缺失，FileVersion 文本及固定字段仍必需'
foreach ($version in @($null, '', '1.3.10', '1.3.1.1', '1.3.1-beta', '1.3.1+build', '1, 3, 1, 0', 'version 1.3.1')) {
    $info = New-VersionFixture; $info.FileVersion = $version
    Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count -gt 0) $true "缺失/不一致的 FileVersion $version"
}
$info = New-VersionFixture; $info.FileBuildPart = 10
Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count -gt 0) $true '文本正确而固定 FileVersion 错误'
$info = New-VersionFixture; $info.FilePrivatePart = 1
Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count -gt 0) $true '不吞掉非零 revision'
$info = New-VersionFixture; $info.ProductVersion = '1.3.10'
Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count -gt 0) $true 'ProductVersion 存在但冲突'
$info = New-VersionFixture; $info.IsPreRelease = $true
Assert-Equal (@(Get-PeReleaseVersionIssues $info '1.3.1').Count -gt 0) $true 'stable 不接受预发行标记'
Assert-Equal (@(Get-PeReleaseVersionIssues $null '1.3.1').Count -gt 0) $true '缺少版本资源'
foreach ($version in @('1.3.1-beta.1', '1.3.1+build', '1.3.1.0', '01.3.1', '65536.3.1', '')) {
    Assert-Equal (@(Get-PeReleaseVersionIssues (New-VersionFixture) $version).Count -gt 0) $true "不猜测源码版本映射 $version"
}

# 在同一已报告运行时的 pwsh 进程真正执行纯字节解析断言，而不只检查文件存在。
# 子脚本返回逐次真实断言记录；成功返回后再汇入同一协议，避免跨脚本作用域
# 修改计数器。抛错/缺文件/编译错误会阻止本脚本完成，零记录也不能放行。
$script:AssertionSuite = 'pe-bytes'
$global:LASTEXITCODE = 0
$byteExecution = @(& (Join-Path $PSScriptRoot 'verify-release-pe-bytes.static-tests.ps1') -PassThru)
$byteExitCode = $global:LASTEXITCODE
$byteAssertions = @(Get-CompletedPeByteAssertions -Execution $byteExecution -ExitCode $byteExitCode)
foreach ($assertion in $byteAssertions) {
    Assert-Equal $assertion.passed $true $assertion.label
}

# 独立第五组必须实际执行完整纯函数脚本，不从文件存在或 stdout 的 PASS 推断成功。
# 与前四组使用同一已报告的 PowerShell 进程，异常/退出/提前 return 均不能伪造完成。
$script:AssertionSuite = 'checksum-pure'
$global:LASTEXITCODE = 0
$checksumExecution = @(& (Join-Path $PSScriptRoot 'verify-release-checksum.static-tests.ps1') -PassThru)
$checksumExitCode = $global:LASTEXITCODE
$checksumAssertions = @(Get-CompletedChecksumAssertions -Execution $checksumExecution -ExitCode $checksumExitCode)
foreach ($assertion in $checksumAssertions) {
    Assert-Equal $assertion.passed $true $assertion.label
}

# 只有真正走完五组所有断言才输出完成记录；旧的一句 PASS 不是执行证据。
if ($script:AssertionCount -le 0 -or $script:FailedAssertions -ne 0) {
    throw '纯函数回归没有非零成功执行，不能生成完成记录。'
}
Write-Host '纯函数回归完成。未执行发行校验主流程或真实安装验收。'
$summary = [ordered]@{
    schemaVersion = 1
    scope = 'release-version-pure-functions'
    completed = $true
    assertions = $script:AssertionCount
    passed = $script:PassedAssertions
    failed = $script:FailedAssertions
} | ConvertTo-Json -Compress
Write-Host "RELEASE_VERSION_SUMMARY $summary"
