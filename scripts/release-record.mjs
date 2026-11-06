#!/usr/bin/env node
// 生成可复核的发版证据记录。
//
// 背景（评审 P2）：README 明确不再启用 Actions，本地 verify 是唯一门禁，但
// pre-push 可以被跳过，运行结果也没有留档。
//
// 与 verify 使用同一份 DeepSeek 门禁清单，逐项记录 PASS/FAIL/NOT RUN。
// Agent 引擎与工具目录探针随功能移除，不执行，也不计作 PASS。
//
// 复评 R13：测试计数正则被模板字符串吃掉了反斜杠，且 Rust 的
// `191 passed; 0 failed; 4 ignored` 与 Node 的 `pass 123` 格式不同。
// 现在分别解析，无法解析时明确写「不可解析」而不是填零。
//
// 复评 R14：成功命令也可能向 stderr 写警告，execFileSync 的成功路径
// 原先固定 stderr 为空。改用 spawnSync 分别捕获两个流。

import { spawnSync } from "node:child_process";
import { hasNotRun, readRustGateLog } from "./run-rust-tests.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * 运行一条命令，始终记录 stdout 与 stderr（复评 R14）。
 *
 * 复评 F12：**只有**确实需要 `.cmd` 包装的命令才启用 shell。
 * 旧实现对每条命令都设 `shell: process.platform === "win32"`，Node 会把
 * args 用空格直接拼成一条 cmd 命令串 —— TEMP 含空格（`C:\Users\Jane Doe\...`）
 * 时，`--log-file C:\Users\Jane Doe\AppData\Local\Temp\...json` 会被拆成两个
 * 参数，子脚本写到错误位置、外层再报门禁日志缺失，合法环境被误阻断。
 * 现在：
 * - `node` 用 `process.execPath` 直接启动，不经 shell；
 * - `git` / `cargo` / `rustc` 直接启动可执行文件；
 * - 只有 npm / npx 这类 `.cmd` 包装脚本走 shell（它们的参数是固定短选项，
 *   不含路径），且路径参数一律走 `node` 直启分支。
 */
const needsShell = (command) => {
  if (process.platform !== "win32") return false;
  return command === "npm" || command === "npx";
};

const resolveCommand = (command) =>
  command === "node" ? process.execPath : command;

