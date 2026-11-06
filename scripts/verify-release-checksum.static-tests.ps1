#requires -Version 7.0
# 第 26/27 轮：仅提取真实脚本的纯函数，不执行主流程、不读取真实安装包。
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

function Get-ChecksumReleaseStructure([string]$Text) {
    # Parse the executable structure, not comment/string lookalikes. A missing
    # anchor must fail before any offset comparison (-1 must never mean PASS).
    $localTokens = $null
    $errors = $null
    $tree = [Management.Automation.Language.Parser]::ParseInput($Text, [ref]$localTokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw '校验和释放结构无法解析。' }
    $owners = @{}
    $calls = @{}
    foreach ($name in @('output', 'snapshot')) {
        $found = @($tree.FindAll({ param($node)
            $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
            $node.Expression -is [Management.Automation.Language.VariableExpressionAst] -and
            $node.Expression.VariablePath.UserPath -ceq $name -and
            $node.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Member.Value -ieq 'Dispose'
        }, $true))
        if ($found.Count -ne 1) { throw "$name 必须恰有一个真实 Dispose 调用。" }
        $call = $found[0]
        $command = $call.Parent
        $pipeline = $command.Parent
        $block = $pipeline.Parent
        $owner = $block.Parent
        if ($call.Static -or $call.Arguments.Count -ne 0 -or
            $command -isnot [Management.Automation.Language.CommandExpressionAst] -or
            -not [object]::ReferenceEquals($command.Expression, $call) -or
            $pipeline -isnot [Management.Automation.Language.PipelineAst] -or
            $pipeline.PipelineElements.Count -ne 1 -or
            $block -isnot [Management.Automation.Language.StatementBlockAst] -or
            $block.Statements.Count -ne 1 -or $block.Traps.Count -ne 0 -or
            $owner -isnot [Management.Automation.Language.TryStatementAst] -or
            -not [object]::ReferenceEquals($owner.Finally, $block) -or $owner.CatchClauses.Count -ne 0) {
            throw "$name 必须是自身唯一 finally 中无条件执行的唯一语句。"
        }
        $owners[$name] = $owner
        $calls[$name] = $call
    }
    $outputTry = $owners.output
    $snapshotTry = $owners.snapshot
    if (-not [object]::ReferenceEquals($outputTry.Parent, $snapshotTry.Body)) {
        throw '输出 try/finally 必须直接嵌套在源快照 try 内。'
    }
    foreach ($name in @('output', 'snapshot')) {
        $assignments = @($tree.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -ceq $name
        }, $true))
        if ($assignments.Count -ne 1) { throw "$name 获取锚点缺失或不唯一。" }
        $owner = $owners[$name]
        $statements = @($owner.Parent.Statements)
        $index = [array]::IndexOf($statements, $owner)
        if ($owner.Parent -isnot [Management.Automation.Language.StatementBlockAst] -or $index -lt 1 -or
            -not [object]::ReferenceEquals($statements[$index - 1], $assignments[0]) -or
            $index -ne $statements.Count - 1) {
            throw "$name 获取后必须立即进入对应 try/finally，且该 try 为所在块末尾。"
        }
    }
    $mainTry = $snapshotTry.Parent.Parent
    $reports = @($tree.FindAll({ param($node)
        $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ieq 'Write-Output'
    }, $true))
    if ($reports.Count -ne 1) { throw '成功输出锚点必须存在且唯一。' }
    $report = $reports[0]
    $topStatements = @($tree.EndBlock.Statements)
    if ($mainTry -isnot [Management.Automation.Language.TryStatementAst] -or
        -not [object]::ReferenceEquals($mainTry.Parent, $tree.EndBlock) -or
        $report.CommandElements.Count -ne 2 -or
        $report.CommandElements[1] -isnot [Management.Automation.Language.VariableExpressionAst] -or
        $report.CommandElements[1].VariablePath.UserPath -cne 'outputPath' -or
        $report.Parent -isnot [Management.Automation.Language.PipelineAst] -or
        $report.Parent.PipelineElements.Count -ne 1 -or
        -not [object]::ReferenceEquals($report.Parent.Parent, $tree.EndBlock) -or
        -not [object]::ReferenceEquals($topStatements[-1], $report.Parent) -or
        $calls.output.Extent.StartOffset -ge $calls.snapshot.Extent.StartOffset -or
        $mainTry.Extent.EndOffset -ge $report.Extent.StartOffset) {
        throw '源锁必须保持到输出关闭，唯一成功输出必须晚于外层完整 try/catch。'
    }
    return [pscustomobject]@{ output = $calls.output; snapshot = $calls.snapshot; report = $report }
}

function Replace-ChecksumAnchor([string]$Text, [string]$Anchor, [string]$Replacement) {
    if (($Text.Split($Anchor, [StringSplitOptions]::None)).Count -ne 2) { throw "变异锚点缺失或不唯一：$Anchor" }
    return $Text.Replace($Anchor, $Replacement)
}

