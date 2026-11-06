#requires -Version 7.0
# 独立纯字节解析回归文本：未执行。不是 Windows 文件锁/真实主流程或安装验收。
# 用户运行：pwsh -NoProfile -File scripts/verify-release-pe-bytes.static-tests.ps1
param([switch]$PassThru)
$ErrorActionPreference = 'Stop'
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'release-pe-version.cs')
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
        [switch]$OmitTranslation, [switch]$MismatchedTranslation,
        [uint32]$StructureVersion = 65536, [uint16]$ContainerType = 1)
    [byte[]]$fixed = [byte[]]::new(52)
    Set-U32 $fixed 0 ([uint32]4277077181) # VS_FFI_SIGNATURE
    Set-U32 $fixed 4 $StructureVersion
    Set-U32 $fixed 8 65539 # 1.3
    Set-U32 $fixed 12 ([uint32]($FixedBuild -shl 16))
    Set-U32 $fixed 24 63
    if ($PreRelease) { Set-U32 $fixed 28 2 }
    [byte[]]$file = New-VersionString 'FileVersion' $FileVersion
    [byte[][]]$fields = @()
    $fields += ,$file
    if ($DuplicateField) { $fields += ,$file }
    [byte[]]$table = New-VersionBlock -Key $TableKey -Type $ContainerType -Children $fields
    [byte[][]]$tables = @()
    $tables += ,$table
    if ($SecondVersion) {
        [byte[]]$second = New-VersionString 'FileVersion' $SecondVersion
        $tables += ,(New-VersionBlock -Key '040C04B0' -Type $ContainerType -Children (,$second))
    }
    [byte[]]$strings = New-VersionBlock -Key 'StringFileInfo' -Type $ContainerType -Children $tables
    [byte[][]]$rootChildren = @()
    $rootChildren += ,$strings
    if (-not $OmitTranslation) {
        [byte[]]$mapping = [byte[]]::new($(if ($SecondVersion) { 8 } else { 4 }))
        Set-U16 $mapping 0 $(if ($MismatchedTranslation) { 0x411 } else { 0x409 })
        Set-U16 $mapping 2 0x4B0
        if ($SecondVersion) { Set-U16 $mapping 4 0x40C; Set-U16 $mapping 6 0x4B0 }
        [byte[]]$translation = New-VersionBlock -Key 'Translation' -Type 0 -Value $mapping -ValueLength $mapping.Length
        $rootChildren += ,(New-VersionBlock -Key 'VarFileInfo' -Type $ContainerType -Children (,$translation))
    }
    [byte[]]$resource = New-VersionBlock -Key 'VS_VERSION_INFO' -Type 0 -Value $fixed -ValueLength 52 -Children $rootChildren
    return ,(New-PeResources -Resources (,$resource) -Languages @(0x409) -Pe64:$Pe64)
}
function New-PeResources {
    param([byte[][]]$Resources, [uint16[]]$Languages, [switch]$Pe64)
    if ($Resources.Count -ne $Languages.Count -or $Resources.Count -eq 0) { throw 'fixture 的语言和资源数必须相等且非零。' }
    $dataEntries = 64 + 8 * $Resources.Count
    $resourceSize = [int]([math]::Ceiling(($dataEntries + 16 * $Resources.Count) / 16.0) * 16)
    $blobOffsets = @()
    foreach ($resource in $Resources) {
        $blobOffsets += $resourceSize
        $resourceSize += [int]([math]::Ceiling($resource.Length / 4.0) * 4)
    }
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
    Set-U16 $pe (512 + 48 + 14) $Resources.Count
    for ($index = 0; $index -lt $Resources.Count; $index++) {
        $entry = $dataEntries + 16 * $index
        Set-U32 $pe (512 + 64 + 8 * $index) $Languages[$index]
        Set-U32 $pe (512 + 68 + 8 * $index) $entry
        Set-U32 $pe (512 + $entry) (0x1000 + $blobOffsets[$index])
        Set-U32 $pe (512 + $entry + 4) $Resources[$index].Length
        $Resources[$index].CopyTo($pe, 512 + $blobOffsets[$index])
    }
    return ,$pe
}

