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
import { REQUIRED_VERSION_SUITES } from "../run-release-version-tests.mjs";

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
const versionSuites = ${JSON.stringify(REQUIRED_VERSION_SUITES)};
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
  if (String(path).includes("dsm-version-log-")) {
    if (scenario === "version-missing-log") return;
    const log = JSON.parse(data);
    if (scenario === "version-tampered-counts") log.powershell.counts.passed += 1;
    if (scenario === "version-tampered-output") log.powershell.stdout = "";
    if (scenario === "version-tampered-exit") log.powershell.code = 17;
    if (scenario === "version-tampered-command") log.powershell.args = ["-Command", "exit 0"];
    if (scenario === "version-tampered-required") log.requiredSuites.pop();
    if (scenario === "version-tampered-coverage") log.powershell.coverage.pop();
    if (scenario === "version-tampered-platform") log.platform = "linux";
    if (scenario === "version-tampered-arch") log.arch = "arm64";
    if (scenario === "version-tampered-scope") log.scope = "installer-acceptance";
    if (scenario === "version-legacy-log") log.schemaVersion = 0;
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
const versionEvidence = () => {
  let suites = scenario === "version-missing-suite" ? versionSuites.slice(0, -1) : versionSuites;
  if (scenario === "version-zero-tests") suites = [];
  const rows = suites.map((suite, i) => ({ index: i + 1, suite, label: "synthetic " + suite, status: scenario === "version-failed-assertion" && i === 0 ? "FAIL" : "PASS" }));
  if (scenario === "version-row-index") rows[0].index = 9;
  const summary = {
    schemaVersion: 1,
    scope: "release-version-pure-functions",
    completed: scenario !== "version-incomplete",
    assertions: rows.length,
    passed: rows.filter(row => row.status === "PASS").length,
    failed: rows.filter(row => row.status === "FAIL").length,
  };
  if (scenario === "version-count-mismatch") summary.assertions += 1;
  const end = "RELEASE_VERSION_SUMMARY " + JSON.stringify(summary) + "\\n";
  let text = rows.map(row => "RELEASE_VERSION_ASSERT " + JSON.stringify(row) + "\\n").join("");
  if (scenario === "version-summary-only") text = "";
  if (scenario !== "version-missing-summary") text += end;
  if (scenario === "version-duplicate-summary") text += end;
  if (scenario === "version-malformed-row") text = text.replace(/RELEASE_VERSION_ASSERT [^\\n]+/, "RELEASE_VERSION_ASSERT {broken}");
  if (scenario === "version-malformed-summary") text = text.replace(/RELEASE_VERSION_SUMMARY [^\\n]+/, "RELEASE_VERSION_SUMMARY null");
  if (scenario === "version-legacy-output") text = "PASS：纯函数回归完成。未执行发行校验主流程或真实安装验收。\\n";
  if (scenario === "version-no-output") text = "";
  if (scenario === "version-marker") text = "NOT RUN: synthetic missing assertion\\n" + text;
  if (scenario === "version-chinese-skip") text = "跳过：纯函数断言没有执行\\n" + text;
  if (scenario === "crlf") text = text.replaceAll("\\n", "\\r\\n");
  return text;
};
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath || command === "node") return originalSpawn(command, args, options);
  if (command === "git") {
    if (args[0] === "status") return ok("");
    return ok(args.includes("--abbrev-ref") ? "fixture-branch" : "a".repeat(40));
  }
  if (args.includes("--version")) return ok("fixture-tool-version");
  if (command === "pwsh") {
    if (scenario === "version-tool-error") return { ...ok(), status: null, error: new Error("synthetic pwsh ENOENT") };
    if (scenario === "version-missing-script") return { ...ok(), status: 64, stderr: "synthetic script not found\\n" };
    if (scenario === "version-signal") return { ...ok(), status: null, signal: "SIGTERM" };
    if (scenario === "version-fail") return { ...ok(versionEvidence()), status: 17, stderr: "synthetic assertion failure\\n" };
    if (scenario === "version-stderr-evidence") return { ...ok(), stderr: versionEvidence() };
    if (scenario === "version-stderr-marker") return { ...ok(versionEvidence()), stderr: "NOT RUN: synthetic missing assertion\\n" };
    return ok(versionEvidence());
  }
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
  for (const file of [
    "release-record.mjs",
    "run-rust-tests.mjs",
    "run-release-version-tests.mjs",
  ])
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
      entry === "release-record.mjs" ? "report.md" : "gate.json",
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
  assert.match(
    result.report,
    /\| 发行版本纯函数回归 \| PASS \| 0 \|[^\n]*assertions=3 executed=3/,
  );
  assert.match(result.report, /FAIL=0；NOT RUN=0/);
  assert.match(result.report, /门禁命令全部通过，但安装包未校验/);
  assert.match(result.report, /"scope": "deepseek-windows-release"/);
  for (const name of REQUIRED_WINDOWS_TESTS)
    assert.ok(result.report.includes(name));
});

