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
 * 参数，子脚本写到错误位置、外层再报集成日志缺失，合法环境被误阻断。
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

// 复评 T09：集成子用例的底层日志文件（集成入口写入，随后嵌入本记录）。
// 没有它，外层只能看到汇总表，无法核验每个用例是否真的执行。
const integrationLogFile = join(
  tmpdir(),
  `dsm-integration-log-${process.pid}-${Date.now()}.json`,
);

/**
 * 唯一门禁清单：与 `scripts/verify.ps1` 保持一致（复评 R12）。
 *
 * `releaseCritical: true` 表示发版必须真实执行并通过；`NOT RUN` 不放行。
 */
/**
 * 复评 Q09：从集成入口的结构化日志合计测试计数。
 *
 * 集成 stdout 含四条 `test result:` 行（每子用例一条），
 * `testCounts` 的 exec 只取首个匹配会得到 tests=1、首过后败时 failed=0。
 * 这里按子用例 verdict 分别累计：PASS 计 passed，FAIL 计 failed，
 * NOT RUN / ERROR 不计入执行数（它们确实没跑或结论未知）。
 */
let integrationResults = [];
let integrationPreflight = [];
let integrationLoaded = false;
/** 复评 Q09/第五轮：加载结构化集成日志（preflight + 逐用例 verdict）；失败返回 false。 */
function loadIntegrationResults() {
  if (integrationLoaded) return true;
  if (!existsSync(integrationLogFile)) return false;
  try {
    const parsed = JSON.parse(readFileSync(integrationLogFile, "utf8"));
    integrationResults = Array.isArray(parsed.results) ? parsed.results : [];
    integrationPreflight = Array.isArray(parsed.preflight)
      ? parsed.preflight
      : [];
    integrationLoaded = true;
    return true;
  } catch {
    return false;
  }
}
const integrationCounts = () => {
  const totals = { passed: 0, failed: 0, ignored: 0, tests: 0 };
  let known = false;
  for (const item of integrationResults) {
    if (item.verdict === "PASS" || item.verdict === "FAIL") {
      known = true;
      const counts = testCounts(`${item.stdout ?? ""}\n${item.stderr ?? ""}`);
      totals.passed += counts.passed ?? 0;
      totals.failed += counts.failed ?? 0;
      totals.ignored += counts.ignored ?? 0;
      totals.tests += counts.tests ?? counts.passed ?? 0;
    }
    // NOT RUN / ERROR：没有可合计的执行数，但结论本身是明确的
    // （覆盖不足或工具失败），整体仍按「已知」处理而不是解析失败。
    if (item.verdict === "NOT RUN" || item.verdict === "ERROR") known = true;
  }
  if (!known) return { ...totals, parseable: false };
  return { ...totals, parseable: true };
};

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
  // 复评 T09：把集成入口自己的逐用例日志落盘，再嵌入发布记录，
  // 否则外层只能看到汇总表，无法核验每个用例是否真的执行。
  [
    "引擎集成测试",
    "node",
    ["scripts/run-integration-tests.mjs", "--log-file", integrationLogFile],
    true,
  ],
  ["依赖审计", "node", ["scripts/audit-dependencies.mjs"], true],
];

/** 集成测试的「未运行」是退出码 2，与失败(1)语义不同。 */
const classify = (label, result) => {
  if (result.ok) return "PASS";
  if (label.includes("集成") && result.code === 2) return "NOT RUN";
  return "FAIL";
};

/**
 * 复评 T14：Rust 测试用 `eprintln!("NOT RUN: ...")` 表达「能力缺失未执行」，
 * libtest 仍记 PASS。发行门禁必须**扫描输出里的 NOT RUN 行**并阻断，
 * 不能只看退出码。
 */