# 精确重建 NSIS v311 ResourceVersionInfo.cpp 的相关序列化格式，不是实际 exe。
# 构造器把 52 字节 fixed 归零，仅设置 signature/OS/type；VIProductVersion
# 同时产生固定 file/product 版本。ExportToStream 只存选定语言的一个小写表键，
# 三层空容器 type=0，String type=1，Translation type=0 且当前语言排第一。
function New-NsisVersionResource {
    param([uint16]$Language = 0x409, [uint16]$CodePage = 1252,
        [uint16[]]$TranslationLanguages = @(0x409), [uint16[]]$TranslationCodePages = @(1252),
        [string]$FileVersion = '1.3.1', [int]$FixedBuild = 1,
        [string]$ProductVersion, [switch]$DuplicateTranslation)
    [byte[]]$fixed = [byte[]]::new(52)
    Set-U32 $fixed 0 ([uint32]4277077181)
    Set-U32 $fixed 8 65539
    Set-U32 $fixed 12 ([uint32]($FixedBuild -shl 16))
    Set-U32 $fixed 16 65539
    Set-U32 $fixed 20 65536
    Set-U32 $fixed 32 4
    Set-U32 $fixed 36 1
    [byte[][]]$fields = @()
    # DefineList serializes these ordinary keys in sorted order.
    $fields += ,(New-VersionString 'FileDescription' 'DeepSeek Monitor')
    $fields += ,(New-VersionString 'FileVersion' $FileVersion)
    $fields += ,(New-VersionString 'LegalCopyright' 'Copyright')
    $fields += ,(New-VersionString 'ProductName' 'DeepSeek Monitor')
    if ($ProductVersion) { $fields += ,(New-VersionString 'ProductVersion' $ProductVersion) }
    $tableKey = '{0:x4}{1:x4}' -f $Language, $CodePage
    [byte[]]$table = New-VersionBlock -Key $tableKey -Type 0 -Children $fields
    [byte[]]$strings = New-VersionBlock -Key 'StringFileInfo' -Type 0 -Children (,$table)
    if ($TranslationLanguages.Count -ne $TranslationCodePages.Count) { throw 'fixture 的 Translation 语言/代码页数必须相等。' }
    [byte[]]$mapping = [byte[]]::new(4 * $TranslationLanguages.Count)
    for ($index = 0; $index -lt $TranslationLanguages.Count; $index++) {
        Set-U16 $mapping (4 * $index) $TranslationLanguages[$index]
        Set-U16 $mapping (4 * $index + 2) $TranslationCodePages[$index]
    }
    [byte[]]$translation = New-VersionBlock -Key 'Translation' -Type 0 -Value $mapping -ValueLength $mapping.Length
    [byte[][]]$variables = @(); $variables += ,$translation
    if ($DuplicateTranslation) { $variables += ,$translation }
    [byte[]]$varInfo = New-VersionBlock -Key 'VarFileInfo' -Type 0 -Children $variables
    [byte[][]]$children = @(); $children += ,$strings; $children += ,$varInfo
    return ,(New-VersionBlock -Key 'VS_VERSION_INFO' -Type 0 -Value $fixed -ValueLength 52 -Children $children)
}

function Find-FixtureBlock([byte[]]$Bytes, [string]$Key) {
    # Only locates named blocks in controlled synthetic fixtures, never real PE.
    [byte[]]$needle = [Text.Encoding]::Unicode.GetBytes($Key + "`0")
    for ($index = 6; $index -le $Bytes.Length - $needle.Length; $index += 2) {
        $matches = $true
        for ($part = 0; $part -lt $needle.Length; $part++) {
            if ($Bytes[$index + $part] -ne $needle[$part]) { $matches = $false; break }
        }
        if ($matches) { return ($index - 6) }
    }
    throw "合成 fixture 缺块：$Key"
}