for (const scenario of ["pass", "crlf", "non-windows"]) {
  test(`pure version gate records assertions without claiming installer coverage: ${scenario}`, () => {
    const result = execute("run-release-version-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 0);
    assert.equal(log.scope, "release-version-pure-functions");
    assert.equal(log.powershell.code, 0);
    assert.equal(log.powershell.counts.unit, "assertions");
    assert.equal(
      log.powershell.counts.executed,
      REQUIRED_VERSION_SUITES.length,
    );
    assert.deepEqual(log.requiredSuites, REQUIRED_VERSION_SUITES);
    assert.ok(log.powershell.coverage.every((item) => item.executed > 0));
    assert.deepEqual(log.powershell.args, [
      "-NoProfile",
      "-File",
      "scripts/verify-release-version.static-tests.ps1",
    ]);
  });
}

const versionErrorScenarios = [
  "version-tool-error",
  "version-signal",
  "version-no-output",
  "version-legacy-output",
  "version-zero-tests",
  "version-summary-only",
  "version-missing-summary",
  "version-duplicate-summary",
  "version-malformed-row",
  "version-malformed-summary",
  "version-row-index",
  "version-count-mismatch",
  "version-failed-assertion",
  "version-missing-suite",
  "version-incomplete",
  "version-stderr-evidence",
];
for (const scenario of versionErrorScenarios) {
  test(`pure version gate rejects missing or inconsistent execution: ${scenario}`, () => {
    const result = execute("run-release-version-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 4);
    assert.equal(log.verdict, "ERROR");
    assert.equal(log.powershell.counts, null);
    if (["version-tool-error", "version-signal"].includes(scenario))
      assert.equal(log.powershell.code, null);
  });
}

for (const [scenario, exitCode] of [
  ["version-fail", 17],
  ["version-missing-script", 64],
]) {
  test(`pure version gate preserves native failure before output claims: ${scenario}`, () => {
    const result = execute("run-release-version-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 1);
    assert.equal(log.verdict, "FAIL");
    assert.equal(log.powershell.code, exitCode);
    assert.equal(log.powershell.counts, null);
    assert.ok(log.powershell.stderr.length > 0);
    const release = execute("release-record.mjs", scenario);
    assert.equal(release.status, 1);
    assert.match(release.report, /\| 发行版本纯函数回归 \| FAIL \| 1 \|/);
    assert.ok(release.report.includes(`"code": ${exitCode}`));
    assert.match(
      release.report,
      /synthetic (?:assertion failure|script not found)/,
    );
  });
}

for (const scenario of [
  ...versionErrorScenarios,
  "version-missing-log",
  "version-tampered-counts",
  "version-tampered-output",
  "version-tampered-exit",
  "version-tampered-command",
  "version-tampered-required",
  "version-tampered-coverage",
  "version-tampered-platform",
  "version-tampered-arch",
  "version-tampered-scope",
  "version-legacy-log",
]) {
  test(`release requires pure version execution evidence: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    assert.match(result.report, /\| 发行版本纯函数回归 \| ERROR/);
    assert.doesNotMatch(result.report, /\| 发行版本纯函数回归 \| PASS/);
    assert.match(result.report, /❌ FAIL/);
  });
}

for (const scenario of [
  "version-marker",
  "version-chinese-skip",
  "version-stderr-marker",
]) {
  test(`both gates retain explicit unexecuted pure-version markers: ${scenario}`, () => {
    const version = execute("run-release-version-tests.mjs", scenario);
    assert.equal(version.status, 2);
    assert.equal(JSON.parse(version.report).verdict, "NOT RUN");
    const release = execute("release-record.mjs", scenario);
    assert.equal(release.status, 2);
    assert.match(release.report, /\| 发行版本纯函数回归 \| NOT RUN \| 2 \|/);
    assert.match(release.report, /发布不放行/);
  });
}

test("verify uses the shared Windows gate and mandatory component/fault gates", () => {
  const source = readFileSync(join(root, "scripts", "verify.ps1"), "utf8");
  assert.match(
    source,
    /Invoke-Check[^\n]+node[^\n]+scripts\/run-rust-tests\.mjs/,
  );
  assert.match(source, /run-rust-tests\.mjs[^\n]+-ScenarioGate/);
  assert.match(
    source,
    /Invoke-Check[^\n]+node[^\n]+run-release-version-tests\.mjs[^\n]+-ScenarioGate/,
  );
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(source, /Invoke-Check[^\n]+test:components/);
  assert.match(source, /Invoke-Check[^\n]+release-gates\.test\.mjs/);
  assert.doesNotMatch(source, /Invoke-Check 'cargo test' 'cargo'/);
  assert.doesNotMatch(source, /run-integration-tests|local-usage:prepare/);
});

test("pure version assertions preserve failure propagation and completion protocol", () => {
  const source = readFileSync(
    join(root, "scripts", "verify-release-version.static-tests.ps1"),
    "utf8",
  );
  assert.match(source, /\$script:AssertionCount \+= 1/);
  assert.match(source, /RELEASE_VERSION_ASSERT \$row/);
  assert.match(source, /if \(-not \$passed\) \{ throw/);
  assert.match(source, /\$script:AssertionCount -le 0/);
  assert.match(source, /RELEASE_VERSION_SUMMARY \$summary/);
  for (const suite of REQUIRED_VERSION_SUITES)
    assert.ok(source.includes(`$script:AssertionSuite = '${suite}'`));
  assert.match(source, /Parser\]::ParseFile/);
  assert.match(source, /\$matches\.Count -ne 1/);
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
