# 本地一键验证（替代已取消的 GitHub CI）。
# 用法：pwsh -File scripts/verify.ps1
# 需要：PowerShell 7+（pwsh）、Node 22.6+、Rust 1.88+ MSVC 工具链。
# Windows PowerShell 5.1 不支持本脚本的调用方式，请安装 PowerShell 7。

# 统一输出编码，避免中文在非 UTF-8 控制台里乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# PowerShell 7 默认不把原生命令的非零退出码转为终止错误。
function Invoke-Check {
    param([string]$Title, [string]$Executable, [string[]]$Arguments)
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title 失败（退出码 $LASTEXITCODE）"
    }
}

Invoke-Check '版本一致性' 'node' @('scripts/check-version.mjs')

Invoke-Check '前端测试' 'npm' @('test')

Invoke-Check '前端 lint' 'npm' @('run', 'lint')

Invoke-Check '前端 format 检查' 'npx' @('prettier', '--check', '.')

Invoke-Check '前端构建' 'npm' @('run', 'build')

Invoke-Check 'cargo fmt' 'cargo' @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check')

Invoke-Check 'cargo clippy' 'cargo' @('clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings')

Invoke-Check 'cargo test' 'cargo' @('test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib')

# 复评 F20：ignored 集成测试默认不跑，不能把「跳过」当成「通过」。
# 退出码约定：0=通过，2=未运行（缺合成目录），其他=失败。
# 「未运行」不阻断普通开发门禁，但会打印明确警告，且发版记录会据此判定证据不足。
Write-Host '==> 引擎集成测试（显式 ignored）' -ForegroundColor Cyan
& node @('scripts/run-integration-tests.mjs')
$integrationExit = $LASTEXITCODE
if ($integrationExit -eq 0) {
    Write-Host '集成测试通过。' -ForegroundColor Green
}
elseif ($integrationExit -eq 2) {
    Write-Host '集成测试未运行：缺少 DSM_TEST_LOCAL_USAGE_HOME 合成目录。' -ForegroundColor Yellow
    Write-Host '   本次门禁不包含引擎集成证据；发版前必须补齐，不能记为通过。' -ForegroundColor Yellow
}
else {
    throw "引擎集成测试失败（退出码 $integrationExit）"
}

# 复评 F19：依赖告警纳入门禁（开发依赖曾出现 high）。
# 用独立的空 userconfig 隔离开发者个人 .npmrc：某些机器的全局 allow-scripts
# 设置会让 project-scoped audit 直接报 EALLOWSCRIPTS，那是环境问题而不是项目缺陷。
$auditConfig = Join-Path ([IO.Path]::GetTempPath()) 'dsm-audit-empty.npmrc'
if (-not (Test-Path $auditConfig)) { New-Item -ItemType File -Path $auditConfig | Out-Null }
Invoke-Check '生产依赖安全审计' 'npm' @('audit', '--package-lock-only', '--ignore-scripts', '--omit=dev', "--userconfig=$auditConfig")

Write-Host '全部通过。' -ForegroundColor Green