foreach ($pe64 in @($false, $true)) {
    $bytes = New-PeFixture -Pe64:$pe64
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($bytes)
    Assert-Bytes ($infos.Length -eq 1) "PE64=$pe64：从 bytes 取得一个资源表"
    Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0) "PE64=$pe64：文本/固定版本一致，ProductVersion 可缺失"
}

# 兼容矩阵与拒绝矩阵覆盖两个独立格式维度，不把格式兼容当作版本通过。
foreach ($structureVersion in @([uint32]0, [uint32]65536)) {
    foreach ($containerType in @([uint16]0, [uint16]1)) {
        $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -StructureVersion $structureVersion -ContainerType $containerType))
        Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0) "已知结构版本=$structureVersion / 空容器类型=$containerType"
    }
}
foreach ($structureVersion in @([uint32]1, [uint32]65537, [uint32]131072, [uint32]::MaxValue)) {
    Assert-Rejected (New-PeFixture -StructureVersion $structureVersion) "未知 fixed 结构版本仍拒绝：$structureVersion"
}
[byte[]]$nsis = New-NsisVersionResource
Assert-Bytes ([BitConverter]::ToUInt32($nsis, 44) -eq 0) 'NSIS 精确合成资源：dwStrucVersion=0'
Assert-Bytes ([BitConverter]::ToUInt32($nsis, 64) -eq 0 -and [BitConverter]::ToUInt32($nsis, 68) -eq 0 -and
    [BitConverter]::ToUInt32($nsis, 72) -eq 4 -and [BitConverter]::ToUInt32($nsis, 76) -eq 1) 'NSIS 精确合成资源：flags/mask=0、VOS_WINDOWS32=4、VFT_APP=1'
foreach ($key in @('StringFileInfo', '040904e4', 'VarFileInfo')) {
    $block = Find-FixtureBlock $nsis $key
    Assert-Bytes ([BitConverter]::ToUInt16($nsis, $block + 2) -eq 0 -and [BitConverter]::ToUInt16($nsis, $block + 4) -eq 0) "NSIS 精确合成空容器：$key"
    [byte[]]$bad = $nsis.Clone(); Set-U16 $bad ($block + 4) 2
    Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) "未知容器 wType=2：$key"
    [byte[]]$bad = $nsis.Clone(); Set-U16 $bad ($block + 2) 1
    Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) "空容器非零 wValueLength：$key"
    [byte[]]$mixed = $nsis.Clone(); Set-U16 $mixed ($block + 4) 1
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeResources -Resources (,$mixed) -Languages @(0x409)))
    Assert-Bytes ($infos.Length -eq 1) "本地映射允许已知容器 type 混用：$key"
}
foreach ($pe64 in @($false, $true)) {
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeResources -Resources (,$nsis) -Languages @(0x409) -Pe64:$pe64))
    Assert-Bytes ($infos.Length -eq 1 -and $infos[0].Resource -ceq '00000001/0409/040904e4') "NSIS 单语言资源 PE64=$pe64：保留小写 1252 表键"
    Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0) "NSIS 单语言资源 PE64=$pe64：全部版本规则通过"
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeResources -Resources (,(New-NsisVersionResource -ProductVersion '1.3.1')) -Languages @(0x409) -Pe64:$pe64))
    Assert-Bytes ($infos[0].ProductVersion -ceq '1.3.1' -and @(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0) "NSIS PE64=$pe64：Tauri 默认模板的 ProductVersion 文本也可通过"
}
foreach ($key in @('FileVersion', 'Translation')) {
    [byte[]]$bad = $nsis.Clone(); $block = Find-FixtureBlock $bad $key
    Set-U16 $bad ($block + 4) $(if ($key -eq 'Translation') { 1 } else { 0 })
    Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) "NSIS 兼容不放宽叶类型：$key"
}
[byte[]]$bad = $nsis.Clone(); Set-U32 $bad 40 0
Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) 'NSIS 结构版本 0 仍检查固定签名'
[byte[]]$bad = $nsis.Clone(); $block = Find-FixtureBlock $bad 'Translation'; Set-U16 $bad ($block + 2) 8
Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) 'NSIS Translation 声明值超出块边界'
[byte[]]$bad = $nsis.Clone(); Set-U16 $bad ($block + 2) 3
Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) 'NSIS Translation 非完整语言/代码页对'
[byte[]]$bad = $nsis[0..($nsis.Length - 2)]
Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) 'NSIS 根块截断一个字节'
Assert-Rejected (New-PeResources -Resources (,(New-NsisVersionResource -DuplicateTranslation)) -Languages @(0x409)) 'NSIS 重复 Translation 块仍拒绝'
Assert-Rejected (New-PeResources -Resources (,(New-NsisVersionResource -TranslationLanguages @(0x409, 0x409) -TranslationCodePages @(1252, 1252))) -Languages @(0x409)) 'NSIS 重复 Translation 对仍拒绝'

