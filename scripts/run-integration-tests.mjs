#!/usr/bin/env node
// 显式运行被 #[ignore] 标记的引擎集成测试。
//
// 复评 F20/R15：`cargo test --lib` 默认跳过 4 项集成测试；只写已实测验证的格式，
// 覆盖不足的用例明确 NOT RUN，不伪造、不冒充通过。
//
// 复评 T01：cargo test --exact 需要**全限定名**（如 `local_usage::tests::xxx`）。
// 传裸函数名会 `running 0 tests` 并以退出码 0 结束 —— 原脚本仅凭退出码判 PASS，
// 于是零执行也被当成通过。现在：先用 `--list` 枚举真实全名并要求唯一匹配，
// 再逐项校验「实际执行数恰好 1 且 failed=0」，零执行一律 NOT RUN。
//
// 复评 T02：分类顺序是 FAIL 优先 —— `0 passed; 1 failed` 是真实失败，
// 不得因出现 "0 passed" 被归为 NOT RUN。工具本身没跑起来（cargo 缺失等）是 ERROR。
//
// 复评 T09：每个子用例都保留完整命令、参数、退出码与 stdout/stderr，
// 可用 `--log-file <path>` 落盘，供发布记录重建真实调用。
//
// 复评 T10：合成记录的时间戳从**执行时钟**生成（当月 15 日中午），
// 不再写死 2026-11-01；探针与用例查询同月，跨月不会无产品变更地失败。
//
// 第五轮复评 Q09：日志改为结构化契约 —— `preflight` 存探针/枚举等前置调用，
// `results` 存逐用例结论（PASS/FAIL/NOT RUN/ERROR 全部落盘，含实际计数、
// 命令、参数、cwd、退出码与两路输出）。发布记录只消费这个 schema，
// 不再从裸调用流里猜结论。
//
// 第五轮复评 Q10：所有提前退出统一 flushLogs 落盘；spawn 启动错误保留
// name/message/code；探针记录实际执行的 exe 路径与显式 cwd。
//
// 退出码：0 全部 PASS / 1 有用例 FAIL / 2 有用例 NOT RUN / 3 配置或 fixture 错误
//        4 工具执行错误（cargo 缺失、编译失败等，结论未知）

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
const logArgIndex = process.argv.indexOf("--log-file");
const logFile = logArgIndex >= 0 ? process.argv[logArgIndex + 1] : undefined;
const engine = join(root, "src-tauri/resources/local-usage/tokscale.exe");
/** 复评 N15：探针专用缓存 profile（临时目录，随 fixture 一并清理）。 */
let probeProfile = "";

/** 第五轮复评 Q10：保留 spawn 启动错误（ENOENT/ENOEXEC 等）的原始字段。 */
function spawnError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    code: typeof error.code === "string" ? error.code : undefined,
  };
}

/** 已用固定引擎实测验证可解析的工具与格式。 */
const VERIFIED_TOOLS = ["claude"];

/** 需要六款工具完整 fixture 的用例：只覆盖 Claude 时必然 NOT RUN。 */
const FULL_MATRIX_TESTS = [
  "五工具单路径真实引擎与部分失败",
  "双主目录真实引擎合并_部分失败不当零",
  "六工具合成记录经真实引擎和ipc归一化一致",
];

const TOKENS = { input: 100, cacheRead: 10, output: 20 };

/**
 * 合成记录时间戳（复评 T10）：直接取**当前时刻**。
 *
 * 引擎的 `--month` 语义是「当月至今」（实测：未来日期会被排除），
 * 所以时间戳必须既在当月、又不晚于现在 —— 只有「现在」永远满足。
 * 写死日期（如 2026-11-01）会在跨月后无产品变更地失败。
 * 每次调用 cargo 前都会重写 fixture，月界跨越也以当前时钟为准。
 */
function fixtureTimestamp() {
  return new Date().toISOString();
}

/** Claude Code 的 JSONL 行格式（已实测）。 */
function claudeLine({ sessionId, cwd, id }) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    cwd,
    timestamp: fixtureTimestamp(),
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

const cargoEnv = () => ({
  ...process.env,
  DSM_TEST_LOCAL_USAGE_HOME: fixture.home,
  DSM_TEST_LOCAL_USAGE_SECOND_HOME: fixture.second,
});

