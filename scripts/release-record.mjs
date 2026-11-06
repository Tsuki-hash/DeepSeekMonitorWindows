#!/usr/bin/env node
// 生成可复核的发版证据记录。
//
// 背景（评审 P2）：README 明确不再启用 Actions，本地 verify 是唯一门禁，但
// pre-push 可以被跳过，运行结果也没有留档。
//
// 复评 R12：记录只跑普通 cargo test，没有集成与依赖审计，于是「门禁全部通过」
// 与 verify 实际覆盖不一致。这里改为复用**同一份门禁清单**，逐项记录
// PASS/FAIL/NOT RUN，并在发布阶段要求没有 NOT RUN。
//
// 复评 R13：测试计数正则被模板字符串吃掉了反斜杠，且 Rust 的
// `191 passed; 0 failed; 4 ignored` 与 Node 的 `pass 123` 格式不同。
// 现在分别解析，无法解析时明确写「不可解析」而不是填零。
//
// 复评 R14：成功命令也可能向 stderr 写警告，execFileSync 的成功路径
// 原先固定 stderr 为空。改用 spawnSync 分别捕获两个流。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const out = option("out");
const installer = option("installer");

/** 运行一条命令，始终记录 stdout 与 stderr（复评 R14）。 */
const run = (command, commandArgs) => {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    // Windows 上 npm/npx 是 .cmd 包装脚本，需要 shell 解析。
    shell: process.platform === "win32",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    code: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout ?? ""),
    // 成功路径同样保留 stderr：编译警告与诊断都在这里。
    stderr:
      String(result.stderr ?? "") + (result.error ? String(result.error) : ""),
    seconds: (Date.now() - started) / 1000,
  };
};

/**
 * 解析测试计数（复评 R13）。
 *
 * - Node test runner：`# pass 145` / `ℹ pass 145`
 * - Rust libtest：`test result: ok. 191 passed; 0 failed; 4 ignored; ...`
 *
 * 两种格式各用一个**字面量**正则，无法解析时返回 null 并在报告里写「不可解析」。
 */
const testCounts = (text) => {
  const node = {
    passed: /^\W*pass\s+(\d+)/m,
    failed: /^\W*fail\s+(\d+)/m,
    ignored: /^\W*skipped\s+(\d+)/m,
    tests: /^\W*tests\s+(\d+)/m,
  };
  const rust = {
    passed: /(\d+)\s+passed/,
    failed: /(\d+)\s+failed/,
    ignored: /(\d+)\s+ignored/,
    tests: null,
  };
  const pick = (patterns) => {
    for (const pattern of Object.values(patterns)) {
      if (!pattern) continue;
      const match = pattern.exec(text);
      if (match) return Number(match[1]);
    }
    return null;
  };
  const values = {
    passed: pick({ node: node.passed, rust: rust.passed }),
    failed: pick({ node: node.failed, rust: rust.failed }),
    ignored: pick({ node: node.ignored, rust: rust.ignored }),
    tests: pick({ node: node.tests }),
  };
  // Rust 没有 tests 总数行，可由 passed+failed+ignored 推出。
  if (values.tests == null) {
    const parts = [values.passed, values.failed, values.ignored];
    values.tests = parts.every((value) => value != null)
      ? parts.reduce((sum, value) => sum + value, 0)
      : null;
  }
  const parseable = Object.values(values).every((value) => value != null);
  return { ...values, parseable };
};

const formatCounts = (counts) => {
  if (!counts.parseable) return "不可解析（原始输出见下）";
  return `tests=${counts.tests} pass=${counts.passed} fail=${counts.failed} ignored=${counts.ignored}`;
};

const git = (...commandArgs) => run("git", commandArgs).stdout.trim();

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

/**
 * 唯一门禁清单：与 `scripts/verify.ps1` 保持一致（复评 R12）。
 *
 * `releaseCritical: true` 表示发版必须真实执行并通过；`NOT RUN` 不放行。
 */
