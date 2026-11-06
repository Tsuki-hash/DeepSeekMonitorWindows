#!/usr/bin/env node
// 显式运行被 #[ignore] 标记的引擎集成测试。
//
// 复评 F20：`cargo test --lib` 默认跳过 4 项集成测试，把 ignored 当成通过是假绿灯。
//
// 复评 R15：原入口只接受外部目录，`SECOND_HOME` 缺省时退化成同一目录，
// 「双主目录」用例要求两个不同来源，去重后必然只剩一份；注释声称生成 fixture
// 但实际没有生成。
//
// 复评 R15（本版）：三项 local_usage 集成用例都要求**六款工具**的合成记录，
// 而各工具的真实格式差异很大（OpenCode 用 storage/message、DSH 用 zstd 压缩的
// jsonl.v4、Hermes/OpenClaw 依赖自有存储）。本脚本只保证已实测验证的格式，
// 其余**明确声明未覆盖**，逐用例给出 PASS / FAIL / NOT RUN，绝不把
// 「fixture 不够」记成「产品回归」或「通过」。
//
// 退出码：0 全部 PASS / 1 有用例 FAIL / 2 有用例 NOT RUN / 3 配置或 fixture 错误

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const engine = join(root, "src-tauri/resources/local-usage/tokscale.exe");

/**
 * 已用固定引擎实测验证可解析的工具与格式。
 *
 * 只有 Claude Code 的 `<home>/.claude/projects/<project>/<session>.jsonl`
 * 被确认能产出 input=100 / cacheRead=10 / output=20 的记录。
 * 其余工具的写入格式未经验证，写「看起来像」的数据只会让用例失败并误导排查。
 */
const VERIFIED_TOOLS = ["claude"];

/** 需要六款工具完整 fixture 的用例：在只覆盖 Claude 时必然 NOT RUN。 */
const FULL_MATRIX_TESTS = [
  "五工具单路径真实引擎与部分失败",
  "双主目录真实引擎合并_部分失败不当零",
  "六工具合成记录经真实引擎和ipc归一化一致",
];

const TOKENS = { input: 100, cacheRead: 10, output: 20 };

