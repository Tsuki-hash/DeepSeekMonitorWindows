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
import { REQUIRED_WINDOWS_TESTS } from "../run-rust-tests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The final scripts run in Node subprocesses, with external processes replaced
// only in this test preload. These simulated Windows results are fault-injection
// evidence, NEVER evidence that native DPAPI/Win32 tests actually ran.
const loader = `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = cp.spawnSync;
const originalWrite = fs.writeFileSync;
const scenario = process.env.DSM_GATE_TEST_SCENARIO;
const required = ${JSON.stringify(REQUIRED_WINDOWS_TESTS)};
Object.defineProperty(process, "platform", { value: scenario.startsWith("non-windows") ? "linux" : "win32" });
Object.defineProperty(process, "arch", { value: "x64" });
fs.writeFileSync = (path, data, ...rest) => {
  if (String(path).includes("dsm-rust-log-")) {
    if (scenario === "missing-log") return;
    const log = JSON.parse(data);
    if (scenario === "tampered-counts") log.rust.counts.passed += 1;
    if (scenario === "tampered-coverage") log.rust.coverage.pop();
    if (scenario === "tampered-required") log.requiredTests.pop();
    if (scenario === "tampered-platform") log.platform = "linux";
    if (scenario === "tampered-arch") log.arch = "arm64";
    if (scenario === "tampered-scope") log.scope = "deepseek-account";
    if (scenario === "tampered-command") log.rust.args = ["test", "--lib"];
    if (scenario === "tampered-output") log.rust.stdout = "";
    if (scenario === "legacy-log") log.schemaVersion = 2;
    data = JSON.stringify(log);
  }
  return originalWrite(path, data, ...rest);
};
const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
const libtest = (names, options = {}) => {
  const failed = options.failed ?? 0;
  const ignored = options.ignored ?? 0;
  const passed = names.length - failed - ignored;
  const rows = names.map((name, i) => "test " + name + " ... " + (i < failed ? "FAILED" : i < failed + ignored ? "ignored" : "ok")).join("\\n");
  return rows + "\\n\\ntest result: " + (failed ? "FAILED" : "ok") + ". " + passed + " passed; " + failed + " failed; " + ignored + " ignored; 0 measured; 0 filtered out; finished in 0.01s\\n";
};
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath || command === "node") return originalSpawn(command, args, options);
  if (command === "git") {
    if (args[0] === "status") return ok("");
    return ok(args.includes("--abbrev-ref") ? "fixture-branch" : "a".repeat(40));
  }
  if (args.includes("--version")) return ok("fixture-tool-version");
  if (command === "cargo" && args[0] === "test") {
    if (scenario === "tool-error") return { ...ok(), status: null, error: new Error("synthetic spawn failure") };
    if (scenario === "rust-fail") return { ...ok(libtest(required, { failed: 1 })), status: 101 };
    if (scenario === "zero-tests") return ok(libtest([]));
    if (scenario === "ignored-only") return ok(libtest(required, { ignored: required.length }));
    if (scenario === "ignored-required") return ok(libtest(required, { ignored: 1 }));
    if (scenario === "missing-windows-test") return ok(libtest(required.slice(0, -1)));
    if (scenario === "non-windows") return ok(libtest(["portable::tests::real_development_test"]));
    let stdout = libtest(required);
    if (scenario === "captured-marker") stdout += "NOT RUN: synthetic unavailable scenario\\n";
    if (scenario === "chinese-skip" || scenario === "non-windows-chinese-skip") stdout += "跳过：DPAPI 仅在 Windows 可用，本测试未验证真实加密\\n";
    if (scenario === "summary-only") stdout = stdout.slice(stdout.indexOf("test result:"));
    if (scenario === "count-mismatch") stdout = stdout.replace(required.length + " passed;", (required.length + 1) + " passed;");
    if (scenario === "duplicate-row") stdout = "test " + required[0] + " ... ok\\n" + stdout;
    if (scenario === "filtered-tests") stdout = stdout.replace("0 filtered out;", "1 filtered out;");
    if (scenario === "crlf") stdout = stdout.replaceAll("\\n", "\\r\\n");
    if (scenario === "stderr-marker") return { ...ok(stdout), stderr: "NOT RUN: synthetic stderr omission\\n" };
    return ok(stdout);
  }
  if (command === "npm" && args.includes("test:components")) {
    if (scenario === "component-fail") return { ...ok(), status: 1 };
    if (scenario === "component-no-counts") return ok("completed without test evidence");
    if (scenario === "component-zero-tests") return ok("# tests 0\\n# pass 0\\n# fail 0\\n# skipped 0\\n");
  }
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
    'import { test } from "node:test"; test("fixture avoids recursive harness", () => {});\n',
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

for (const scenario of ["pass", "crlf"]) {
  test(`Rust gate requires named Windows executions and matching totals: ${scenario}`, () => {
    const result = execute("run-rust-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 0);
    assert.equal(log.schemaVersion, 3);
    assert.equal(log.scope, "deepseek-windows-release");
    assert.equal(log.platform, "win32");
    assert.equal(log.verdict, "PASS");
    assert.ok(REQUIRED_WINDOWS_TESTS.length >= 11);
    assert.equal(log.rust.counts.executed, REQUIRED_WINDOWS_TESTS.length);
    assert.deepEqual(log.requiredTests, REQUIRED_WINDOWS_TESTS);
    assert.ok(log.rust.coverage.every((item) => item.status === "PASS"));
    assert.ok(log.rust.args.includes("--show-output"));
    assert.ok(log.rust.args.includes("x86_64-pc-windows-msvc"));
    assert.equal(Object.hasOwn(log, "capabilities"), false);
  });
}

const notRunScenarios = [
  "non-windows",
  "non-windows-fake-complete",
  "non-windows-chinese-skip",
  "captured-marker",
  "chinese-skip",
  "stderr-marker",
  "missing-windows-test",
  "ignored-required",
];
for (const scenario of notRunScenarios) {
  test(`Rust gate and release reject missing coverage: ${scenario}`, () => {
    const rust = execute("run-rust-tests.mjs", scenario);
    const log = JSON.parse(rust.report);
    assert.equal(rust.status, 2);
    assert.equal(log.verdict, "NOT RUN");
    assert.equal(log.rust.counts, null);
    assert.ok(log.rust.rawCounts.passed > 0);
    assert.ok(log.rust.coverage.some((item) => item.status === "NOT RUN"));
    const release = execute("release-record.mjs", scenario);
    assert.equal(release.status, 2);
    assert.match(
      release.report,
      /\| cargo test \| NOT RUN \| 2 \|[^\n]*不可解析/,
    );
    assert.doesNotMatch(release.report, /\| cargo test \| PASS/);
    assert.match(release.report, /NOT RUN=1/);
    assert.match(release.report, /发布不放行/);
  });
}

const errorScenarios = [
  "tool-error",
  "zero-tests",
  "ignored-only",
  "summary-only",
  "count-mismatch",
  "duplicate-row",
  "filtered-tests",
];
for (const scenario of errorScenarios) {
  test(`Rust gate rejects invalid execution evidence: ${scenario}`, () => {
    const result = execute("run-rust-tests.mjs", scenario);
    assert.equal(result.status, 4);
    assert.equal(JSON.parse(result.report).verdict, "ERROR");
  });
}

for (const scenario of [
  "rust-fail",
  ...errorScenarios,
  "missing-log",
  "tampered-counts",
  "tampered-coverage",
  "tampered-required",
  "tampered-platform",
  "tampered-arch",
  "tampered-scope",
  "tampered-command",
  "tampered-output",
  "legacy-log",
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

for (const scenario of [
  "component-fail",
  "component-no-counts",
  "component-zero-tests",
]) {
  test(`release: component gate needs actual tests: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    assert.match(result.report, /\| 组件测试 \| (?:FAIL|ERROR)/);
  });
}

