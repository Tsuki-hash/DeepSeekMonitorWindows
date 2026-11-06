# 校验**实际安装包**，而不只是源码。
#
# 背景（评审 P2）：v1.3.0 标签中的更新端点仍是旧仓库名，而更新检查禁止重定向；
# 源码已修正，但如果只验证源码就发版，用户手里的 exe 仍可能带着旧地址。
# 这个脚本对最终产物做三件事：
#
# 1. 计算 SHA-256，与发行页附件核对；
# 2. 在二进制里检索更新端点的仓库名（只读，不解包执行）；
# 3. 核对文件名中的完整版本 token，以及 PE 版本资源与 package.json 的一致性。
#
# 用法：pwsh -File scripts/verify-release.ps1 -InstallerPath <exe> [-ExpectedSha256 <hash>]
#
# 注意：这里只做静态检查。真正的「检查更新能否成功」需要安装后手工点一次，
# 脚本无法替代那一步。

param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Test-ReleaseFileNameVersion {
    param([string]$FileName, [string]$ExpectedVersion)

    if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { return $false }
    # 去掉扩展名后匹配完整 token；不能把 1.3.10、1.3.1.0、1.3.1-beta
    # 或 1.3.1+build 当成 1.3.1。下划线/空格和前置连字符仍可作文件名分隔符。
    $stem = [IO.Path]::GetFileNameWithoutExtension($FileName)
    $pattern = '(?<![0-9A-Za-z.+])' + [regex]::Escape($ExpectedVersion) + '(?![0-9A-Za-z.+-])'
    return [regex]::IsMatch($stem, $pattern)
}

function Test-PortableExecutableHeader {
    param([byte[]]$Bytes)

    # FileVersionInfo 的空值/零值不能证明输入是 PE；先核对 DOS、PE/COFF、
    # optional header 和 section table 的基本结构。这里只读，不加载或执行文件。
    if ($null -eq $Bytes -or $Bytes.Length -lt 64) { return $false }
    if ($Bytes[0] -ne 0x4D -or $Bytes[1] -ne 0x5A) { return $false }
    $peOffset = [BitConverter]::ToInt32($Bytes, 0x3C)
    if ($peOffset -lt 64 -or $peOffset -gt $Bytes.Length - 24) { return $false }
    if ([BitConverter]::ToUInt32($Bytes, $peOffset) -ne 0x00004550) { return $false }
    $sectionCount = [BitConverter]::ToUInt16($Bytes, $peOffset + 6)
    $optionalSize = [BitConverter]::ToUInt16($Bytes, $peOffset + 20)
    $optionalOffset = $peOffset + 24
    if ($sectionCount -eq 0 -or $optionalSize -lt 2) { return $false }
    if ([long]$optionalOffset + $optionalSize + 40L * $sectionCount -gt $Bytes.Length) { return $false }
    $magic = [BitConverter]::ToUInt16($Bytes, $optionalOffset)
    if ($magic -eq 0x10B) { return $optionalSize -ge 96 } # PE32
    if ($magic -eq 0x20B) { return $optionalSize -ge 112 } # PE32+
    return $false
}

function Get-PeReleaseVersionIssues {
    param([object]$VersionInfo, [string]$ExpectedVersion)

    # NSIS 的固定版本字段是四个 UInt16；stable x.y.z 可表示为 x.y.z.0。
    # 仅允许这两种完整文本形式，不接受前缀、额外非零 revision、逗号或描述文字。
    # prerelease/build metadata 的 NSIS 映射依构建器而异，不能擅自去掉后缀。
    $stable = [regex]::Match($ExpectedVersion, '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z')
    if (-not $stable.Success) {
        return '源码版本不是支持的 stable x.y.z；PE 版本映射需人工核对'
    }
    foreach ($part in 1..3) {
        if ([int]$stable.Groups[$part].Value -gt 65535) {
            return '源码版本超出 PE 固定版本 UInt16 范围'
        }
    }
    if ($null -eq $VersionInfo) { return 'PE 版本资源不可用' }

    $fixedExpected = "$ExpectedVersion.0"
    $fileVersion = [string]$VersionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace($fileVersion)) {
        'PE FileVersion 文本缺失'
    }
    elseif ($fileVersion.Trim() -cne $ExpectedVersion -and $fileVersion.Trim() -cne $fixedExpected) {
        "PE FileVersion 与源码版本不一致或格式不受支持：$fileVersion"
    }

    $fixedActual = '{0}.{1}.{2}.{3}' -f $VersionInfo.FileMajorPart, $VersionInfo.FileMinorPart, $VersionInfo.FileBuildPart, $VersionInfo.FilePrivatePart
    if ($fixedActual -cne $fixedExpected) {
        "PE 固定 FileVersion 与源码版本不一致：$fixedActual（期望 $fixedExpected）"
    }

    # 某些 NSIS 模板没有 ProductVersion 文本；不拿它替代必需的 FileVersion。
    # 若有该字段，则必须一致。缺失的 ProductVersion 不影响已验证的文件版本。
    $productVersion = [string]$VersionInfo.ProductVersion
    if (-not [string]::IsNullOrWhiteSpace($productVersion) -and
        $productVersion.Trim() -cne $ExpectedVersion -and $productVersion.Trim() -cne $fixedExpected) {
        "PE ProductVersion 与源码版本不一致或格式不受支持：$productVersion"
    }
    if ($VersionInfo.IsPreRelease) { 'PE 标记为预发行版，不能确认为源码声明的 stable 版本' }
}

$installer = Get-Item -LiteralPath $InstallerPath
if (-not $installer.Exists) { throw "安装包不存在：$InstallerPath" }

