#!/usr/bin/env node
// 生成可复核的发版证据记录。
//
// 背景（评审 P2）：README 明确不再启用 Actions，本地 verify 是唯一门禁，但
// pre-push 可以被跳过，运行结果也没有留档。发版时如果只贴一句「本地测试通过」，
// 事后无法核对到底跑了什么、在哪个提交、用什么工具链。
//
// 这个脚本只做三件不产生副作用的事：
// 1. 记录提交 SHA、分支、工具链版本、锁文件摘要；
// 2. 记录 verify 相关命令与它们的结果（由调用方传入或重新运行）；
// 3. 若给出安装包路径，记录其 SHA-256。
//
// 用法：
//   node scripts/release-record.mjs --out release-record.md
//   node scripts/release-record.mjs --out release-record.md --installer <exe>
//
// 输出是 Markdown，可直接贴进 release notes 或保留在本地存档。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

const run = (command, commandArgs) => {
  const started = Date.now();
  try {
    const stdout = execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上 npm/npx 是 .cmd 包装脚本，不通过 shell 解析会 ENOENT。
      shell: process.platform === "win32",
    });
    return {
      ok: true,
      code: 0,
      stdout: String(stdout),
      stderr: "",
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      seconds: (Date.now() - started) / 1000,
    };
  }
};

/** 从输出里提取测试通过/失败/忽略数，便于审计「有多少是真的跑了」。 */
const testCounts = (text) => {
  const pick = (label) => {
    const match = new RegExp(`${label}\s+(\d+)`).exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    passed: pick("pass"),
    failed: pick("fail"),
    ignored: pick("ignored"),
    tests: pick("tests"),
  };
};

const git = (...commandArgs) => run("git", commandArgs).stdout.trim();

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

// 只读命令：不修改工作区，也不联网。
const checks = [
  ["版本一致性", "node", ["scripts/check-version.mjs"]],
  ["前端测试", "npm", ["test"]],
  ["前端 lint", "npm", ["run", "lint"]],
  ["前端 format 检查", "npx", ["prettier", "--check", "."]],
  ["前端构建", "npm", ["run", "build"]],
  [
    "cargo fmt",
    "cargo",
    ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
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
  ],
  [
    "cargo test",
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"],
  ],
];

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
lines.push("> 这些命令由本脚本重新运行；结果记录的是本次运行，不是历史记录。");
lines.push("");
const failures = [];
const checkResults = [];
for (const [label, command, commandArgs] of checks) {
  const result = run(command, commandArgs);
  checkResults.push({ label, result });
  if (!result.ok) failures.push(label);
  const counts = testCounts(`${result.stdout}\n${result.stderr}`);
  lines.push(
    `- ${result.ok ? "✅" : "❌"} ${label}：\`${command} ${commandArgs.join(" ")}\``,
  );
  lines.push(`  - 退出码：${result.code} · 用时 ${result.seconds.toFixed(1)}s`);
  if (counts.tests != null || counts.passed != null) {
    lines.push(
      `  - 测试计数：tests=${counts.tests ?? "?"} pass=${counts.passed ?? "?"} ` +
        `fail=${counts.failed ?? "?"} ignored=${counts.ignored ?? "?"}`,
    );
  }
}
lines.push("");
lines.push("### 完整输出");
lines.push("");
lines.push("> 审计需要原始 stdout/stderr，不截断。");
lines.push("");
for (const { label, result } of checkResults) {
  lines.push(`<details><summary>${label}（退出码 ${result.code}）</summary>`);
  lines.push("");
  lines.push("```text");
  lines.push((result.stdout || "(stdout 为空)").trim());
  if (result.stderr.trim()) {
    lines.push("");
    lines.push("[stderr]");
    lines.push(result.stderr.trim());
  }
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
    `❌ 未通过：${failures.join("、")} 失败。本次记录不能作为放行证据。`,
  );
} else if (installerStatus !== "hashed") {
  lines.push(
    "⚠ 门禁命令全部通过，但安装包未校验：只能作为「源码门禁」证据，不是完整发版证据。",
  );
} else {
  lines.push("✅ 门禁命令全部通过且记录了安装包哈希；仍需真机与安装升级验收。");
}

const text = lines.join("\n") + "\n";
if (out) {
  writeFileSync(resolve(out), text, "utf8");
  console.log(resolve(out));
} else {
  console.log(text);
}
// 复评 F18：失败必须传播到退出码，外层不能只看「报告已生成」就放行。
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exitCode = 1;
}
