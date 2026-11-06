# 校验**实际安装包**，而不只是源码。
#
# 背景（评审 P2）：v1.3.0 标签中的更新端点仍是旧仓库名，而更新检查禁止重定向；
# 源码已修正，但如果只验证源码就发版，用户手里的 exe 仍可能带着旧地址。
# 这个脚本对最终产物做三件事：
#
# 1. 计算 SHA-256，与发行页附件核对；
# 2. 在二进制里检索更新端点的仓库名（只读，不解包执行）；
# 3. 打印版本信息，便于和 package.json 对照。
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

# 版本号（NSIS 产品名常含版本，但更可靠的是与 package.json 对照）
$packageVersion = (Get-Content (Join-Path $PSScriptRoot '..' 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "源码声明版本：$packageVersion"
if ($installer.Name -match [regex]::Escape($packageVersion)) {
    Write-Host "✅ 文件名包含版本 $packageVersion" -ForegroundColor Green
}
else {
    Write-Host "⚠ 无法判定：文件名未包含版本 $packageVersion。" -ForegroundColor Yellow
    Write-Host "   文件名不是 PE 版本信息，不能作为版本与提交对应的证据。"
    $inconclusive += "文件名与版本不匹配"
}

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