test("release: simulated complete Windows result records full coverage, not installer acceptance", () => {
  const result = execute("release-record.mjs", "pass");
  assert.equal(result.status, 0);
  assert.match(result.report, /\| cargo test \| PASS \| 0 \|/);
  assert.match(result.report, /FAIL=0；NOT RUN=0/);
  assert.match(result.report, /门禁命令全部通过，但安装包未校验/);
  assert.match(result.report, /"scope": "deepseek-windows-release"/);
  for (const name of REQUIRED_WINDOWS_TESTS)
    assert.ok(result.report.includes(name));
});

test("verify uses the shared Windows gate and mandatory component/fault gates", () => {
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

test("component runner bundles every retained regression suite and executes all outputs", () => {
  const source = readFileSync(
    join(root, "scripts", "test-settings-components.mjs"),
    "utf8",
  );
  for (const name of [
    "settings-transactions.test",
    "desktop-ui-regressions.test",
    "usage-fidelity.test",
    "history-lifecycle.test",
    "chart-accessibility.test",
  ]) {
    assert.ok(source.includes(`"${name}"`));
    assert.match(
      readFileSync(join(root, "tests", `${name}.tsx`), "utf8"),
      /\btest\(/,
    );
  }
  assert.match(source, /entryPoints: entries\.map/);
  assert.match(source, /\["--test", \.\.\.outfiles\]/);
});

test("DPAPI early returns use the machine-readable marker", () => {
  for (const file of ["credentials.rs", "config.rs"]) {
    const source = readFileSync(join(root, "src-tauri", "src", file), "utf8");
    assert.match(source, /eprintln!\("NOT RUN: DPAPI/);
    assert.doesNotMatch(source, /eprintln!\("跳过[：:]/);
  }
});

test("release and build do not invoke or package the removed Agent engine", () => {
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
