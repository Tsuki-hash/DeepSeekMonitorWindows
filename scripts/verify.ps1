# 本地一键验证（替代已取消的 GitHub CI）。
# 用法：pwsh -File scripts/verify.ps1
# 这是 Windows 发布源码门禁；非 Windows 可运行开发检查，但最终必须 NOT RUN。
# 需要：PowerShell 7+（pwsh）、Node 22.13+（仅22.x）或 Node 24+、Rust 1.88+ MSVC 工具链。
# Windows PowerShell 5.1 不支持本脚本的调用方式，请安装 PowerShell 7。

# 统一输出编码，避免中文在非 UTF-8 控制台里乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# PowerShell 7 默认不把原生命令的非零退出码转为终止错误。
function Invoke-Check {
    param([string]$Title, [string]$Executable, [string[]]$Arguments, [switch]$ScenarioGate)
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Executable @Arguments
    if ($ScenarioGate -and $LASTEXITCODE -eq 2) {
        Write-Host "门禁不完整：$Title 存在 NOT RUN 必需场景，不能记为通过。" -ForegroundColor Yellow
        exit 2
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$Title 失败（退出码 $LASTEXITCODE）"
    }
}

Invoke-Check '版本一致性' 'node' @('scripts/check-version.mjs')

Invoke-Check '前端测试' 'npm' @('test')

Invoke-Check '组件测试' 'npm' @('run', 'test:components')

Invoke-Check '门禁故障注入测试' 'node' @('--test', 'scripts/tests/release-gates.test.mjs')

Invoke-Check '前端 lint' 'npm' @('run', 'lint')

Invoke-Check '前端 format 检查' 'npx' @('prettier', '--check', '.')

Invoke-Check '前端构建' 'npm' @('run', 'build')

Invoke-Check 'cargo fmt' 'cargo' @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check')

Invoke-Check 'cargo clippy' 'cargo' @('clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings')

# 与发行记录共用 Windows 平台与必需测试清单、逐项完成行及真实执行数。
# 非 Windows 即使 cargo 成功也返回 2 / NOT RUN，不得降级为绿色通过。
Invoke-Check 'cargo test' 'node' @('scripts/run-rust-tests.mjs') -ScenarioGate

# Agent 统计已移除：引擎集成和工具目录链接探针不再属于产品验收范围，
# 不执行它们，也不把已移除的场景计为 PASS。
Write-Host '已移除的 Agent 引擎集成与工具目录探针不计入本次门禁。' -ForegroundColor Cyan

# 复评 F19：依赖告警纳入门禁（开发依赖曾出现 high）。
# 由独立脚本执行：npm 会把 project-scoped 配置传给子进程，机器级 allow-scripts
# 会让 `npm audit` 报 EALLOWSCRIPTS（环境问题，不是依赖问题）。
Invoke-Check '生产依赖安全审计' 'node' @('scripts/audit-dependencies.mjs')

Write-Host 'Windows DeepSeek 源码门禁全部通过；安装升级与真机使用仍需验收。' -ForegroundColor Green