const checks = [
  ["版本一致性", "node", ["scripts/check-version.mjs"], true],
  ["前端测试", "npm", ["test"], true],
  ["前端 lint", "npm", ["run", "lint"], true],
  ["前端 format 检查", "npx", ["prettier", "--check", "."], true],
  ["前端构建", "npm", ["run", "build"], true],
  [
    "cargo fmt",
    "cargo",
    ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
    true,
  ],
  [
    "cargo clippy",
    "cargo",
    [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    true,
  ],
  [
    "cargo test",
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"],
    true,
  ],
  // 复评 R12：集成与依赖审计也必须进入记录，否则发布结论覆盖不全。
  ["引擎集成测试", "node", ["scripts/run-integration-tests.mjs"], true],
  ["依赖审计", "node", ["scripts/audit-dependencies.mjs"], true],
];

/** 集成测试的「未运行」是退出码 2，与失败(1)语义不同。 */
const classify = (label, result) => {
  if (result.ok) return "PASS";
  if (label.includes("集成") && result.code === 2) return "NOT RUN";
  return "FAIL";
};

const lines = [];
lines.push(`# 发版证据记录 v${version}`);
lines.push("");
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push("");
lines.push("## 提交与工作区");
lines.push("");
lines.push(`- 提交：\`${git("rev-parse", "HEAD")}\``);
lines.push(`- 分支：\`${git("rev-parse", "--abbrev-ref", "HEAD")}\``);
lines.push(`- 提交时间：${git("log", "-1", "--format=%cI")}`);
lines.push(
  `- 工作区是否干净：${git("status", "--porcelain") === "" ? "是" : "否（存在未提交改动）"}`,
);
lines.push("");

lines.push("## 工具链");
lines.push("");
for (const [label, command, commandArgs] of [
  ["Node", "node", ["--version"]],
  ["npm", "npm", ["--version"]],
  ["Rust", "cargo", ["--version"]],
  ["rustc", "rustc", ["--version"]],
]) {
  lines.push(`- ${label}：\`${run(command, commandArgs).stdout.trim()}\``);
}
lines.push("");

lines.push("## 锁文件摘要");
lines.push("");
for (const file of ["package-lock.json", "src-tauri/Cargo.lock"]) {
  try {
    lines.push(`- \`${file}\` SHA-256：\`${sha256(join(root, file))}\``);
  } catch {
    lines.push(`- \`${file}\`：未找到`);
  }
}
lines.push("");

lines.push("## 门禁命令与结果");
lines.push("");
lines.push("> 与 `scripts/verify.ps1` 使用同一份清单；结果记录的是本次运行。");
lines.push("");
const failures = [];
const notRun = [];
const checkResults = [];
lines.push("| 门禁 | 结论 | 退出码 | 用时 | 测试计数 |");
lines.push("| - | - | - | - | - |");
for (const [label, command, commandArgs] of checks) {
  const result = run(command, commandArgs);
  const verdict = classify(label, result);
  checkResults.push({ label, command, commandArgs, result, verdict });
  if (verdict === "FAIL") failures.push(label);
  if (verdict === "NOT RUN") notRun.push(label);
  const counts = testCounts(`${result.stdout}\n${result.stderr}`);
  lines.push(
    `| ${label} | ${verdict} | ${result.code} | ${result.seconds.toFixed(1)}s | ${formatCounts(counts)} |`,
  );
}
lines.push("");
lines.push("### 完整输出");
lines.push("");
lines.push("> 审计需要原始 stdout/stderr，不截断；成功命令的 stderr 也保留。");
lines.push("");
for (const { label, result, verdict } of checkResults) {
  lines.push(
    `<details><summary>${label} — ${verdict}（退出码 ${result.code}）</summary>`,
  );
  lines.push("");
  lines.push("```text");
  lines.push(`[command] ${result.command ?? ""}`);
  lines.push((result.stdout || "(stdout 为空)").trim());
  lines.push("");
  lines.push("[stderr]");
  lines.push(result.stderr.trim() || "(stderr 为空)");
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
}

lines.push("## 安装包");
lines.push("");
let installerStatus = "missing";
if (installer) {
  try {
    const path = resolve(installer);
    lines.push(`- 文件：\`${path}\``);
    lines.push(`- SHA-256：\`${sha256(path)}\``);
    installerStatus = "hashed";
  } catch (error) {
    lines.push(`- ❌ 读取失败：${error.message}`);
    installerStatus = "failed";
    failures.push("安装包读取");
  }
} else {
  lines.push(
    "- ⚠ 未提供 `--installer`：本次**未**记录安装包哈希，不能作为「安装包已验收」的证据。",
  );
}
lines.push("");
lines.push("## 未覆盖项（需真机验收）");
lines.push("");
lines.push(
  "- Windows 安装升级、托盘交互、全局快捷键、通知可见性、WebView2 行为、DPI/文本缩放、WSL 与 SQLite 竞争、真实安装包内的检查更新。",
);
lines.push(
  "- 本次未做 CPU/内存/启动耗时采样，性能结论只基于代码结构，不含实测数值。",
);

lines.push("");
lines.push("## 结论");
lines.push("");
if (failures.length) {
  lines.push(
    `❌ FAIL：${failures.join("、")} 失败。本次记录不能作为放行证据。`,
  );
} else if (notRun.length) {
  lines.push(
    `⚠ 发布不放行：${notRun.join("、")} 为 NOT RUN。开发门禁可接受，发版不可。`,
  );
} else if (installerStatus !== "hashed") {
  lines.push(
    "⚠ 门禁命令全部通过，但安装包未校验：只能作为「源码门禁」证据，不是完整发版证据。",
  );
} else {
  lines.push("✅ 门禁全部 PASS 且记录了安装包哈希；仍需真机与安装升级验收。");
}

const text = lines.join("\n") + "\n";
if (out) {
  writeFileSync(resolve(out), text, "utf8");
  console.log(resolve(out));
} else {
  console.log(text);
}
// 失败必须传播到退出码；NOT RUN 在发版语境下同样不放行。
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
} else if (notRun.length) {
  console.error(`未运行项（发版不放行）：${notRun.join("、")}`);
  process.exitCode = 2;
}
