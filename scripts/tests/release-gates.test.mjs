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
// external tool results; production has no bypass switch.
// These are gate fault-injection tests, not native Rust/Windows execution evidence.
const loader = `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = cp.spawnSync;
const originalWrite = fs.writeFileSync;
const scenario = process.env.DSM_GATE_TEST_SCENARIO;
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
    if (scenario === "zero-tests") return ok("test result: ok. 0 passed; 0 failed; 0 ignored;\\n");
    if (scenario === "ignored-only") return ok("test result: ok. 0 passed; 0 failed; 4 ignored;\\n");
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

test("Rust gate runs only the remaining DeepSeek suite and records its scope", () => {
  const result = execute("run-rust-tests.mjs", "pass");
  const log = JSON.parse(result.report);
  assert.equal(result.status, 0);
  assert.equal(log.schemaVersion, 2);
  assert.equal(log.scope, "deepseek-account");
  assert.equal(log.verdict, "PASS");
  assert.equal(log.rust.counts.passed, 2);
  assert.ok(log.rust.args.includes("--show-output"));
  assert.equal(Object.hasOwn(log, "capabilities"), false);
});

for (const scenario of ["zero-tests", "ignored-only"]) {
  test(`Rust gate rejects ${scenario} even when cargo exits zero`, () => {
    const result = execute("run-rust-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 4);
    assert.equal(log.verdict, "ERROR");
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

for (const scenario of [
  "rust-fail",
  "tool-error",
  "missing-log",
  "zero-tests",
  "ignored-only",
]) {
  test(`release: ${scenario} fails closed`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    assert.match(
      result.report,
      scenario === "rust-fail"
        ? /\| cargo test \| FAIL/
        : /\| cargo test \| ERROR/,
    );
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
  assert.doesNotMatch(source, /run-integration-tests|local-usage:prepare/);
});

test("release and build no longer invoke or package the removed Agent engine", () => {
  const release = readFileSync(
    join(root, "scripts", "release-record.mjs"),
    "utf8",
  );
  const gate = readFileSync(
    join(root, "scripts", "run-rust-tests.mjs"),
    "utf8",
  );
  const config = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  assert.doesNotMatch(release, /run-integration-tests|integrationLogFile/);
  assert.doesNotMatch(gate, /symlinkSync|probeLinks/);
  assert.equal(config.build.beforeDevCommand, "npm run dev");
  assert.equal(config.build.beforeBuildCommand, "npm run build");
  assert.equal(Object.hasOwn(config.bundle, "resources"), false);
});
