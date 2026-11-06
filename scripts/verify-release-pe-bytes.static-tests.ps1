#requires -Version 7.0
# 独立纯字节解析回归文本：未执行。不是 Windows 文件锁/真实主流程或安装验收。
# 用户运行：pwsh -NoProfile -File scripts/verify-release-pe-bytes.static-tests.ps1
param([switch]$PassThru)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'release-pe-version.cs')
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-release.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PeReleaseVersionIssues'
}, $false))
if ($functions.Count -ne 1) { throw '必须恰有一个原版本规则函数。' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$script:Assertions = 0
function Assert-Bytes([bool]$Condition, [string]$Label) {
    $script:Assertions += 1
    $record = [pscustomobject]@{
        kind = 'release-pe-byte-assertion'
        index = $script:Assertions
        label = $Label
        passed = $Condition
    }
    Write-Host "PE_BYTE_ASSERT $($record | ConvertTo-Json -Compress)"
    if ($PassThru) { $record }
    if (-not $Condition) { throw "断言失败：$Label" }
}
function Assert-Rejected([byte[]]$Bytes, [string]$Label) {
    $rejected = $false
    try { $null = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($Bytes) }
    catch { $rejected = $true }
    Assert-Bytes $rejected $Label
}
function Set-U16([byte[]]$Bytes, [int]$Offset, [uint16]$Value) { [BitConverter]::GetBytes($Value).CopyTo($Bytes, $Offset) }
function Set-U32([byte[]]$Bytes, [int]$Offset, [uint32]$Value) { [BitConverter]::GetBytes($Value).CopyTo($Bytes, $Offset) }

function New-VersionBlock {
    param([string]$Key, [uint16]$Type, [byte[]]$Value = @(), [uint16]$ValueLength = 0, [byte[][]]$Children = @())
    $stream = [IO.MemoryStream]::new()
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0)
        $writer.Write($ValueLength)
        $writer.Write($Type)
        $writer.Write([Text.Encoding]::Unicode.GetBytes($Key + "`0"))
        while ($stream.Length % 4) { $writer.Write([byte]0) }
        $writer.Write($Value)
        foreach ($child in $Children) {
            while ($stream.Length % 4) { $writer.Write([byte]0) }
            $writer.Write($child)
        }
        $writer.Flush()
        [byte[]]$result = $stream.ToArray()
        Set-U16 $result 0 ([uint16]$result.Length)
        return ,$result
    }
    finally { $writer.Dispose(); $stream.Dispose() }
}
function New-VersionString([string]$Key, [string]$Value) {
    return ,(New-VersionBlock -Key $Key -Type 1 -Value ([Text.Encoding]::Unicode.GetBytes($Value + "`0")) -ValueLength ($Value.Length + 1))
}
function New-PeFixture {
    param([string]$TableKey = '040904B0', [string]$FileVersion = '1.3.1', [string]$SecondVersion,
        [switch]$Pe64, [switch]$DuplicateField, [switch]$PreRelease, [int]$FixedBuild = 1,
        [switch]$OmitTranslation, [switch]$MismatchedTranslation)
    [byte[]]$fixed = [byte[]]::new(52)
    Set-U32 $fixed 0 ([uint32]4277077181) # VS_FFI_SIGNATURE
    Set-U32 $fixed 4 65536
    Set-U32 $fixed 8 65539 # 1.3
    Set-U32 $fixed 12 ([uint32]($FixedBuild -shl 16))
    Set-U32 $fixed 24 63
    if ($PreRelease) { Set-U32 $fixed 28 2 }
    [byte[]]$file = New-VersionString 'FileVersion' $FileVersion
    [byte[][]]$fields = @()
    $fields += ,$file
    if ($DuplicateField) { $fields += ,$file }
    [byte[]]$table = New-VersionBlock -Key $TableKey -Type 1 -Children $fields
    [byte[][]]$tables = @()
    $tables += ,$table
    if ($SecondVersion) {
        [byte[]]$second = New-VersionString 'FileVersion' $SecondVersion
        $tables += ,(New-VersionBlock -Key '040C04B0' -Type 1 -Children (,$second))
    }
    [byte[]]$strings = New-VersionBlock -Key 'StringFileInfo' -Type 1 -Children $tables
    [byte[][]]$rootChildren = @()
    $rootChildren += ,$strings
    if (-not $OmitTranslation) {
        [byte[]]$mapping = [byte[]]::new($(if ($SecondVersion) { 8 } else { 4 }))
        Set-U16 $mapping 0 $(if ($MismatchedTranslation) { 0x411 } else { 0x409 })
        Set-U16 $mapping 2 0x4B0
        if ($SecondVersion) { Set-U16 $mapping 4 0x40C; Set-U16 $mapping 6 0x4B0 }
        [byte[]]$translation = New-VersionBlock -Key 'Translation' -Type 0 -Value $mapping -ValueLength $mapping.Length
        $rootChildren += ,(New-VersionBlock -Key 'VarFileInfo' -Type 1 -Children (,$translation))
    }
    [byte[]]$resource = New-VersionBlock -Key 'VS_VERSION_INFO' -Type 0 -Value $fixed -ValueLength 52 -Children $rootChildren
    $resourceSize = 96 + $resource.Length
    $rawSize = [int]([math]::Ceiling($resourceSize / 512.0) * 512)
    [byte[]]$pe = [byte[]]::new(512 + $rawSize)
    Set-U16 $pe 0 0x5A4D
    Set-U32 $pe 0x3C 64
    Set-U32 $pe 64 0x4550
    Set-U16 $pe 68 $(if ($Pe64) { 0x8664 } else { 0x14C })
    Set-U16 $pe 70 1
    $optionalSize = if ($Pe64) { 240 } else { 224 }
    $directoryOffset = if ($Pe64) { 112 } else { 96 }
    Set-U16 $pe 84 $optionalSize
    Set-U16 $pe 88 $(if ($Pe64) { 0x20B } else { 0x10B })
    Set-U32 $pe (88 + $directoryOffset - 4) 16
    Set-U32 $pe (88 + $directoryOffset + 16) 0x1000
    Set-U32 $pe (88 + $directoryOffset + 20) $resourceSize
    $section = 88 + $optionalSize
    Set-U32 $pe ($section + 8) $resourceSize
    Set-U32 $pe ($section + 12) 0x1000
    Set-U32 $pe ($section + 16) $rawSize
    Set-U32 $pe ($section + 20) 512
    Set-U16 $pe (512 + 14) 1
    Set-U32 $pe (512 + 16) 16
    Set-U32 $pe (512 + 20) ([uint32]2147483672) # directory 24
    Set-U16 $pe (512 + 24 + 14) 1
    Set-U32 $pe (512 + 40) 1
    Set-U32 $pe (512 + 44) ([uint32]2147483696) # directory 48
    Set-U16 $pe (512 + 48 + 14) 1
    Set-U32 $pe (512 + 64) 0x409
    Set-U32 $pe (512 + 68) 72
    Set-U32 $pe (512 + 72) (0x1000 + 96)
    Set-U32 $pe (512 + 76) $resource.Length
    $resource.CopyTo($pe, 512 + 96)
    return ,$pe
}