$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "文件：$($installer.FullName)"
Write-Host "大小：$([math]::Round($installer.Length / 1MB, 2)) MiB"
Write-Host "SHA-256：$hash"

$failed = $false
$inconclusive = @()
if ($ExpectedSha256) {
    $expected = $ExpectedSha256.ToLowerInvariant()
    if ($hash -ne $expected) {
        Write-Host "❌ 哈希与期望值不一致" -ForegroundColor Red
        Write-Host "   期望：$expected"
        $failed = $true
    }
    else {
        Write-Host "✅ 哈希与期望值一致" -ForegroundColor Green
    }
}
else {
    Write-Host "⚠ 未提供 -ExpectedSha256：哈希已计算，但无法比对" -ForegroundColor Yellow
    $inconclusive += "未提供期望哈希"
}

# 在二进制中检索仓库名。NSIS 安装包内嵌了前端 bundle，字符串以 UTF-8 出现。
$bytes = [IO.File]::ReadAllBytes($installer.FullName)
$text = [Text.Encoding]::UTF8.GetString($bytes)

$currentRepo = 'Tsuki-hash/DeepSeekMonitorWindows'
$legacyRepo = 'Tsuki-hash/DeepSeekMonitorWin/releases'
$hasCurrent = $text.Contains($currentRepo)
$hasLegacy = $text.Contains($legacyRepo)

# 三态结论（复评 F17）：找不到字符串既不能算通过，也不能算失败 —— 它是「无法判定」。
# 复评 R19：这里曾把 $inconclusive 重置为空数组，丢掉前面「未提供期望哈希」等原因。
# 所有原因必须一路保留到最终结论。
if ($hasCurrent) {
    # 复评 R19：命中当前地址只是**辅助证据**，不能单独构成 PASS。
    Write-Host "✅ 二进制包含当前仓库地址：$currentRepo（辅助证据）" -ForegroundColor Green
}
else {
    Write-Host "⚠ 无法判定：二进制中未检索到当前仓库地址。" -ForegroundColor Yellow
    Write-Host "   压缩后的 NSIS 内容可能不以明文 UTF-8 出现；此项不能作为通过证据。"
    Write-Host "   必须安装后手工点一次「检查更新」确认。"
    $inconclusive += "新仓库地址未在二进制中找到"
}
if ($hasLegacy) {
    Write-Host "❌ 二进制仍包含旧仓库地址：$legacyRepo" -ForegroundColor Red
    Write-Host "   旧地址若返回重定向，按旧源码构建的版本会把它当成失败。"
    $failed = $true
}
else {
    # 复评 R19：未发现旧地址是**辅助证据**（压缩包可能不含明文），
    # 不强制把结论降为 INCONCLUSIVE，只记录下来供人工核对。
    Write-Host "✅ 未发现旧仓库地址（辅助证据，仅限明文检索）" -ForegroundColor Green
}

# 文件名仅为辅助证据；版本资源必须另外核对，不能靠改名得到静态 PASS。
$packageVersion = (Get-Content (Join-Path $PSScriptRoot '..' 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "源码声明版本：$packageVersion"
if (Test-ReleaseFileNameVersion -FileName $installer.Name -ExpectedVersion $packageVersion) {
    Write-Host "✅ 文件名包含完整版本 $packageVersion（辅助证据）" -ForegroundColor Green
}
else {
    Write-Host "⚠ 无法判定：文件名未包含完整版本 $packageVersion。" -ForegroundColor Yellow
    Write-Host "   文件名不是 PE 版本信息，不能作为版本与提交对应的证据。"
    $inconclusive += "文件名与版本不匹配"
}

$peVersionIssues = @()
if (-not (Test-PortableExecutableHeader -Bytes $bytes)) {
    $peVersionIssues += '文件缺少有效的 PE 基本结构，无法验证版本资源'
}
else {
    try {
        $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer.FullName)
        Write-Host "PE FileVersion：$($versionInfo.FileVersion)"
        Write-Host "PE 固定 FileVersion：$($versionInfo.FileMajorPart).$($versionInfo.FileMinorPart).$($versionInfo.FileBuildPart).$($versionInfo.FilePrivatePart)"
        Write-Host "PE ProductVersion：$($versionInfo.ProductVersion)"
        $peVersionIssues += @(Get-PeReleaseVersionIssues -VersionInfo $versionInfo -ExpectedVersion $packageVersion)
    }
    catch {
        $peVersionIssues += "无法读取或核对 PE 版本资源：$($_.Exception.Message)"
    }
}
if ($peVersionIssues.Count -gt 0) {
    foreach ($issue in $peVersionIssues) {
        Write-Host "⚠ 无法判定：$issue" -ForegroundColor Yellow
    }
    $inconclusive += $peVersionIssues
}
else {
    Write-Host "✅ PE 文件版本资源与源码声明版本一致（仅限静态元数据）" -ForegroundColor Green
}
Write-Host "版本名与 PE 元数据均不能证明安装包绑定当前提交，也不代表安装/更新验收通过。"

if ($failed) {
    Write-Host "`n结论：FAIL。发现确定的错误，不能放行。" -ForegroundColor Red
    exit 1
}
if ($inconclusive.Count -gt 0) {
    Write-Host "`n结论：INCONCLUSIVE。以下项无法静态判定：" -ForegroundColor Yellow
    foreach ($item in $inconclusive) { Write-Host "  - $item" }
    Write-Host "  必须安装后手工验收：检查更新、托盘、通知、DPI、升级。"
    Write-Host "  本脚本不会把它当成通过。"
    exit 2
}
Write-Host "`n结论：PASS（静态）。仍需安装后手工验收。" -ForegroundColor Green