const notRunMarkers = (text) =>
  (String(text).match(/NOT RUN[：:]/g) ?? []).length;

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
  const verdict = classify(label, result);
  checkResults.push({ label, command, commandArgs, result, verdict });
  if (verdict === "FAIL") failures.push(label);
  if (verdict === "NOT RUN") notRun.push(label);
  // 复评 T14：测试输出里出现 `NOT RUN:` 行 → 该项记为未完整执行（发版阻断）。
  const markers = notRunMarkers(`${result.stdout}\n${result.stderr}`);
  if (markers > 0) {
    notRun.push(`${label}（${markers} 个场景 NOT RUN）`);
  }
  // 复评 Q09：集成入口的 stdout 含多条 `test result:` 行（每子用例一条），
  // exec 只取首个会得到 tests=1。集成项改用结构化子用例日志合计。
  // 集成检查在本轮循环中刚跑完并写出日志，这里正是读取时机；
  // 日志缺失时按「不可解析」呈现，证据链失败在循环后统一并入 failures。
  const counts = label.includes("集成")
    ? loadIntegrationResults()
      ? integrationCounts()
      : { passed: 0, failed: 0, ignored: 0, tests: 0, parseable: false }
    : testCounts(`${result.stdout}\n${result.stderr}`);
  lines.push(
    `| ${label} | ${verdict} | ${result.code} | ${result.seconds.toFixed(1)}s | ${formatCounts(counts)} |`,
  );
}

// 复评 Q09：集成检查执行过，但结构化日志丢失/不可解析，属于证据链失败，
// 必须阻断放行 —— 否则「子用例是否真实执行」无法核验。
if (
  checkResults.some((item) => item.label === "引擎集成测试") &&
  !loadIntegrationResults()
) {
  failures.push("引擎集成子用例日志");
}
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

// 复评 T09/第五轮 Q09：把集成前置调用与逐用例日志嵌入发布记录 ——
// PASS/FAIL/NOT RUN/ERROR 都可核验执行数与真实命令；嵌入失败必须阻断
// （failures 已在门禁循环后并入，这里只负责正文自洽）。
if (loadIntegrationResults()) {
  lines.push("## 引擎集成子用例日志");
  lines.push("");
  for (const item of integrationResults) {
    lines.push(
      `<details><summary>${item.fullName} — ${item.verdict ?? "无结论"}${
        item.code != null ? `（退出码 ${item.code}）` : ""
      }</summary>`,
    );
    lines.push("");
    lines.push("```text");
    lines.push(
      `[command] ${item.command ?? "(未运行)"} ${(item.args ?? []).join(" ")}`,
    );
    lines.push((item.stdout || "(stdout 为空)").trim());
    lines.push("");
    lines.push("[stderr]");
    lines.push((item.stderr || "(stderr 为空)").trim());
    if (item.error) {
      lines.push("");
      lines.push(`[spawn error] ${item.error.name}: ${item.error.message}`);
    }
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (integrationPreflight.length) {
    lines.push("### 集成前置调用（探针/枚举）");
    lines.push("");
    for (const item of integrationPreflight) {
      lines.push(
        `<details><summary>${item.fullName ?? "(未命名)"}（退出码 ${item.code}）</summary>`,
      );
      lines.push("");
      lines.push("```text");
      lines.push(
        `[command] ${item.command} ${(item.args ?? []).join(" ")}（cwd: ${item.cwd ?? "未记录"}）`,
      );
      lines.push((item.stdout || "(stdout 为空)").trim());
      lines.push("");
      lines.push("[stderr]");
      lines.push((item.stderr || "(stderr 为空)").trim());
      if (item.error) {
        lines.push("");
        lines.push(`[spawn error] ${item.error.name}: ${item.error.message}`);
      }
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }
} else if (checkResults.some((item) => item.label === "引擎集成测试")) {
  lines.push("## 引擎集成子用例日志");
  lines.push("");
  lines.push("⚠ 集成日志丢失或不可解析：无法核验子用例是否真实执行。");
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
// 复评 T09：临时集成日志用完即删，清理失败不影响结论。
try {
  if (existsSync(integrationLogFile)) {
    rmSync(integrationLogFile, { force: true });
  }
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