# 多语言 NSIS：每个 RT_VERSION/1/LANGID 只有自己的表，每份 Translation
# 包含所有语言和代码页，且自己的条目排第一。所有 leaf 均返回，不选最先匹配项。
[byte[]]$nsisEnglish = New-NsisVersionResource -TranslationLanguages @(0x409, 0x804) -TranslationCodePages @(1252, 936)
[byte[]]$nsisChinese = New-NsisVersionResource -Language 0x804 -CodePage 936 -TranslationLanguages @(0x804, 0x409) -TranslationCodePages @(936, 1252)
[byte[][]]$nsisPair = @(); $nsisPair += ,$nsisEnglish; $nsisPair += ,$nsisChinese
foreach ($pe64 in @($false, $true)) {
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeResources -Resources $nsisPair -Languages @(0x409, 0x804) -Pe64:$pe64))
    Assert-Bytes ($infos.Length -eq 2 -and $infos[0].Resource -ceq '00000001/0409/040904e4' -and $infos[1].Resource -ceq '00000001/0804/080403a8') "NSIS 分语言资源 PE64=$pe64：返回两个不同代码页的表"
    Assert-Bytes (@($infos | ForEach-Object { Get-PeReleaseVersionIssues $_ '1.3.1' }).Count -eq 0) "NSIS 分语言资源 PE64=$pe64：所有语言满足版本规则"
}
$chineseTranslation = Find-FixtureBlock $nsisChinese 'Translation'
$translationValue = ($chineseTranslation + 6 + [Text.Encoding]::Unicode.GetByteCount("Translation`0") + 3) -band -4
Assert-Bytes ([BitConverter]::ToUInt16($nsisChinese, $translationValue) -eq 0x804 -and
    [BitConverter]::ToUInt16($nsisChinese, $translationValue + 4) -eq 0x409) 'NSIS 中文资源 Translation 首项是中文，随后英文'