const run = (command, commandArgs) => {
  const started = Date.now();
  const result = spawnSync(resolveCommand(command), commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: needsShell(command),
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
    // 复评 F13 的同类要求：进程状态与 spawn 错误必须保留，不能只看 stdout。
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
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

// 复评 Q08：git 成败只按退出码判断 —— 干净 `status --porcelain` 的正确结果
// 就是 exit 0 加空输出，不能把空输出当成失败。要求非空的字段由调用方另行校验。
const git = (...commandArgs) => {
  const result = run("git", commandArgs);
  return {
    value: result.stdout.trim(),
    ok: result.ok,
    code: result.code,
    stderr: result.stderr,
    args: commandArgs,
  };
};

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

// Rust 门禁保留完整结构化证据；缺失或不可解析的日志必须阻断发布。
const rustLogFile = join(
  tmpdir(),
  `dsm-rust-log-${process.pid}-${Date.now()}.json`,
);

/** DeepSeek 门禁清单须与 scripts/verify.ps1 保持一致。 */
const checks = [
  ["版本一致性", "node", ["scripts/check-version.mjs"], true],
  ["前端测试", "npm", ["test"], true],
  ["组件测试", "npm", ["run", "test:components"], true],
  [
    "门禁故障注入测试",
    "node",
    ["--test", "scripts/tests/release-gates.test.mjs"],
    true,
  ],
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
    "node",
    ["scripts/run-rust-tests.mjs", "--log-file", rustLogFile],
    true,
  ],
  ["依赖审计", "node", ["scripts/audit-dependencies.mjs"], true],
];

/** NOT RUN 是独立结论；成功退出也不能掩盖缺失场景。 */
const classify = (label, result) => {
  if (result.error || result.signal) return "ERROR";
  if (label === "cargo test" && result.code === 2) return "NOT RUN";
  if (!result.ok) return "FAIL";
  if (hasNotRun(`${result.stdout}\n${result.stderr}`)) return "NOT RUN";
  return "PASS";
};

const lines = [];
lines.push(`# 发版证据记录 v${version}`);
lines.push("");
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push("");
lines.push("## 提交与工作区");
lines.push("");
const gitFailures = [];
const gitField = (label, ...commandArgs) => {
  const result = git(...commandArgs);
  if (!result.ok) {
    gitFailures.push(label);
    lines.push(
      `- ${label}：UNKNOWN（git ${commandArgs.join(" ")} 退出码 ${result.code}）`,
    );
    lines.push(`  - stderr：${result.stderr.trim() || "(空)"}`);
    return null;
  }
  // 复评 Q08：成功路径必须把元数据显式写进报告，不能只返回值丢掉。
  lines.push(`- ${label}：\`${result.value}\``);
  return result.value;
};
const headSha = gitField("提交", "rev-parse", "HEAD");
gitField("分支", "rev-parse", "--abbrev-ref", "HEAD");
gitField("提交时间", "log", "-1", "--format=%cI");
// 复评 Q08：`status --porcelain` 成功时**空输出才代表干净**；命令失败
// （exit 128 等）输出也是空，必须区分。脏工作区按发布策略直接阻断放行。
const status = git("status", "--porcelain");
if (status.ok) {
  const dirty = status.value !== "";
  lines.push(`- 工作区是否干净：${dirty ? "否（存在未提交改动）" : "是"}`);
  if (dirty) {
    lines.push(`  - 改动：${status.value.split("\n").slice(0, 20).join("；")}`);
    gitFailures.push("工作区存在未提交改动");
  }
} else {
  gitFailures.push("工作区状态");
  lines.push("- 工作区是否干净：UNKNOWN（git status 执行失败）");
  lines.push(`  - stderr：${status.stderr.trim() || "(空)"}`);
}
if (gitFailures.length) {
  lines.push(
    `- ⚠ Git 元数据存在 UNKNOWN 项：本记录不能作为「来自固定干净提交」的证据。`,
  );
}
lines.push("");
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
// 复评 Q08：Git 元数据 UNKNOWN 属于证据链失败，并入总失败清单阻断放行。
failures.push(...gitFailures);
const notRun = [];
const checkResults = [];
lines.push("| 门禁 | 结论 | 退出码 | 用时 | 测试计数 |");
lines.push("| - | - | - | - | - |");
for (const [label, command, commandArgs] of checks) {
  const result = run(command, commandArgs);
  const rustLog =
    label === "cargo test" ? readRustGateLog(rustLogFile, result.code) : null;
  const verdict =
    label === "cargo test"
      ? (rustLog?.verdict ?? "ERROR")
      : classify(label, result);
  checkResults.push({ label, command, commandArgs, result, verdict });
  if (verdict === "FAIL" || verdict === "ERROR") failures.push(label);
  if (verdict === "NOT RUN") notRun.push(label);
  const unknownCounts = {
    passed: null,
    failed: null,
    ignored: null,
    tests: null,
    parseable: false,
  };
  const counts =
    label === "cargo test"
      ? (rustLog?.rust.counts ?? unknownCounts)
      : verdict === "NOT RUN"
        ? unknownCounts
        : testCounts(`${result.stdout}\n${result.stderr}`);
  lines.push(
    `| ${label} | ${verdict} | ${result.code} | ${result.seconds.toFixed(1)}s | ${formatCounts(counts)} |`,
  );
}

lines.push("");
lines.push(
  `门禁汇总：${["PASS", "FAIL", "NOT RUN", "ERROR"].map((verdict) => `${verdict}=${checkResults.filter((item) => item.verdict === verdict).length}`).join("；")}。NOT RUN 不计通过。`,
);

lines.push("");
lines.push("### 完整输出");
lines.push("");
lines.push("> 审计需要原始 stdout/stderr，不截断；成功命令的 stderr 也保留。");
lines.push("");
for (const { label, command, commandArgs, result, verdict } of checkResults) {
  lines.push(
    `<details><summary>${label} — ${verdict}（退出码 ${result.code}）</summary>`,
  );
  lines.push("");
  lines.push("```text");
  // 复评 T09：command/commandArgs 在外层解构对象上，不在 result 里；
  // 记录必须能重建真实调用（可重放）。
  lines.push(`[command] ${command} ${commandArgs.join(" ")}（cwd: ${root}）`);
  lines.push((result.stdout || "(stdout 为空)").trim());
  lines.push("");
  lines.push("[stderr]");
  lines.push(result.stderr.trim() || "(stderr 为空)");
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
}

// 复评 Q08：记录生成**结束**时的源状态也要落盘并与开头核对 ——
// 提交变化或出现新改动，这条记录就不能再绑定到开头记录的固定提交。
lines.push("## 记录生成结束时的源状态");
lines.push("");
const tailSha = git("rev-parse", "HEAD");
const tailStatus = git("status", "--porcelain");
if (!tailSha.ok) {
  failures.push("结束时的提交状态");
  lines.push(`- 提交：UNKNOWN（git rev-parse HEAD 退出码 ${tailSha.code}）`);
  lines.push(`  - stderr：${tailSha.stderr.trim() || "(空)"}`);
} else {
  lines.push(`- 提交：\`${tailSha.value}\``);
  if (headSha && tailSha.value !== headSha) {
    failures.push("记录期间提交发生变化");
    lines.push(`  - ⚠ 与开头记录的提交 ${headSha} 不一致。`);
  } else if (!headSha) {
    failures.push("结束时的提交状态");
    lines.push("  - ⚠ 开头未能记录提交，无法核对是否变化。");
  }
}
if (!tailStatus.ok) {
  failures.push("结束时的工作区状态");
  lines.push(`- 工作区：UNKNOWN（git status 退出码 ${tailStatus.code}）`);
} else if (tailStatus.value !== "") {
  failures.push("记录结束时存在未提交改动");
  lines.push("- 工作区：否（记录结束时出现未提交改动）");
} else {
  lines.push("- 工作区：是");
}
lines.push("");

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
lines.push("## 验收范围");
lines.push("");
lines.push(
  "- 本次范围仅含 DeepSeek 账户余额、消费与用量、历史、提醒及桌面集成。",
);
lines.push(
  "- 多工具 Agent 统计已移除：引擎集成、WSL/SQLite 工具扫描与目录链接能力探针不再执行，不计为 PASS 或 NOT RUN。",
);
lines.push("");
lines.push("## 未覆盖项（需真机验收）");
lines.push("");
lines.push(
  "- Windows 安装升级、托盘交互、全局快捷键、通知可见性、WebView2 行为、DPI/文本缩放、升级后旧数据保留、真实安装包内的检查更新。",
);
lines.push(
  "- 本次未做 CPU/内存/启动耗时采样，性能结论只基于代码结构，不含实测数值。",
);

lines.push("");
lines.push("## 结论");
lines.push("");
if (failures.length) {
  lines.push(
    `❌ FAIL：${failures.join("、")} 失败或证据不可用。本次记录不能作为放行证据。`,
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
// 只删除本次运行自己创建的临时门禁日志，不涉及用户配置、缓存或历史。
try {
  if (existsSync(rustLogFile)) rmSync(rustLogFile, { force: true });
} catch {
  /* 清理失败不影响结论 */
}

// 失败必须传播到退出码；NOT RUN 在发版语境下同样不放行。
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
} else if (notRun.length) {
  console.error(`未运行项（发版不放行）：${notRun.join("、")}`);
  process.exitCode = 2;
}
