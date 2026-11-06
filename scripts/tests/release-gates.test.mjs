import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Execute the final scripts as real Node subprocesses. The loader only replaces
// external tool results/capability errors; production has no bypass switch.
// These are gate fault-injection tests, not native Rust/Windows execution evidence.
const loader = `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = cp.spawnSync;
const originalStat = fs.lstatSync;
const originalRealpath = fs.realpathSync;
const originalRead = fs.readFileSync;
const links = new Map();
const originalWrite = fs.writeFileSync;
const scenario = process.env.DSM_GATE_TEST_SCENARIO;
const rustEntry = /run-rust-tests\\.mjs$/.test(process.argv[1] ?? "");
if (rustEntry && scenario.startsWith("windows-")) Object.defineProperty(process, "platform", { value: "win32" });
fs.symlinkSync = (...args) => {
  if (scenario === "windows-" + args[2]) {
    const error = new Error("synthetic link privilege failure (1314)");
    error.code = "EPERM";
    throw error;
  }
  links.set(args[1], args[0]);
};
fs.lstatSync = (path, ...args) => links.has(path) ? { isSymbolicLink: () => true } : originalStat(path, ...args);
fs.realpathSync = (path, ...args) => originalRealpath(links.get(path) ?? path, ...args);
fs.readFileSync = (path, ...args) => originalRead(links.get(path) ?? path, ...args);
fs.writeFileSync = (...args) => {
  if (scenario === "missing-log" && String(args[0]).includes("dsm-rust-log-")) return;
  return originalWrite(...args);
};
const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath || command === "node") return originalSpawn(command, args, options);
  if (command === "git") {
    if (args[0] === "status") return ok("");
    return ok(args.includes("--abbrev-ref") ? "fixture-branch" : "a".repeat(40));
  }
  if (args.includes("--version")) return ok("fixture-tool-version");
  if (command === "cargo" && args[0] === "test") {
    if (scenario === "tool-error") return { ...ok(), status: null, error: new Error("synthetic spawn failure") };
    if (scenario === "rust-fail") return { ...ok("test result: FAILED. 1 passed; 1 failed; 4 ignored;\\n"), status: 101 };
    const marker = scenario === "captured-marker" && args.includes("--show-output") ? "NOT RUN: synthetic unavailable scenario\\n" : "";
    return ok(marker + "test result: ok. 2 passed; 0 failed; 4 ignored;\\n");
  }
  if (command === "npm" && args.includes("test:components") && scenario === "component-fail") return { ...ok(), status: 1 };
  if (command === "npm" && (args.includes("test") || args.includes("test:components"))) return ok("# tests 3\\n# pass 3\\n# fail 0\\n# skipped 0\\n");
  return ok();
};
syncBuiltinESMExports();
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsm-gate-test-"));
  mkdirSync(join(dir, "scripts", "tests"), { recursive: true });
  mkdirSync(join(dir, "src-tauri"));
  for (const file of ["release-record.mjs", "run-rust-tests.mjs"])
    copyFileSync(join(root, "scripts", file), join(dir, "scripts", file));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.0.0-fixture", type: "module" }),
  );
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "src-tauri", "Cargo.lock"), "fixture");
  writeFileSync(join(dir, "scripts", "check-version.mjs"), "");
  writeFileSync(join(dir, "scripts", "audit-dependencies.mjs"), "");
  writeFileSync(
    join(dir, "scripts", "tests", "release-gates.test.mjs"),
    "// Avoid recursively running this fixture's harness.\n",
  );
  writeFileSync(
    join(dir, "scripts", "run-integration-tests.mjs"),
    `
    import { writeFileSync } from "node:fs";
    const file = process.argv[process.argv.indexOf("--log-file") + 1];
    writeFileSync(file, JSON.stringify({ results: [1,2,3,4].map((id) => ({ fullName: "fixture-" + id, verdict: "PASS", code: 0, stdout: "test result: ok. 1 passed; 0 failed; 0 ignored;" })), preflight: [] }));
  `,
  );
  const preload = join(dir, "inject.mjs");
  writeFileSync(preload, loader);
  return { dir, preload };
}

function execute(entry, scenario) {
  const { dir, preload } = fixture();
  try {
    const report = join(
      dir,
      entry === "release-record.mjs" ? "report.md" : "rust.json",
    );
    const flag = entry === "release-record.mjs" ? "--out" : "--log-file";
    const result = spawnSync(
      process.execPath,
      [join(dir, "scripts", entry), flag, report],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}`,
          DSM_GATE_TEST_SCENARIO: scenario,
        },
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    return { ...result, report: readFileSync(report, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const kind of ["file", "dir", "junction"]) {
  test(`Rust gate blocks missing Windows ${kind} capability, even if cargo exits zero`, () => {
    const result = execute("run-rust-tests.mjs", `windows-${kind}`);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 2);
    assert.equal(log.verdict, "NOT RUN");
    assert.equal(
      log.capabilities.find((item) => item.id === kind).verdict,
      "NOT RUN",
    );
    assert.equal(
      log.capabilities.filter((item) => item.verdict === "PASS").length,
      2,
    );
    assert.ok(log.rust.args.includes("--show-output"));
    assert.equal(
      log.rust.counts,
      null,
      "missing scenarios must not contribute a claimed PASS count",
    );
  });
}