foreach ($pe64 in @($false, $true)) {
    $bytes = New-PeFixture -Pe64:$pe64
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($bytes)
    Assert-Bytes ($infos.Length -eq 1) "PE64=$pe64：从 bytes 取得一个资源表"
    Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0) "PE64=$pe64：文本/固定版本一致，ProductVersion 可缺失"
}
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -SecondVersion '1.3.1'))
Assert-Bytes ($infos.Length -eq 2) '枚举所有语言字符串表'
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -SecondVersion '1.3.10'))
Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[1] '1.3.1').Count -gt 0) '第二语言不符不能借首语言通过'
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -FixedBuild 10))
Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -gt 0) '文本匹配但固定字段错误仍不可通过'
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -PreRelease))
Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -gt 0) '字节资源中的预发行标记被保留'
Assert-Rejected (New-PeFixture -TableKey '40904B0 ') '拒绝带空白的伪八位语言表键'
Assert-Rejected (New-PeFixture -TableKey '040904G0') '拒绝非十六进制语言表键'
Assert-Rejected (New-PeFixture -DuplicateField) '拒绝重复 FileVersion 字段'
Assert-Rejected (New-PeFixture -OmitTranslation) '缺少 Translation 时不采纳任意语言表'
Assert-Rejected (New-PeFixture -OmitTranslation -TableKey '041104B0') '缺 Translation 的非 US 表不能比旧 FileVersionInfo 门禁更宽'
Assert-Rejected (New-PeFixture -MismatchedTranslation) 'Translation 必须与全部字符串表一一匹配'
$broken = New-PeFixture; Set-U32 $broken (512 + 40) 2
Assert-Rejected $broken '拒绝非标准版本资源名称 ID 2'
$broken = New-PeFixture; Set-U16 $broken (512 + 12) 1; Set-U16 $broken (512 + 14) 0
Assert-Rejected $broken 'RT_VERSION 不能藏在 named entries 分区'
$broken = New-PeFixture; Set-U16 $broken (512 + 48 + 14) 2
Set-U32 $broken (512 + 72) 0x408; Set-U32 $broken (512 + 76) 72
Assert-Rejected $broken '拒绝未升序的语言 numeric ID'
$broken = New-PeFixture; Set-U16 $broken (512 + 48 + 14) 2
Set-U32 $broken (512 + 72) 0x409; Set-U32 $broken (512 + 76) 72
Assert-Rejected $broken '拒绝重复语言 numeric ID'
$broken = New-PeFixture; Set-U32 $broken (88 + 96 + 20) ([uint32]::MaxValue)
Assert-Rejected $broken '资源目录长度越界'
$broken = New-PeFixture; Set-U32 $broken (512 + 72) ([uint32]4294967040)
Assert-Rejected $broken '资源数据 RVA 越界'
$broken = New-PeFixture; Set-U32 $broken (512 + 20) ([uint32]2147483648)
Assert-Rejected $broken '资源目录循环不能当作正确版本层级'
$broken = New-PeFixture; Set-U16 $broken (512 + 96) 5
Assert-Rejected $broken '版本块总长不足'
$broken = New-PeFixture; $broken[512 + 96 + 40] = 0
Assert-Rejected $broken '固定版本签名错误'
$broken = New-PeFixture; Set-U16 $broken 70 2
Set-U32 $broken (312 + 40 + 8) 64
Set-U32 $broken (312 + 40 + 12) 0x1080
Set-U32 $broken (312 + 40 + 16) 64
Set-U32 $broken (312 + 40 + 20) 512
Assert-Rejected $broken '拒绝只覆盖资源区间中部的第二节 VA 重叠'
Assert-Rejected ([byte[]](New-PeFixture)[0..600]) '截断实际资源字节'

