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

# 复评 F20/T02：ignored 集成测试默认不跑，不能把「跳过」当成「通过」。
# 集成入口退出码：0=全部执行且通过，1=有用例失败，2=存在 NOT RUN，
# 3=配置或 fixture 错误，4=工具执行错误（结论未知）。
# NOT RUN 不阻断普通开发门禁，但最终结论必须是「不完整」，不得使用「全部通过」。
Write-Host '==> 引擎集成测试（显式 ignored）' -ForegroundColor Cyan
& node @('scripts/run-integration-tests.mjs')
$integrationExit = $LASTEXITCODE
$gateIncomplete = $false
if ($integrationExit -eq 0) {
    Write-Host '集成测试通过。' -ForegroundColor Green
}
elseif ($integrationExit -eq 2) {
    Write-Host '集成测试未完整运行：存在 NOT RUN 项。' -ForegroundColor Yellow
    Write-Host '   本次门禁不包含完整引擎集成证据；发版前必须补齐，不能记为通过。' -ForegroundColor Yellow
    $gateIncomplete = $true
}
elseif ($integrationExit -eq 3) {
    throw '集成测试配置或 fixture 错误（退出码 3）：请先修正 fixture，不能当作产品失败或通过。'
}
elseif ($integrationExit -eq 4) {
    throw '集成测试工具执行错误（退出码 4）：结论未知，不能当作通过。'
}
else {
    throw "引擎集成测试失败（退出码 $integrationExit）"
}

# 复评 F19：依赖告警纳入门禁（开发依赖曾出现 high）。
# 由独立脚本执行：npm 会把 project-scoped 配置传给子进程，机器级 allow-scripts
# 会让 `npm audit` 报 EALLOWSCRIPTS（环境问题，不是依赖问题）。
Invoke-Check '生产依赖安全审计' 'node' @('scripts/audit-dependencies.mjs')

# 复评 T02：有 NOT RUN 时最终措辞必须是「不完整」，
# 不得让「全部通过」盖过缺失的集成证据。
if ($gateIncomplete) {
    Write-Host '门禁通过但不完整：存在 NOT RUN 的集成用例（详见上方黄色提示）。' -ForegroundColor Yellow
} else {
    Write-Host '全部通过。' -ForegroundColor Green
}