function Assert-ChecksumBindingStructure([string]$Text) {
    $structure = Get-ChecksumReleaseStructure $Text
    $outputTry = $structure.output.Parent.Parent.Parent.Parent
    $checks = @($outputTry.FindAll({ param($node)
        $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Static -and
        $node.Expression -is [Management.Automation.Language.TypeExpressionAst] -and
        $node.Expression.TypeName.FullName -ceq 'DeepSeekMonitor.ReleaseVerification.ChecksumOutputBinding' -and
        $node.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Member.Value -ceq 'Validate'
    }, $true))
    if ($checks.Count -ne 1) { throw '输出绑定检查缺失或不唯一。' }
    $check = $checks[0]
    if ($check.Arguments.Count -ne 2 -or
        $check.Arguments[0] -isnot [Management.Automation.Language.MemberExpressionAst] -or
        $check.Arguments[0].Expression -isnot [Management.Automation.Language.VariableExpressionAst] -or
        $check.Arguments[0].Expression.VariablePath.UserPath -cne 'output' -or
        $check.Arguments[0].Member.Value -cne 'SafeFileHandle' -or
        $check.Arguments[1] -isnot [Management.Automation.Language.VariableExpressionAst] -or
        $check.Arguments[1].VariablePath.UserPath -cne 'outputPath' -or
        $check.Parent -isnot [Management.Automation.Language.CommandExpressionAst] -or
        $check.Parent.Parent -isnot [Management.Automation.Language.PipelineAst] -or
        -not [object]::ReferenceEquals($check.Parent.Parent.Parent, $outputTry.Body) -or
        -not [object]::ReferenceEquals($outputTry.Body.Statements[-1], $check.Parent.Parent)) {
        throw '输出绑定检查必须无条件使用原句柄及路径，并处于输出 try 的最后。'
    }
    $reads = @($outputTry.Body.FindAll({ param($node)
        $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
        $node.Expression -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Expression.VariablePath.UserPath -ceq 'output' -and $node.Member.Value -in @('Flush', 'ReadByte')
    }, $true))
    if ($reads.Count -ne 3 -or @($reads | Where-Object { $_.Extent.EndOffset -ge $check.Extent.StartOffset }).Count -ne 0) {
        throw '绑定检查必须晚于真实 Flush 及两个读回检查，并早于两层释放。'
    }
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
$releaseStructure = Get-ChecksumReleaseStructure $source
Assert-Checksum ($null -ne $releaseStructure) '唯一 AST finally、获取/输出锚点及嵌套顺序保证全部释放后才报告成功'
foreach ($mutation in @('delete-output-dispose', 'delete-snapshot-dispose', 'swap-disposals',
    'duplicate-output-dispose', 'duplicate-snapshot-dispose', 'guard-output-dispose',
    'comment-only-output-dispose', 'missing-success-output', 'duplicate-success-output', 'early-success-output')) {
    $mutated = $source
    switch ($mutation) {
        'delete-output-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$output.Dispose()' '' }
        'delete-snapshot-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$snapshot.Dispose()' '' }
        'swap-disposals' {
            $mutated = Replace-ChecksumAnchor $mutated '$output.Dispose()' '$testSwapPlaceholder.Dispose()'
            $mutated = Replace-ChecksumAnchor $mutated '$snapshot.Dispose()' '$output.Dispose()'
            $mutated = Replace-ChecksumAnchor $mutated '$testSwapPlaceholder.Dispose()' '$snapshot.Dispose()'
        }
        'duplicate-output-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$output.Dispose()' '$output.Dispose(); $output.Dispose()' }
        'duplicate-snapshot-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$snapshot.Dispose()' '$snapshot.Dispose(); $snapshot.Dispose()' }
        'guard-output-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$output.Dispose()' 'if ($false) { $output.Dispose() }' }
        'comment-only-output-dispose' { $mutated = Replace-ChecksumAnchor $mutated '$output.Dispose()' '<# $output.Dispose() #>' }
        'missing-success-output' { $mutated = Replace-ChecksumAnchor $mutated 'Write-Output $outputPath' '' }
        'duplicate-success-output' { $mutated = Replace-ChecksumAnchor $mutated 'Write-Output $outputPath' 'Write-Output $outputPath; Write-Output $outputPath' }
        'early-success-output' {
            $mutated = Replace-ChecksumAnchor $mutated 'Write-Output $outputPath' ''
            $mutated = Replace-ChecksumAnchor $mutated '$snapshot.Dispose()' 'Write-Output $outputPath; $snapshot.Dispose()'
        }
    }
    # Parse-only negative fixtures: never invoke a mutated production script.
    Assert-Rejected { Get-ChecksumReleaseStructure $mutated } "释放结构必须拒绝负变异：$mutation"
}
Assert-ChecksumBindingStructure $source
Assert-Checksum ($source.Contains("Add-Type -LiteralPath (Join-Path `$PSScriptRoot 'release-checksum-binding.cs')")) '绑定 helper 逐字加载；原句柄与路径检查位于读回后、释放前'
$bindingAnchor = '[DeepSeekMonitor.ReleaseVerification.ChecksumOutputBinding]::Validate($output.SafeFileHandle, $outputPath)'
foreach ($mutation in @('missing-binding', 'duplicate-binding', 'guarded-binding', 'binding-after-dispose')) {
    $mutated = $source
    switch ($mutation) {
        'missing-binding' { $mutated = Replace-ChecksumAnchor $mutated $bindingAnchor '' }
        'duplicate-binding' { $mutated = Replace-ChecksumAnchor $mutated $bindingAnchor ($bindingAnchor + '; ' + $bindingAnchor) }
        'guarded-binding' { $mutated = Replace-ChecksumAnchor $mutated $bindingAnchor ('if ($false) { ' + $bindingAnchor + ' }') }
        'binding-after-dispose' {
            $mutated = Replace-ChecksumAnchor $mutated $bindingAnchor ''
            $mutated = Replace-ChecksumAnchor $mutated 'Write-Output $outputPath' ($bindingAnchor + "`nWrite-Output `$outputPath")
        }
    }
    Assert-Rejected { Assert-ChecksumBindingStructure $mutated } "绑定检查必须拒绝负变异：$mutation"
}

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