# 用父入口的真实纯函数检查返回协议；只做合成记录故障注入，不执行父主流程。
$completionAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-release-version.static-tests.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$completionFunctions = @($completionAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CompletedPeByteAssertions'
}, $false))
if ($completionFunctions.Count -ne 1) { throw '必须恰有一个字节回归完成协议校验函数。' }
. ([scriptblock]::Create($completionFunctions[0].Extent.Text))
foreach ($case in @('complete', 'partial-no-summary', 'summary-only', 'count-mismatch', 'incomplete', 'duplicate-summary', 'completion-not-last', 'false-passed-count', 'false-failed-count', 'bad-index', 'failed-row', 'nonboolean-row', 'nonzero-exit')) {
    $record = [pscustomobject]@{ kind = 'release-pe-byte-assertion'; index = 1; label = 'synthetic'; passed = $true }
    $completion = [pscustomobject]@{ kind = 'release-pe-byte-summary'; schemaVersion = 1; scope = 'release-pe-byte-parser'; assertions = 1; passed = 1; failed = 0; completed = $true }
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
    }
    $accepted = $false
    try { $accepted = @(Get-CompletedPeByteAssertions -Execution $records -ExitCode $exitCode).Count -eq 1 }
    catch { $accepted = $false }
    Assert-Bytes ($accepted -eq ($case -eq 'complete')) "字节返回协议：$case"
}

$byteSummary = [pscustomobject]@{
    kind = 'release-pe-byte-summary'
    schemaVersion = 1
    scope = 'release-pe-byte-parser'
    assertions = $script:Assertions
    passed = $script:Assertions
    failed = 0
    completed = $true
}
Write-Host "PE_BYTE_SUMMARY $($byteSummary | ConvertTo-Json -Compress)"
Write-Host '只验证合成字节解析与版本规则；未执行发行校验主流程、Windows 文件锁或安装验收。'
if ($PassThru) { $byteSummary }