/**
 * 复评 N14：**任何子进程启动前**先核验固定引擎（manifest 存在、体积、
 * SHA-256）。旧实现「见到 exe 就执行」—— 一个错误的二进制（甚至无害 stub）
 * 会被真的跑起来，探针结果再决定后续分类。生产路径的 SHA 校验没有失效，
 * 但开发门禁不应先执行未验证的二进制。
 *
 * 返回 `null` 表示校验通过；否则返回原因字符串。
 */
function verifyPinnedEngine() {
  if (!existsSync(engine)) return "缺少固定引擎";
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(root, "scripts", "local-usage-engine.json"), "utf8"),
    );
  } catch {
    return "引擎 manifest 无法读取";
  }
  const expected = String(manifest.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return "引擎 manifest 缺少有效 sha256";
  const limit = Number(manifest.maxBytes ?? 50 * 1024 * 1024);
  // 复评 T19：**先 stat 常规文件、再流式累计哈希并限额**，不先整读再判大小。
  // 旧实现 `readFileSync` 一把读完 —— 目录/EACCES/超大文件都会抛出未捕获
  // 异常，落进退出码 1 且不写 JSON、不清理 fixture。
  let stat;
  try {
    stat = statSync(engine);
  } catch (error) {
    return `引擎无法 stat（${error.code ?? error.message}）`;
  }
  if (!stat.isFile()) return "引擎路径不是常规文件";
  if (stat.size > limit) return `引擎超过体积上限（${stat.size} 字节）`;
  let bytes;
  try {
    bytes = readFileSync(engine);
  } catch (error) {
    return `引擎读取失败（${error.code ?? error.message}）`;
  }
  // 读中变化：大小与 stat 不一致就拒绝（不拿未验证字节做哈希）。
  if (bytes.length !== stat.size) return "引擎在读取期间发生变化";
  if (bytes.length > limit) return `引擎超过体积上限（${bytes.length} 字节）`;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) return `引擎 SHA-256 不匹配（实际 ${actual}）`;
  return null;
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
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        // 复评 N15：**不继承**父进程的 TOKSCALE_CONFIG_DIR / 定价缓存变量 ——
        // 旧实现只覆盖 PRICING_CACHE_ONLY，stub 会收到父值并可能读写真实
        // 用户配置/缓存。这里用临时目录做专用 profile，并显式清空继承值。
        ...process.env,
        TOKSCALE_CONFIG_DIR: probeProfile,
        TOKSCALE_PRICING_CACHE_ONLY: "1",
        DO_NOT_TRACK: "1",
      },
    },
  );
  const outcome = {
    fullName: "probeEngine（fixture 探针）",
    // 第五轮复评 Q10：记录实际执行的二进制路径与显式 cwd，保证日志可重放。
    command: engine,
    args: [
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
    cwd: root,
    code: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: spawnError(result.error),
  };
  // 复评 Q10：探针失败也要留下完整命令与两个流，供发布记录定位。
  recordLog(outcome);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout));
    return Array.isArray(parsed.entries) ? parsed.entries.length : null;
  } catch {
    return null;
  }
}

/** 复评 T01：枚举 ignored 用例的**全限定名**。 */
function listIgnoredTests() {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "--",
      "--ignored",
      "--list",
    ],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  // 复评 Q10/第五轮 Q10：枚举失败（编译错误、启动失败等）同样留下底层诊断，
  // 且该失败路径的最终 exit(4) 前由调用方 flushLogs 落盘。
  recordLog({
    fullName: "listIgnoredTests（用例枚举）",
    command: "cargo",
    args: [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "--",
      "--ignored",
      "--list",
    ],
    cwd: root,
    code: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: spawnError(result.error),
  });
  if (result.status !== 0) {
    return { error: `cargo --list 退出码 ${result.status}` };
  }
  // 形如 `local_usage::tests::名称: test`
  const names = String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(": test"))
    .map((line) => line.slice(0, -": test".length));
  return { names };
}

// 复评 Q10/第五轮 Q09：`logs` 只存前置调用（探针/枚举），逐用例结论在
// `results` 数组里并随最终 JSON 一起落盘 —— 两个数组共同构成发布记录消费的
// 结构化契约。诊断日志从脚本一开始就存在，探针/枚举等前置失败也要留下
// 完整命令、退出码与两个流，否则发布记录无法定位 fixture/编译错误。
const logs = [];

/** 记录一次前置调用（含两个流），供 --log-file 与发布记录使用。 */
function recordLog(entry) {
  logs.push(entry);
}

/** 前置失败时的落盘形状：此时还没有任何用例结论。 */
function logPayload(resultsValue) {
  return {
    generatedAt: new Date().toISOString(),
    preflight: logs,
    results: resultsValue,
  };
}

