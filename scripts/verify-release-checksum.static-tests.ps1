#requires -Version 7.0
# 第 26 轮：仅提取真实脚本的纯函数，不执行主流程、不读取真实安装包。
# 本轮仅编写、静态审阅；尚未运行。用户可在 PowerShell 7+ 自行执行。
param([switch]$PassThru)
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'release-checksum.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-ReleaseChecksumBytes'
}, $false))
if ($functions.Count -ne 1) { throw '必须恰有一个真实校验和纯函数。' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$script:assertions = 0
function Assert-Checksum([bool]$Condition, [string]$Label) {
    $script:assertions += 1
    $record = [pscustomobject]@{ kind = 'release-checksum-pure-assertion'; index = $script:assertions; label = $Label; passed = $Condition }
    Write-Host "RELEASE_CHECKSUM_PURE_ASSERT $($record | ConvertTo-Json -Compress)"
    if ($PassThru) { $record }
    if (-not $Condition) { throw "校验和断言失败：$Label" }
}
function Assert-Rejected([scriptblock]$Action, [string]$Label) {
    $rejected = $false
    try { $null = & $Action } catch { $rejected = $true }
    Assert-Checksum $rejected $Label
}

$utf8 = [Text.UTF8Encoding]::new($false, $true)
[byte[]]$empty = New-ReleaseChecksumBytes ([byte[]]::new(0)) 'empty.exe'
Assert-Checksum ($utf8.GetString($empty) -ceq ('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' + '  empty.exe' + "`n")) '空字节快照的已知 SHA-256'
[byte[]]$abc = [Text.Encoding]::ASCII.GetBytes('abc')
$original = [Convert]::ToBase64String($abc)
$name = '安装包 [ab] 空格 ' + [char]::ConvertFromUtf32(0x1F319) + '.exe'
[byte[]]$checksumBytes = New-ReleaseChecksumBytes $abc $name
Assert-Checksum ($utf8.GetString($checksumBytes) -ceq ('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' + '  ' + $name + "`n")) 'abc 已知哈希、Unicode、方括号及空格逐字保留'
Assert-Checksum ($checksumBytes[0] -eq 0x62 -and $checksumBytes[-1] -eq 10 -and $checksumBytes[-2] -ne 13) '无 BOM、末尾单个 LF'
Assert-Checksum ([Convert]::ToBase64String($abc) -ceq $original) '纯函数不修改输入快照'
foreach ($invalid in @('', '.', '..', 'a/b.exe', 'a\b.exe', 'x:stream', "a`nb.exe", "a`rb.exe", "a`0b.exe", 'x?.exe', 'x*.exe')) {
    Assert-Rejected { New-ReleaseChecksumBytes $abc $invalid } ('拒绝不适合校验和记录的文件名：' + [Convert]::ToBase64String($utf8.GetBytes($invalid)))
}
Assert-Rejected { New-ReleaseChecksumBytes $null 'missing.exe' } '缺失快照不当成空文件'
Assert-Rejected { New-ReleaseChecksumBytes $abc ([string][char]0xD800 + '.exe') } '非法 UTF-16 不替换为问号后成功'

# These are wiring guards, not evidence that Windows API/sharing tests ran.
$source = [IO.File]::ReadAllText($sourcePath)
Assert-Checksum ($source.Contains('[IO.FileMode]::CreateNew') -and $source.Contains('[IO.FileShare]::None')) 'sidecar 独占新建'
Assert-Checksum ($source -notmatch 'WriteAllText|WriteAllBytes|Test-Path|Remove-Item|\[IO\.File\]::Delete|Get-FileHash') '主流程无先检查后覆盖、按路径删除或二次路径哈希'
Assert-Checksum ($source.Contains('Add-Type -LiteralPath') -and $source.Contains('Get-Item -LiteralPath')) '源码及输入路径逐字处理'
Assert-Checksum ($source.Contains('$snapshot.LockedPath + ''.sha256''') -and $source.Contains('LockedFileSnapshot]::Open')) '输出绑定到锁定的规范卷路径'
Assert-Checksum ($source.Contains('$output.Flush($true)') -and $source.Contains('$output.ReadByte()')) '同句柄 durable flush 和逐字节读回'
Assert-Checksum ($source.IndexOf('finally { $output.Dispose() }') -lt $source.IndexOf('finally { $snapshot.Dispose() }') -and
    $source.IndexOf('finally { $snapshot.Dispose() }') -lt $source.LastIndexOf('Write-Output $outputPath')) '源锁保持到输出关闭，成功输出晚于全部释放'

# Exercise the real parent validator using only synthetic protocol objects.
# Parsing/extracting a function never executes the parent or recurses into us.
$completionAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-release-version.static-tests.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$completionFunctions = @($completionAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CompletedChecksumAssertions'
}, $false))
if ($completionFunctions.Count -ne 1) { throw '必须恰有一个校验和回归完成协议校验函数。' }
. ([scriptblock]::Create($completionFunctions[0].Extent.Text))
foreach ($case in @('complete', 'partial-no-summary', 'summary-only', 'count-mismatch', 'incomplete',
    'duplicate-summary', 'completion-not-last', 'false-passed-count', 'false-failed-count', 'bad-index',
    'failed-row', 'nonboolean-row', 'nonzero-exit', 'unknown-kind', 'empty-label',
    'string-count', 'string-index', 'nonboolean-completed')) {
    $record = [pscustomobject]@{ kind = 'release-checksum-pure-assertion'; index = 1; label = 'synthetic'; passed = $true }
    $completion = [pscustomobject]@{
        kind = 'release-checksum-pure-summary'; schemaVersion = 1; scope = 'release-checksum-pure-functions-and-wiring'
        assertions = 1; passed = 1; failed = 0; completed = $true
    }
    $records = @($record, $completion)
    $exitCode = 0
    switch ($case) {
        'partial-no-summary' { $records = @($record) }
        'summary-only' { $records = @($completion) }
        'count-mismatch' { $completion.assertions = 2 }
        'incomplete' { $completion.completed = $false }
        'duplicate-summary' { $records = @($record, $completion, $completion) }
        'completion-not-last' { $records = @($completion, $record) }
        'false-passed-count' { $completion.passed = 0 }
        'false-failed-count' { $completion.failed = 1 }
        'bad-index' { $record.index = 2 }
        'failed-row' { $record.passed = $false }
        'nonboolean-row' { $record.passed = 'true' }
        'nonzero-exit' { $exitCode = 17 }
        'unknown-kind' { $record.kind = 'pretend-checksum-assertion' }
        'empty-label' { $record.label = '' }
        'string-count' { $completion.assertions = '1' }
        'string-index' { $record.index = '1' }
        'nonboolean-completed' { $completion.completed = 'true' }
    }
    $accepted = $false
    try { $accepted = @(Get-CompletedChecksumAssertions -Execution $records -ExitCode $exitCode).Count -eq 1 }
    catch { $accepted = $false }
    Assert-Checksum ($accepted -eq ($case -eq 'complete')) "校验和返回协议：$case"
}

$summary = [pscustomobject]@{
    kind = 'release-checksum-pure-summary'; schemaVersion = 1; scope = 'release-checksum-pure-functions-and-wiring'
    completed = $true; assertions = $script:assertions; passed = $script:assertions; failed = 0
}
Write-Host "RELEASE_CHECKSUM_PURE_SUMMARY $($summary | ConvertTo-Json -Compress)"
if ($PassThru) { $summary }
