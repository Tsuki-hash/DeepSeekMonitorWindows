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
      [
        "audit",
        "--json",
        "--package-lock-only",
        "--ignore-scripts",
        ...extraArgs,
      ],
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
    const signal = result.signal ?? null;
    const spawnError = result.error ? String(result.error) : null;

    // 复评 F13：**先看进程状态**，再看文本。旧实现只正则匹配 stdout ——
    // 一个「打印 found 0 vulnerabilities 但退出 42 / 被信号中止 / spawn 出错」
    // 的子进程会被判成 clean，生产门禁静默放行；而 stderr 也因 `print()`
    // 二选一而丢失，诊断无从查起。
    // 现在：
    // 1. 有 spawn 错误 / 信号 / 非 0/1 退出码 → error（结论未知）；
    // 2. 退出码 1 是 npm audit 的**合法**「发现漏洞」结果；
    // 3. 退出码 0 才可能是 clean，且必须文本确认零告警；
    // 4. 无法解析任何结论 → error。
    const toolFailure =
      spawnError != null ||
      signal != null ||
      code === null ||
      (code !== 0 && code !== 1);
    if (toolFailure) {
      return { state: "error", code, stdout, stderr, signal, spawnError };
    }
    // 复评 R15：用 `--json` 的结构化结果分类，而不是靠人类可读摘要。
    // 旧实现把所有 exit 1 判成 findings —— npm 在**网络失败**时也用 exit 1
    //（ECONNREFUSED / 代理错误），于是「审计没跑成功」被写成「发现漏洞」。
    // 现在先解析 JSON：`error` 字段或缺失 metadata 就是工具/网络失败（error）；
    // 只有拿到 `metadata.vulnerabilities` 计数才能谈 findings/clean。
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    const jsonError = parsed?.error
      ? String(parsed.error.summary ?? parsed.error.code ?? parsed.error)
      : null;
    const totals = parsed?.metadata?.vulnerabilities;
    const counted =
      totals && typeof totals.total === "number" ? totals.total : null;
    if (jsonError != null) {
      // 网络/配置/工具错误：结论未知（不是「发现漏洞」）。
      return { state: "error", code, stdout, stderr, signal, spawnError };
    }
    if (counted == null) {
      // 没有 schema 或没有计数：无法判定，按未知处理。
      return { state: "error", code, stdout, stderr, signal, spawnError };
    }
    if (code === 1) {
      // 退出码 1 + 结构化计数：只有计数**非零**才是真漏洞。
      if (counted > 0) {
        return { state: "findings", code, stdout, stderr, signal, spawnError };
      }
      // exit 1 但计数为 0：自相矛盾，不能判 clean 也不能判 findings。
      return { state: "error", code, stdout, stderr, signal, spawnError };
    }
    if (code === 0 && counted === 0) {
      return { state: "clean", code, stdout, stderr, signal, spawnError };
    }
    // exit 0 但计数非零：矛盾，按未知处理。
    return { state: "error", code, stdout, stderr, signal, spawnError };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const print = (label, result) => {
  console.log("");
  console.log(`${label}：${result.state.toUpperCase()}`);
  // 复评 F13：两个流都要保留 —— 成功命令也可能向 stderr 写警告，
  // 失败时的诊断往往只在 stderr。旧实现 stdout 有内容就不输出 stderr。
  if (result.stdout.trim()) console.log(result.stdout.trimEnd());
  if (result.stderr.trim()) {
    console.log("[stderr]");
    console.log(result.stderr.trimEnd());
  }
  if (result.signal) console.log(`[signal] ${result.signal}`);
  if (result.spawnError) console.log(`[spawn error] ${result.spawnError}`);
  console.log(`[exit] ${result.code}`);
  if (!result.stdout.trim() && !result.stderr.trim()) console.log("(无输出)");
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