/** Claude Code 的 JSONL 行格式（已实测）。 */
function claudeLine({ sessionId, cwd, timestamp, id }) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    cwd,
    timestamp,
    message: {
      id,
      model: "deepseek-flash",
      usage: {
        input_tokens: TOKENS.input,
        output_tokens: TOKENS.output,
        cache_read_input_tokens: TOKENS.cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

/** 生成一个只含已验证格式的合成主目录；`tag` 让两个目录的会话互不相同。 */
function buildHome(dir, tag) {
  const project = join(dir, ".claude", "projects", `project-${tag}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `session-${tag}.jsonl`),
    claudeLine({
      sessionId: `session-${tag}`,
      cwd: project,
      timestamp: "2026-11-01T10:00:00Z",
      id: `msg-${tag}`,
    }) + "\n",
  );
  // 未覆盖工具留空目录：相关用例会明确失败，由下方分类记为 NOT RUN。
  for (const relative of [
    join(".local", "share", "opencode", "storage", "message"),
    join(".hermes", "sessions"),
    join(".openclaw", "agents"),
    join(".dsh", "sessions"),
  ]) {
    mkdirSync(join(dir, relative), { recursive: true });
  }
  return dir;
}

/** 用引擎解析一次，返回记录数；失败返回 null。 */
function probeEngine(home) {
  const result = spawnSync(
    engine,
    [
      "--json",
      "--client",
      "opencode,claude,zcode,hermes,openclaw,dsh",
      "--group-by",
      "client,workspace,session,model",
      "--month",
      "--no-spinner",
      "--home",
      home,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        TOKSCALE_PRICING_CACHE_ONLY: "1",
        DO_NOT_TRACK: "1",
      },
    },
  );
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout));
    return Array.isArray(parsed.entries) ? parsed.entries.length : null;
  } catch {
    return null;
  }
}

const externalHome = process.env.DSM_TEST_LOCAL_USAGE_HOME;
let fixture;
let cleanup = null;
let fullMatrix = false;

if (externalHome) {
  const second = process.env.DSM_TEST_LOCAL_USAGE_SECOND_HOME;
  if (!existsSync(externalHome)) {
    console.error("配置错误：DSM_TEST_LOCAL_USAGE_HOME 指向的目录不存在。");
    process.exit(3);
  }
  if (!second || !existsSync(second)) {
    console.error(
      "配置错误：需要 DSM_TEST_LOCAL_USAGE_SECOND_HOME 指向另一个存在的目录。",
    );
    process.exit(3);
  }
  if (resolve(externalHome) === resolve(second)) {
    console.error("配置错误：两个合成主目录相同，双主目录用例无法区分来源。");
    process.exit(3);
  }
  fixture = { home: externalHome, second };
  // 外部目录视为调用方已准备完整 fixture。
  fullMatrix = true;
} else {
  const base = mkdtempSync(join(tmpdir(), "dsm-integration-"));
  fixture = {
    home: buildHome(join(base, "home-a"), "a"),
    second: buildHome(join(base, "home-b"), "b"),
  };
  cleanup = base;
  console.log(`已生成合成 fixture：${base}`);
  console.log(
    `覆盖工具：${VERIFIED_TOOLS.join("、")}（其余工具格式未验证，不伪造）`,
  );
}

if (!existsSync(engine)) {
  console.error(
    `未运行：缺少固定引擎 ${engine}。请先执行 npm run local-usage:prepare。`,
  );
  console.error(
    "本次结论：INTEGRATION NOT RUN —— 不能把 ignored 项计入「通过」。",
  );
  if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
  process.exit(2);
}

if (!fullMatrix) {
  // 校验 fixture 与当前引擎格式仍匹配：格式漂移要报 FIXTURE 错误而非产品回归。
  const rows = probeEngine(fixture.home);
  if (rows == null) {
    console.error("fixture 错误：引擎无法解析生成的合成目录。");
    console.error(
      "这不是产品回归，而是 fixture 与引擎格式不再匹配；请更新本脚本的格式。",
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    process.exit(3);
  }
  if (rows < VERIFIED_TOOLS.length) {
    console.error(
      `fixture 错误：引擎只解析出 ${rows} 条记录，至少应有 ${VERIFIED_TOOLS.length} 条。`,
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    process.exit(3);
  }
  console.log(`fixture 校验通过：单目录解析 ${rows} 条记录。`);
}

/**
 * 逐用例运行：只跑能判定的用例，其余明确 NOT RUN。
 *
 * `cargo test --lib -- --ignored --exact <name>` 用于单个用例；
 * 只覆盖 Claude 时，六工具矩阵用例不可能通过，直接归为 NOT RUN。
 */
const runTest = (name) => {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "--",
      "--ignored",
      "--exact",
      name,
      "--nocapture",
    ],
    {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        DSM_TEST_LOCAL_USAGE_HOME: fixture.home,
        DSM_TEST_LOCAL_USAGE_SECOND_HOME: fixture.second,
      },
    },
  );
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

const results = [];
const allTests = [
  ...FULL_MATRIX_TESTS,
  "pinned_engine_and_adapter_known_counts_match",
];
for (const name of allTests) {
  const needsFullMatrix = FULL_MATRIX_TESTS.includes(name);
  if (needsFullMatrix && !fullMatrix) {
    results.push({
      name,
      verdict: "NOT RUN",
      reason: `fixture 只覆盖 ${VERIFIED_TOOLS.join("、")}，该用例需要六款工具`,
    });
    continue;
  }
  const outcome = runTest(name);
  if (outcome.code === 0) {
    results.push({ name, verdict: "PASS" });
  } else if (
    outcome.code === 101 &&
    /no tests matched|0 passed|0 filtered/i.test(
      outcome.stdout + outcome.stderr,
    )
  ) {
    // 用例名不匹配（上游改名）与真实失败要分开。
    results.push({ name, verdict: "NOT RUN", reason: "用例名未匹配" });
  } else {
    results.push({ name, verdict: "FAIL", reason: `退出码 ${outcome.code}` });
    process.stderr.write(outcome.stdout);
    process.stderr.write(outcome.stderr);
  }
}

console.log("");
console.log("| 用例 | 结论 | 说明 |");
console.log("| - | - | - |");
for (const item of results) {
  console.log(`| ${item.name} | ${item.verdict} | ${item.reason ?? "-"} |`);
}

if (keep && cleanup) console.log(`已保留 fixture：${cleanup}`);
else if (cleanup) rmSync(cleanup, { recursive: true, force: true });

const failed = results.filter((item) => item.verdict === "FAIL");
const notRun = results.filter((item) => item.verdict === "NOT RUN");
if (failed.length) {
  console.error(
    `\n集成测试失败 ${failed.length} 项：不能把 ignored 项当作通过。`,
  );
  process.exitCode = 1;
} else if (notRun.length) {
  console.error(
    `\n集成测试未完整运行：${notRun.length} 项 NOT RUN（fixture 覆盖不足）。发版前必须补齐。`,
  );
  process.exitCode = 2;
} else {
  console.log("\n集成测试已全部显式运行并通过。");
}