foreach ($kind in @('text', 'fixed', 'product')) {
    $options = @{ Language = 0x804; CodePage = 936; TranslationLanguages = @(0x804, 0x409); TranslationCodePages = @(936, 1252) }
    switch ($kind) {
        'text' { $options.FileVersion = '1.3.10' }
        'fixed' { $options.FixedBuild = 10 }
        'product' { $options.ProductVersion = '1.3.10' }
    }
    [byte[][]]$conflict = @(); $conflict += ,$nsisEnglish; $conflict += ,(New-NsisVersionResource @options)
    $infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeResources -Resources $conflict -Languages @(0x409, 0x804)))
    Assert-Bytes (@(Get-PeReleaseVersionIssues $infos[0] '1.3.1').Count -eq 0 -and
        @(Get-PeReleaseVersionIssues $infos[1] '1.3.1').Count -gt 0) "NSIS 第二资源 $kind 版本冲突不可借英文表通过"
}
Assert-Rejected (New-PeResources -Resources (,$nsisEnglish) -Languages @(0x409)) 'NSIS Translation 多出的语言必须有对应资源，不能仅接受子集'
Assert-Rejected (New-PeResources -Resources $nsisPair -Languages @(0x409, 0x805)) 'NSIS 表键语言必须与目标资源 leaf 相同'
foreach ($kind in @('wrong-codepage', 'missing-back-reference', 'wrong-first-translation', 'unreferenced-table', 'standard-container')) {
    [byte[]]$badChinese = switch ($kind) {
        'wrong-codepage' { New-NsisVersionResource -Language 0x804 -CodePage 936 -TranslationLanguages @(0x804, 0x409) -TranslationCodePages @(936, 1200) }
        'missing-back-reference' { New-NsisVersionResource -Language 0x804 -CodePage 936 -TranslationLanguages @(0x804) -TranslationCodePages @(936) }
        'wrong-first-translation' { New-NsisVersionResource -Language 0x804 -CodePage 936 -TranslationLanguages @(0x409, 0x804) -TranslationCodePages @(1252, 936) }
        'unreferenced-table' { New-NsisVersionResource -Language 0x804 -CodePage 936 -TranslationLanguages @(0x409, 0x40C) -TranslationCodePages @(1252, 1252) }
        'standard-container' { $copy = $nsisChinese.Clone(); Set-U16 $copy ((Find-FixtureBlock $copy 'StringFileInfo') + 4) 1; ,$copy }
    }
    [byte[][]]$invalidPair = @(); $invalidPair += ,$nsisEnglish; $invalidPair += ,$badChinese
    Assert-Rejected (New-PeResources -Resources $invalidPair -Languages @(0x409, 0x804)) "NSIS 跨资源映射不完整或不支持：$kind"
}
foreach ($kind in @('truncated-last-resource', 'unknown-last-structure', 'invalid-last-signature')) {
    [byte[]]$badChinese = $nsisChinese.Clone()
    switch ($kind) {
        'truncated-last-resource' { $badChinese = $badChinese[0..($badChinese.Length - 2)] }
        'unknown-last-structure' { Set-U32 $badChinese 44 131072 }
        'invalid-last-signature' { Set-U32 $badChinese 40 0 }
    }
    [byte[][]]$invalidPair = @(); $invalidPair += ,$nsisEnglish; $invalidPair += ,$badChinese
    Assert-Rejected (New-PeResources -Resources $invalidPair -Languages @(0x409, 0x804)) "首个语言正确也不能掩盖后续资源损坏：$kind"
}
# 标准结构不能借 NSIS 兼容分支接受孤立 Translation；签名诱饵不应产生偏移。
[byte[]]$bad = $nsisEnglish.Clone(); Set-U32 $bad 44 65536
Assert-Rejected (New-PeResources -Resources (,$bad) -Languages @(0x409)) '标准 fixed 布局不允许未兑现的跨资源 Translation'
[byte[]]$withDecoy = New-PeResources -Resources $nsisPair -Languages @(0x409, 0x804)
$originalLength = $withDecoy.Length
$withDecoy += [byte[]]$nsis[40..91]
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read($withDecoy)
$fixedOffsets = @($infos.FixedFileInfoOffset | Sort-Object -Unique)
Assert-Bytes ($fixedOffsets.Count -eq 2 -and @($fixedOffsets | Where-Object { $_ -ge $originalLength }).Count -eq 0) '只暴露实际 RT_VERSION 固定字段偏移，忽略 overlay 签名诱饵'
$infos = [DeepSeekMonitor.ReleaseVerification.PeVersionSnapshot]::Read((New-PeFixture -SecondVersion '1.3.1'))
Assert-Bytes ($infos[0].FixedFileInfoOffset -eq $infos[1].FixedFileInfoOffset) '同一资源的多个表共享同一固定字段偏移，fixture 修改须去重'

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
Assert-Rejected (New-PeFixture -MismatchedTranslation) '本地字符串表不能缺少对应 Translation'
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
