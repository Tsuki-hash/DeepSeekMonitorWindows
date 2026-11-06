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

# 在二进制中检索仓库名。NSIS 安装包内嵌了前端 bundle，字符串以 UTF-8 出现。
$bytes = [IO.File]::ReadAllBytes($installer.FullName)
$text = [Text.Encoding]::UTF8.GetString($bytes)

$currentRepo = 'Tsuki-hash/DeepSeekMonitorWindows'
$legacyRepo = 'Tsuki-hash/DeepSeekMonitorWin/releases'
$hasCurrent = $text.Contains($currentRepo)
$hasLegacy = $text.Contains($legacyRepo)

if ($hasCurrent) {
    Write-Host "✅ 二进制包含当前仓库地址：$currentRepo" -ForegroundColor Green
}
else {
    Write-Host "⚠ 二进制中未检索到当前仓库地址：$currentRepo" -ForegroundColor Yellow
    Write-Host "   可能是压缩/编码方式不同；请在安装后手工点一次「检查更新」确认。"
}
if ($hasLegacy) {
    Write-Host "❌ 二进制仍包含旧仓库地址：$legacyRepo" -ForegroundColor Red
    Write-Host "   旧地址若返回重定向，按旧源码构建的版本会把它当成失败。"
    $failed = $true
}
else {
    Write-Host "✅ 未发现旧仓库地址" -ForegroundColor Green
}

# 版本号（NSIS 产品名常含版本，但更可靠的是与 package.json 对照）
$packageVersion = (Get-Content (Join-Path $PSScriptRoot '..' 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "源码声明版本：$packageVersion"
if ($installer.Name -match [regex]::Escape($packageVersion)) {
    Write-Host "✅ 文件名包含版本 $packageVersion" -ForegroundColor Green
}
else {
    Write-Host "⚠ 文件名未包含版本 $packageVersion，请人工确认产物与标签对应" -ForegroundColor Yellow
}

if ($failed) {
    Write-Host "`n静态校验未通过。" -ForegroundColor Red
    exit 1
}
Write-Host "`n静态校验通过。仍需安装后手工验收：检查更新、托盘、通知、DPI。" -ForegroundColor Green
