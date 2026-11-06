#!/usr/bin/env node
// 生产依赖安全审计。
//
// 复评 F19：把 `npm audit` 纳入门禁。但它不能直接用 `npm run verify` 调 `npm audit`：
// npm 会把自身的 project-scoped 配置（包括机器级 `.npmrc` 里的 allow-scripts）
// 传给子进程，导致 `EALLOWSCRIPTS` —— 那是环境问题，不是依赖问题。
//
// 这里用干净的 userconfig 环境直接执行，只依赖锁文件：
//   - 生产依赖（--omit=dev）必须 0 告警，否则退出码 1；
//   - 开发依赖只报告计数，不阻断（构建期工具链告警不等于安装版风险）。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 用空 userconfig 运行一次 audit，避免继承机器级 npm 配置。 */
function audit(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), "dsm-audit-"));
  // user 与 global 必须指向不同文件：同一个路径会被 npm 判为重复加载。
  const userconfig = join(dir, "user.npmrc");
  const globalconfig = join(dir, "global.npmrc");
  writeFileSync(userconfig, "", "utf8");
  writeFileSync(globalconfig, "", "utf8");
  try {
    const output = execFileSync(
      "npm",
      ["audit", "--package-lock-only", "--ignore-scripts", ...extraArgs],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: {
          ...process.env,
          npm_config_userconfig: userconfig,
          // 清掉可能干扰 project-scoped 安装策略的继承值。
          npm_config_allow_scripts: "",
          npm_config_globalconfig: globalconfig,
        },
      },
    );
    return { ok: true, code: 0, output: String(output) };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === "number" ? error.status : 1,
      output: `${error.stdout ?? ""}\n${error.stderr ?? error.message ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const production = audit(["--omit=dev"]);
console.log("生产依赖审计（--omit=dev）：");
console.log(production.output.trim() || "(无输出)");

if (!production.ok) {
  console.error("生产依赖存在告警：正式版不应放行。");
  process.exitCode = 1;
} else {
  const development = audit([]);
  const summary = (development.output.match(/found [^\n]+/g) ?? []).pop();
  console.log("");
  console.log(`开发依赖审计：${summary ?? "(无输出)"}`);
  if (!development.ok) {
    console.log(
      "开发依赖告警不阻断门禁，但应在下次依赖更新时处理（不影响安装版）。",
    );
  }
  console.log("生产依赖 0 告警。");
}