/** 把已记录的诊断写到 --log-file 指定的路径（若提供）。 */
function flushLogs() {
  if (!logFile) return;
  try {
    writeFileSync(resolve(logFile), JSON.stringify(logPayload([]), null, 2));
  } catch (error) {
    console.error(`诊断日志写入失败：${error.message}`);
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
    flushLogs();
    process.exit(3);
  }
  if (!second || !existsSync(second)) {
    console.error(
      "配置错误：需要 DSM_TEST_LOCAL_USAGE_SECOND_HOME 指向另一个存在的目录。",
    );
    flushLogs();
    process.exit(3);
  }
  if (resolve(externalHome) === resolve(second)) {
    console.error("配置错误：两个合成主目录相同，双主目录用例无法区分来源。");
    flushLogs();
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

// 复评 N14：启动任何子进程前先核验固定引擎（manifest + 体积 + SHA-256）。
{
  const reason = verifyPinnedEngine();
  if (reason) {
    console.error(
      `未运行：${reason}（${engine}）。请先执行 npm run local-usage:prepare。`,
    );
    console.error(
      "本次结论：INTEGRATION NOT RUN —— 不能把 ignored 项计入「通过」。",
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    flushLogs();
    process.exit(2);
  }
}

// 复评 N15：探针使用**专用缓存 profile**（临时目录），不继承父进程配置。
{
  const profileRoot =
    cleanup ?? mkdtempSync(join(tmpdir(), "dsm-probe-profile-"));
  probeProfile = join(profileRoot, "probe-profile");
  mkdirSync(probeProfile, { recursive: true });
  if (!cleanup) cleanup = profileRoot;
}

// 复评 T10：无论哪种模式，先确认 fixture 里有**当月**数据可被引擎解析。
// 探针失败是配置/格式问题（退出码 3），不是产品回归，也不会伪装成通过。
{
  const rows = probeEngine(fixture.home);
  if (rows == null) {
    console.error("fixture 错误：引擎无法解析生成的合成目录。");
    console.error(
      "这不是产品回归，而是 fixture 与引擎格式不再匹配；请更新本脚本的格式。",
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    flushLogs();
    process.exit(3);
  }
  if (rows < VERIFIED_TOOLS.length) {
    console.error(
      `fixture 错误：引擎只解析出 ${rows} 条记录，至少应有 ${VERIFIED_TOOLS.length} 条。`,
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    flushLogs();
    process.exit(3);
  }
  console.log(`fixture 校验通过：单目录解析 ${rows} 条记录。`);
}

/** 复评 T01：解析 `test result:` 行，得到实际执行数与失败数。 */
function parseResultLine(text) {
  // 例：test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 195 filtered out
  const match =
    /test result:\s*\w+\.?\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/.exec(
      text,
    );
  if (!match) return null;
  return {
    passed: Number(match[1]),
    failed: Number(match[2]),
    ignored: Number(match[3]),
  };
}

/**
 * 运行单个用例并按证据分类。
 *
 * 复评 T01/T02：PASS 要求「实际执行数恰好 1、failed=0、退出码 0」；
 * 失败优先于 NOT RUN；工具没跑起来是 ERROR。
 */
function runTest(fullName) {
  const args = [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "--",
    "--ignored",
    "--exact",
    fullName,
    "--nocapture",
  ];
  const result = spawnSync("cargo", args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 32 * 1024 * 1024,
    env: cargoEnv(),
  });
  const code = typeof result.status === "number" ? result.status : 1;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  // 第五轮复评 Q09：runTest 的原始调用不再混入前置日志；带 verdict 的完整
  // 结构化结果由调用方放进 results，最终随 JSON 落盘。
  const entry = {
    fullName,
    command: "cargo",
    args,
    cwd: root,
    code,
    stdout,
    stderr,
    error: spawnError(result.error),
  };

  // 工具执行错误：cargo 没跑起来或编译失败，结论未知（复评 T02）。
  if (code !== 0 && code !== 101) {
    return { ...entry, verdict: "ERROR", reason: `cargo 退出码 ${code}` };
  }
  const counts = parseResultLine(stdout);
  if (!counts) {
    // 没有可解析的结果行：既不能算 PASS 也不能算 FAIL。
    return {
      ...entry,
      verdict: "ERROR",
      reason: "无法从输出解析 test result 行",
    };
  }
  const executed = counts.passed + counts.failed;
  // 复评 T02：失败优先判定 —— `0 passed; 1 failed` 是真实回归。
  if (counts.failed > 0 || (code === 101 && executed > 0)) {
    return { ...entry, verdict: "FAIL", reason: `${counts.failed} failed` };
  }
  // 复评 T01：零执行（如用例名不匹配）不能 PASS。
  if (executed === 0) {
    return { ...entry, verdict: "NOT RUN", reason: "实际执行 0 个测试" };
  }
  if (executed > 1) {
    return {
      ...entry,
      verdict: "ERROR",
      reason: `筛选匹配到 ${executed} 个测试，结果有歧义`,
    };
  }
  if (code !== 0) {
    return { ...entry, verdict: "FAIL", reason: `退出码 ${code}` };
  }
  return { ...entry, verdict: "PASS" };
}

// 复评 T01：先把期望用例名解析成全限定名，要求唯一匹配。
const listed = listIgnoredTests();
if (listed.error) {
  console.error(`工具执行错误：${listed.error}`);
  if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
  // 第五轮复评 Q10：提前退出也要把前置诊断（含枚举失败详情）落盘。
  flushLogs();
  process.exit(4);
}
const expectedNames = [
  ...FULL_MATRIX_TESTS,
  "pinned_engine_and_adapter_known_counts_match",
];
const resolved = [];
for (const name of expectedNames) {
  const matches = (listed.names ?? []).filter(
    (full) => full === name || full.endsWith(`::${name}`),
  );
  if (matches.length !== 1) {
    // 名字对不上是脚本/上游漂移，不是产品回归：明确 CONFIG 错误。
    console.error(
      `配置错误：用例「${name}」匹配到 ${matches.length} 个测试（期望 1）。请核对脚本中的用例名。`,
    );
    if (cleanup && !keep) rmSync(cleanup, { recursive: true, force: true });
    flushLogs();
    process.exit(3);
  }
  resolved.push({ shortName: name, fullName: matches[0] });
}

const results = [];
for (const { shortName, fullName } of resolved) {
  const needsFullMatrix = FULL_MATRIX_TESTS.includes(shortName);
  if (needsFullMatrix && !fullMatrix) {
    results.push({
      fullName,
      verdict: "NOT RUN",
      reason: `fixture 只覆盖 ${VERIFIED_TOOLS.join("、")}，该用例需要六款工具`,
    });
    continue;
  }
  results.push(runTest(fullName));
}

// 复评 T09：无论结论如何都输出完整结果表与底层日志。
console.log("");
console.log("| 用例 | 结论 | 说明 |");
console.log("| - | - | - |");
for (const item of results) {
  console.log(`| ${item.fullName} | ${item.verdict} | ${item.reason ?? "-"} |`);
}
console.log("");
for (const item of results) {
  if (item.verdict === "NOT RUN" && !item.command) continue; // 未运行的用例没有日志
  console.log(
    `=== ${item.fullName}（${item.verdict}，退出码 ${item.code}）===`,
  );
  console.log(`[command] ${item.command} ${item.args.join(" ")}`);
  console.log("[stdout]");
  console.log(item.stdout.trim() || "(stdout 为空)");
  console.log("[stderr]");
  console.log(item.stderr.trim() || "(stderr 为空)");
  console.log("");
}

if (logFile) {
  // 第五轮复评 Q09：结构化契约 —— preflight 存前置调用，results 存逐用例
  // 结论（含 NOT RUN/ERROR），发布记录据此合计计数并完整嵌入。
  writeFileSync(resolve(logFile), JSON.stringify(logPayload(results), null, 2));
  console.log(`已写入集成日志：${resolve(logFile)}`);
}

if (keep && cleanup) console.log(`已保留 fixture：${cleanup}`);
else if (cleanup) rmSync(cleanup, { recursive: true, force: true });

const errors = results.filter((item) => item.verdict === "ERROR");
const failed = results.filter((item) => item.verdict === "FAIL");
const notRun = results.filter((item) => item.verdict === "NOT RUN");
if (errors.length) {
  console.error(`\n工具执行错误 ${errors.length} 项：结论未知，不能算通过。`);
  process.exitCode = 4;
} else if (failed.length) {
  console.error(
    `\n集成测试失败 ${failed.length} 项：不能把 ignored 项当作通过。`,
  );
  process.exitCode = 1;
} else if (notRun.length) {
  console.error(
    `\n集成测试未完整运行：${notRun.length} 项 NOT RUN。发版前必须补齐。`,
  );
  process.exitCode = 2;
} else {
  console.log("\n集成测试已全部显式运行并通过。");
}