test("release: successful-output marker is visible and never counted as PASS", () => {
  const result = execute("release-record.mjs", "captured-marker");
  assert.equal(result.status, 2);
  assert.match(result.report, /\| cargo test \| NOT RUN \| 2 \|[^\n]*不可解析/);
  assert.doesNotMatch(result.report, /\| cargo test \| PASS/);
  assert.match(result.report, /NOT RUN=1/);
  assert.match(result.report, /发布不放行/);
});

test("release: missing Windows junction is NOT RUN in row, summary and exit", () => {
  const result = execute("release-record.mjs", "windows-junction");
  assert.equal(result.status, 2);
  assert.match(result.report, /\| cargo test \| NOT RUN \| 2 \|[^\n]*不可解析/);
  assert.match(result.report, /NOT RUN=1/);
  assert.match(result.report, /发布不放行/);
});

for (const scenario of ["rust-fail", "tool-error", "missing-log"]) {
  test(`release: ${scenario} fails closed`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    assert.match(result.report, /\| cargo test \| FAIL/);
    assert.match(result.report, /❌ FAIL/);
  });
}

test("release: component gate is mandatory", () => {
  const result = execute("release-record.mjs", "component-fail");
  assert.equal(result.status, 1);
  assert.match(result.report, /\| 组件测试 \| FAIL/);
});

test("release: complete synthetic happy path has no missing gate", () => {
  const result = execute("release-record.mjs", "pass");
  assert.equal(result.status, 0);
  assert.match(
    result.report,
    /\| cargo test \| PASS \| 0 \|[^\n]*pass=2 fail=0 ignored=4/,
  );
  assert.match(result.report, /FAIL=0；NOT RUN=0/);
  assert.match(result.report, /门禁命令全部通过，但安装包未校验/);
});

test("verify uses the same Rust entry point and mandatory component/fault gates", () => {
  const source = readFileSync(join(root, "scripts", "verify.ps1"), "utf8");
  assert.match(
    source,
    /Invoke-Check[^\n]+node[^\n]+scripts\/run-rust-tests\.mjs/,
  );
  assert.match(source, /run-rust-tests\.mjs[^\n]+-ScenarioGate/);
  assert.match(source, /Invoke-Check[^\n]+test:components/);
  assert.match(source, /Invoke-Check[^\n]+release-gates\.test\.mjs/);
  assert.doesNotMatch(source, /Invoke-Check 'cargo test' 'cargo'/);
});
