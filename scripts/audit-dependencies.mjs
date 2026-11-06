#!/usr/bin/env node
// 依赖安全审计。
//
// 复评 F19：把 `npm audit` 纳入门禁。但它不能直接用 `npm run verify` 调 `npm audit`：
// npm 会把自身的 project-scoped 配置（包括机器级 `.npmrc` 里的 allow-scripts）
// 传给子进程，导致 `EALLOWSCRIPTS` —— 那是环境问题，不是依赖问题。
//
// 复评 R20：原实现把「审计执行失败」和「发现漏洞」混成同一个 `!ok`，
// 于是断网或工具报错会被读成「有可接受漏洞」，反过来也可能把执行失败
// 说成「审计完成、零告警」。这里把结果分成四种明确状态：
//
//   clean    扫描成功且 0 告警
//   findings 扫描成功但有漏洞
//   error    审计本身没跑成功（网络/工具/配置），结论未知
//
// 生产依赖：clean 通过；findings 阻断；error 阻断（不能声称零告警）。
// 开发依赖：clean 通过；findings 只报告；error 只报告但明确标注「未完成审计」。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 用空 user/global config 运行一次 audit，避免继承机器级 npm 配置。 */
function audit(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), "dsm-audit-"));
  // user 与 global 必须指向不同文件：同一路径会被 npm 判为重复加载。
  const userconfig = join(dir, "user.npmrc");
  const globalconfig = join(dir, "global.npmrc");
  writeFileSync(userconfig, "", "utf8");
  writeFileSync(globalconfig, "", "utf8");
  try {
    const result = spawnSync(
      "npm",
      ["audit", "--package-lock-only", "--ignore-scripts", ...extraArgs],
      {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_userconfig: userconfig,
          npm_config_globalconfig: globalconfig,
          // 清掉可能干扰 project-scoped 安装策略的继承值。
          npm_config_allow_scripts: "",
        },
      },
    );
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const code = typeof result.status === "number" ? result.status : 1;

    // npm audit 的退出码语义：0 = 无漏洞；1 = 有漏洞；其他 = 执行失败。
    // 但「其他」也可能被 npm 用作 1，所以还要看输出能否解析出计数。
    const found = /found\s+(\d+)\s+vulnerabilit/.exec(stdout);
    const zero = /found\s+0\s+vulnerabilit/.test(stdout);

    if (zero) {
      return { state: "clean", code, stdout, stderr };
    }
    if (found) {
      return { state: "findings", code, stdout, stderr };
    }
    // 没有任何可解析结论：审计没跑成功（网络、配置、工具错误）。
    return { state: "error", code, stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const print = (label, result) => {
  console.log("");
  console.log(`${label}：${result.state.toUpperCase()}`);
  const body = result.stdout.trim() || result.stderr.trim() || "(无输出)";
  console.log(body);
};

const production = audit(["--omit=dev"]);
print("生产依赖审计（--omit=dev）", production);

let blocking = false;
if (production.state === "clean") {
  console.log("→ 生产依赖 0 告警。");
} else if (production.state === "findings") {
  console.error("→ 生产依赖存在漏洞：正式版不应放行。");
  blocking = true;
} else {
  // 复评 R20：执行失败不能写成「零告警」。
  console.error("→ 生产依赖审计未完成：结论未知，不能声明零告警。");
  blocking = true;
}

const development = audit([]);
print("开发依赖审计", development);
if (development.state === "clean") {
  console.log("→ 开发依赖 0 告警。");
} else if (development.state === "findings") {
  console.log(
    "→ 开发依赖存在漏洞：不阻断门禁（不影响安装版），但应在下次依赖更新时处理。",
  );
} else {
  console.log(
    "→ 开发依赖审计未完成：结论未知，不能据此声明零告警（不影响门禁）。",
  );
}

// 结论行明确写出「本次覆盖范围」，避免被读成整体零告警。
console.log("");
console.log(`覆盖范围：生产=${production.state}，开发=${development.state}。`);
if (blocking) process.exitCode = 1;
