import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
const originalRead = fs.readFileSync;
const originalAppend = fs.appendFileSync;
const originalRename = fs.renameSync;
const originalRemove = fs.rmSync;
const originalLink = fs.linkSync;
const scenario = process.env.DSM_GATE_TEST_SCENARIO;
const reportScenario = process.env.DSM_GATE_TEST_REPORT_FAILURE || scenario;
const required = ${JSON.stringify(REQUIRED_WINDOWS_TESTS)};
const versionSuites = ${JSON.stringify(REQUIRED_VERSION_SUITES)};
Object.defineProperty(process, "platform", { value: scenario.startsWith("non-windows") ? "linux" : "win32" });
Object.defineProperty(process, "arch", { value: "x64" });
fs.writeFileSync = (path, data, ...rest) => {
  const source = String(path).includes("dsm-rust-log-") ? "rust" : String(path).includes("dsm-version-log-") ? "version" : null;
  // Exclusive, private reservation is not a child-produced gate log.
  if (source && data === "" && rest[0]?.flag === "wx") return originalWrite(path, data, ...rest);
  if (String(path).includes("dsm-rust-log-")) {
    if (scenario === "missing-log") { originalRemove(path, { force: true }); return; }
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
    if (scenario === "corrupt-log") data = '{"verdict":"PASS",broken\\n</details>\\n# INJECTED_UNTRUSTED_MARKDOWN';
    if (scenario === "invalid-utf8-log") data = Buffer.from([0x7b, 0xff, 0x00, 0x7d]);
    if (scenario === "empty-log") data = Buffer.alloc(0);
  }
  if (String(path).includes("dsm-version-log-")) {
    if (scenario === "version-missing-log") { originalRemove(path, { force: true }); return; }
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
    if (scenario === "version-tampered-runtime") log.powershell.runtime.version = "99.0.0";
    if (scenario === "version-tampered-runtime-valid") log.powershell.runtimeValid = false;
    if (scenario === "version-legacy-log") log.schemaVersion = 1;
    data = JSON.stringify(log);
    if (scenario === "version-corrupt-log") data = '{"verdict":"PASS",broken\\n</details>\\n# INJECTED_UNTRUSTED_MARKDOWN';
    if (scenario === "version-invalid-utf8-log") data = Buffer.from([0x7b, 0xff, 0x00, 0x7d]);
    if (scenario === "version-empty-log") data = Buffer.alloc(0);
  }
  if (source) originalAppend(process.env.DSM_GATE_TEST_DIR + "/gate-sources.jsonl", JSON.stringify({ source, path: String(path), bytes: Buffer.from(data).toString("base64") }) + "\\n");
  if (String(path).endsWith("report.md")) {
    if (reportScenario === "report-existing-output") {
      originalWrite(path, "pre-existing report must remain unchanged", { flag: "wx", mode: 0o600 });
    }
    if (reportScenario === "report-source-alias") {
      const sources = originalRead(process.env.DSM_GATE_TEST_DIR + "/gate-sources.jsonl", "utf8").trim().split("\\n").map(line => JSON.parse(line));
      const original = sources.find(item => item.source === process.env.DSM_GATE_TEST_REPORT_ALIAS_SOURCE);
      // Install a hardlink at the output path immediately before the real write.
      // A truncating write would destroy the original despite having no rm call.
      originalLink(original.path, path);
    }
    if (reportScenario === "report-write-failure") throw new Error("synthetic report write failure");
    if (["report-partial-write", "report-truncated-write"].includes(reportScenario)) {
      originalWrite(path, String(data).slice(0, 80), ...rest);
      if (reportScenario === "report-partial-write") throw new Error("synthetic partial report write");
      return;
    }
    if (reportScenario === "report-flush-failure") {
      originalWrite(path, data, ...rest);
      throw new Error("synthetic flush failure");
    }
  }
  return originalWrite(path, data, ...rest);
};
const changedSources = new Set();
const replacementSnapshots = new Map();
fs.readFileSync = (path, ...rest) => {
  if ((scenario === "unreadable-log" && String(path).includes("dsm-rust-log-")) ||
      (scenario === "version-unreadable-log" && String(path).includes("dsm-version-log-")) ||
      (reportScenario === "report-readback-failure" && String(path).endsWith("report.md"))) {
    const error = new Error("synthetic read failure"); error.code = "EACCES"; throw error;
  }
  const source = String(path).includes("dsm-rust-log-") ? "rust" : String(path).includes("dsm-version-log-") ? "version" : null;
  const replaceAfterRead = source && source === process.env.DSM_GATE_TEST_REPLACE_AFTER_READ;
  // Model a competing writer around EVERY source read, including the former
  // final comparison read immediately before rmSync. Restore A before a reread,
  // then atomically replace the path with B after the actual read returns A.
  // This deterministic A -> B -> A -> B schedule defeats repeated comparisons;
  // the fixed entry reads once and retains B, while the old entry deletes B.
  if (replaceAfterRead && replacementSnapshots.has(String(path))) {
    originalWrite(path, replacementSnapshots.get(String(path)));
  }
  const data = originalRead(path, ...rest);
  if (replaceAfterRead) {
    if (!replacementSnapshots.has(String(path))) replacementSnapshots.set(String(path), Buffer.from(data));
    const replacement = Buffer.from("unarchived replacement B: " + source);
    const staged = String(path) + ".replacement";
    originalWrite(staged, replacement, { flag: "wx", mode: 0o600 });
    originalRename(staged, path);
    originalAppend(process.env.DSM_GATE_TEST_DIR + "/gate-read-replacements.jsonl", JSON.stringify({ path: String(path), readBytes: Buffer.from(data).toString("base64"), replacementBytes: replacement.toString("base64") }) + "\\n");
  }
  if (scenario === "changed-log-after-snapshot" && String(path).includes("dsm-rust-log-") && !changedSources.has(String(path))) {
    changedSources.add(String(path));
    originalWrite(path, "changed after snapshot");
  }
  return data;
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
  const runtime = {
    schemaVersion: 1,
    source: "$PSVersionTable.PSVersion",
    version: "7.4.7",
    major: 7,
    minor: 4,
    patch: 7,
    edition: "Core",
    executableSource: "[System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName",
    executable: process.platform === "win32" ? "C:/Program Files/PowerShell/7/pwsh.exe" : "/usr/bin/pwsh",
  };
  if (scenario === "version-runtime-old") { runtime.version = "6.2.7"; runtime.major = 6; runtime.minor = 2; }
  if (scenario === "version-runtime-major-mismatch") runtime.major = 6;
  if (scenario === "version-runtime-version-malformed") runtime.version = "fixture-tool-version";
  if (scenario === "version-runtime-source") runtime.source = "another pwsh --version";
  if (scenario === "version-runtime-executable-source") runtime.executableSource = "PATH guess";
  if (scenario === "version-runtime-executable-missing") delete runtime.executable;
  if (scenario === "version-runtime-executable-relative") runtime.executable = "pwsh";
  if (scenario === "version-runtime-executable-root-relative") runtime.executable = "/pwsh.exe";
  if (scenario === "version-runtime-edition") runtime.edition = "Desktop";
  let header = "RELEASE_VERSION_RUNTIME " + JSON.stringify(runtime) + "\\n";
  if (scenario === "version-runtime-malformed") header = "RELEASE_VERSION_RUNTIME {broken}\\n";
  if (scenario === "version-runtime-missing") header = "";
  if (scenario === "version-runtime-duplicate") header += header;
  let suites = scenario === "version-missing-suite" ? versionSuites.slice(0, -1) : versionSuites;
  if (scenario === "version-byte-suite-absent") suites = versionSuites.filter(suite => suite !== "pe-bytes");
  if (scenario === "version-zero-tests") suites = [];
  const rows = suites.map((suite, i) => ({ index: i + 1, suite, label: "synthetic " + suite, status: (scenario === "version-failed-assertion" && i === 0) || (scenario === "version-byte-failed-assertion" && suite === "pe-bytes") ? "FAIL" : "PASS" }));
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
  if (scenario !== "version-no-output") text = scenario === "version-runtime-late" ? text + header : header + text;
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
    if (scenario === "version-missing-byte-script") return { ...ok(), status: 64, stderr: "synthetic byte script not found\\n" };
    if (scenario === "version-byte-compile-error") return { ...ok(), status: 65, stderr: "synthetic byte parser compile failure\\n" };
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

function execute(
  entry,
  scenario,
  {
    stdoutOnly = false,
    reportFailure = "",
    replaceAfterRead = "",
    reportAliasSource = "",
  } = {},
) {
  const { dir, preload } = fixture();
  try {
    const temp = join(dir, "temporary gate evidence");
    mkdirSync(temp);
    const report = join(
      dir,
      entry === "release-record.mjs" ? "report.md" : "gate.json",
    );
    const flag = entry === "release-record.mjs" ? "--out" : "--log-file";
    const result = spawnSync(
      process.execPath,
      [join(dir, "scripts", entry), ...(stdoutOnly ? [] : [flag, report])],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(preload).href)}`,
          DSM_GATE_TEST_SCENARIO: scenario,
          DSM_GATE_TEST_REPORT_FAILURE: reportFailure,
          DSM_GATE_TEST_REPLACE_AFTER_READ: replaceAfterRead,
          DSM_GATE_TEST_REPORT_ALIAS_SOURCE: reportAliasSource,
          DSM_GATE_TEST_DIR: dir,
          TMPDIR: temp,
          TEMP: temp,
          TMP: temp,
        },
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    const journal = join(dir, "gate-sources.jsonl");
    const sources = existsSync(journal)
      ? readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const source = JSON.parse(line);
            return {
              ...source,
              retained: existsSync(source.path),
              remainingBytes: existsSync(source.path)
                ? readFileSync(source.path).toString("base64")
                : null,
              mode: existsSync(source.path)
                ? statSync(source.path).mode & 0o777
                : null,
              directoryMode: statSync(dirname(source.path)).mode & 0o777,
            };
          })
      : [];
    return {
      ...result,
      report: stdoutOnly
        ? result.stdout
        : existsSync(report)
          ? readFileSync(report, "utf8")
          : null,
      reportMode: existsSync(report) ? statSync(report).mode & 0o777 : null,
      sources,
      replacements: existsSync(join(dir, "gate-read-replacements.jsonl"))
        ? readFileSync(join(dir, "gate-read-replacements.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    };
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
  "corrupt-log",
  "invalid-utf8-log",
  "empty-log",
  "unreadable-log",
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

function archivedSnapshots(report) {
  return [...report.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((value) => value.kind === "untrusted-gate-file-snapshot");
}

for (const [scenario, source] of [
  ["corrupt-log", "rust"],
  ["invalid-utf8-log", "rust"],
  ["empty-log", "rust"],
  ["legacy-log", "rust"],
  ["tampered-counts", "rust"],
  ["tampered-output", "rust"],
  ["version-corrupt-log", "version"],
  ["version-invalid-utf8-log", "version"],
  ["version-empty-log", "version"],
  ["version-legacy-log", "version"],
  ["version-tampered-counts", "version"],
  ["version-tampered-runtime", "version"],
]) {
  test(`rejected evidence is archived losslessly as untrusted bytes: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    const original = result.sources.find((item) => item.source === source);
    assert.ok(original);
    const archived = archivedSnapshots(result.report).find(
      (item) => item.path === original.path,
    );
    assert.ok(archived);
    assert.equal(archived.validation, "rejected");
    assert.equal(archived.encoding, "base64");
    assert.equal(archived.bytes, original.bytes);
    const bytes = Buffer.from(original.bytes, "base64");
    assert.equal(archived.byteLength, bytes.length);
    assert.equal(
      archived.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(original.retained, true);
    assert.equal(original.remainingBytes, original.bytes);
    assert.ok(result.stderr.includes(original.path));
    assert.match(result.stderr, /快照状态=rejected；报告已写入并核对/);
    assert.match(result.report, /不可信诊断数据/);
    assert.doesNotMatch(result.report, /INJECTED_UNTRUSTED_MARKDOWN/);
    assert.match(
      result.report,
      source === "rust"
        ? /\| cargo test \| ERROR/
        : /\| 发行版本纯函数回归 \| ERROR/,
    );
  });
}

for (const scenario of ["missing-log", "version-missing-log"]) {
  test(`missing evidence is distinguished from a rejected file: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario);
    const missing = archivedSnapshots(result.report).find(
      (item) => item.validation === "missing",
    );
    assert.equal(result.status, 1);
    assert.ok(missing);
    assert.equal(missing.bytes, null);
    assert.equal(missing.sha256, null);
    assert.equal(missing.byteLength, null);
    assert.match(missing.readError, /ENOENT/);
  });
}

for (const scenario of ["unreadable-log", "version-unreadable-log"]) {
  test(`unreadable evidence remains on disk and cannot pass: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario);
    assert.equal(result.status, 1);
    const unreadable = archivedSnapshots(result.report).find(
      (item) => item.validation === "unreadable",
    );
    assert.ok(unreadable);
    assert.equal(unreadable.bytes, null);
    const original = result.sources.find(
      (item) => item.path === unreadable.path,
    );
    assert.ok(original.retained);
    assert.equal(original.remainingBytes, original.bytes);
    assert.ok(result.stderr.includes(original.path));
  });
}

for (const reportFailure of [
  "report-write-failure",
  "report-partial-write",
  "report-truncated-write",
  "report-flush-failure",
  "report-readback-failure",
]) {
  for (const scenario of ["pass", "corrupt-log", "version-legacy-log"]) {
    test(`failed archival retains both original files: ${reportFailure}/${scenario}`, () => {
      const result = execute("release-record.mjs", scenario, { reportFailure });
      assert.equal(result.status, 1);
      assert.equal(result.sources.length, 2);
      for (const original of result.sources) {
        assert.equal(original.retained, true);
        assert.equal(original.remainingBytes, original.bytes);
        assert.ok(result.stderr.includes(original.path));
      }
      assert.match(result.stderr, /发行记录未可靠保存/);
    });
  }
}

for (const scenario of ["pass", "corrupt-log", "version-legacy-log"]) {
  test(`stdout alone never authorizes deletion of source evidence: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario, {
      stdoutOnly: true,
    });
    assert.equal(result.status, scenario === "pass" ? 0 : 1);
    assert.equal(archivedSnapshots(result.report).length, 2);
    assert.equal(result.sources.length, 2);
    for (const original of result.sources) {
      assert.equal(original.retained, true);
      assert.equal(original.remainingBytes, original.bytes);
      assert.ok(result.stderr.includes(original.path));
    }
    assert.match(result.stderr, /仅 stdout 输出/);
  });
}

for (const scenario of ["pass", "corrupt-log", "version-corrupt-log"]) {
  test(`an existing report is never truncated: ${scenario}`, () => {
    const result = execute("release-record.mjs", scenario, {
      reportFailure: "report-existing-output",
    });
    assert.equal(result.status, 1);
    assert.equal(result.report, "pre-existing report must remain unchanged");
    assert.match(result.stderr, /EEXIST/);
    assert.match(result.stderr, /--out 必须使用不存在的新路径/);
    for (const original of result.sources) {
      assert.equal(original.retained, true);
      assert.equal(original.remainingBytes, original.bytes);
    }
  });
  for (const source of ["rust", "version"]) {
    test(`an output alias cannot truncate gate evidence: ${scenario}/${source}`, () => {
      const result = execute("release-record.mjs", scenario, {
        reportFailure: "report-source-alias",
        reportAliasSource: source,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /EEXIST/);
      assert.match(result.stderr, /报告未可靠保存/);
      for (const original of result.sources) {
        assert.equal(original.retained, true);
        assert.equal(original.remainingBytes, original.bytes);
      }
      const original = result.sources.find((item) => item.source === source);
      assert.equal(
        result.report,
        Buffer.from(original.bytes, "base64").toString("utf8"),
      );
    });
  }
}

for (const [scenario, source, validation] of [
  ["pass", "rust", "validated"],
  ["pass", "version", "validated"],
  ["corrupt-log", "rust", "rejected"],
  ["version-corrupt-log", "version", "rejected"],
]) {
  test(`replacement B after the final source read is never deleted: ${scenario}/${source}`, () => {
    const result = execute("release-record.mjs", scenario, {
      replaceAfterRead: source,
    });
    assert.equal(result.status, validation === "validated" ? 0 : 1);
    const original = result.sources.find((item) => item.source === source);
    const archived = archivedSnapshots(result.report).find(
      (item) => item.path === original.path,
    );
    assert.equal(archived.validation, validation);
    assert.equal(archived.bytes, original.bytes);
    assert.equal(result.replacements.length, 1);
    const replacement = result.replacements[0];
    assert.equal(replacement.path, original.path);
    assert.equal(replacement.readBytes, original.bytes);
    assert.notEqual(replacement.replacementBytes, archived.bytes);
    assert.equal(original.retained, true);
    assert.equal(original.remainingBytes, replacement.replacementBytes);
    assert.ok(result.stderr.includes(original.path));
    assert.match(result.stderr, /原始门禁日志不自动删除/);
  });
}

test("release keeps private originals on success without deletion APIs", () => {
  const result = execute("release-record.mjs", "pass");
  assert.equal(result.status, 0);
  if (process.platform !== "win32") {
    assert.notEqual(result.reportMode, null);
    assert.equal(result.reportMode & 0o077, 0);
  }
  for (const original of result.sources) {
    assert.equal(original.retained, true);
    assert.equal(original.remainingBytes, original.bytes);
    assert.match(dirname(original.path), /dsm-release-evidence-[^/\\]+$/);
    if (process.platform !== "win32") {
      assert.equal(original.mode & 0o077, 0);
      assert.equal(original.directoryMode & 0o077, 0);
    }
  }
  assert.match(result.stderr, /快照状态=validated；报告已写入并核对/);
  assert.match(result.report, /原始证据保留政策/);
  const source = readFileSync(
    join(root, "scripts", "release-record.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/,
  );
  assert.doesNotMatch(source, /readFileSync\(evidence\.path\)/);
});

test("validation uses the archived snapshot and never deletes a changed source", () => {
  const result = execute("release-record.mjs", "changed-log-after-snapshot");
  const original = result.sources.find((item) => item.source === "rust");
  const archived = archivedSnapshots(result.report).find(
    (item) => item.path === original.path,
  );
  assert.equal(archived.validation, "validated");
  assert.equal(archived.bytes, original.bytes);
  assert.equal(original.retained, true);
  assert.equal(
    Buffer.from(original.remainingBytes, "base64").toString("utf8"),
    "changed after snapshot",
  );
  assert.ok(result.stderr.includes(original.path));
});

test("release: simulated complete Windows result records full coverage, not installer acceptance", () => {
  const result = execute("release-record.mjs", "pass");
  assert.equal(result.status, 0);
  assert.match(result.report, /\| cargo test \| PASS \| 0 \|/);
  assert.match(
    result.report,
    /\| 发行版本纯函数回归 \| PASS \| 0 \|[^\n]*assertions=4 executed=4/,
  );
  assert.match(result.report, /FAIL=0；NOT RUN=0/);
  assert.match(result.report, /门禁命令全部通过，但安装包未校验/);
  assert.match(result.report, /"scope": "deepseek-windows-release"/);
  assert.match(result.report, /"version": "7\.4\.7"/);
  assert.match(result.report, /"source": "\$PSVersionTable\.PSVersion"/);
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((source) => source.retained));
  for (const name of REQUIRED_WINDOWS_TESTS)
    assert.ok(result.report.includes(name));
});

for (const scenario of ["pass", "crlf", "non-windows"]) {
  test(`pure version gate records assertions without claiming installer coverage: ${scenario}`, () => {
    const result = execute("run-release-version-tests.mjs", scenario);
    const log = JSON.parse(result.report);
    assert.equal(result.status, 0);
    assert.equal(log.scope, "release-version-pure-functions");
    assert.equal(log.schemaVersion, 2);
    assert.equal(log.powershell.code, 0);
    assert.equal(log.powershell.counts.unit, "assertions");
    assert.equal(log.powershell.runtimeValid, true);
    assert.equal(log.powershell.runtime.version, "7.4.7");
    assert.equal(log.powershell.runtime.source, "$PSVersionTable.PSVersion");
    assert.match(log.powershell.runtime.executable, /pwsh(?:\.exe)?$/);
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
  "version-runtime-old",
  "version-runtime-major-mismatch",
  "version-runtime-version-malformed",
  "version-runtime-source",
  "version-runtime-executable-source",
  "version-runtime-executable-missing",
  "version-runtime-executable-relative",
  "version-runtime-executable-root-relative",
  "version-runtime-edition",
  "version-runtime-malformed",
  "version-runtime-missing",
  "version-runtime-duplicate",
  "version-runtime-late",
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
  "version-byte-suite-absent",
  "version-byte-failed-assertion",
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
  ["version-missing-byte-script", 64],
  ["version-byte-compile-error", 65],
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
      /synthetic (?:assertion failure|script not found|byte script not found|byte parser compile failure)/,
    );
  });
}

for (const scenario of [
  ...versionErrorScenarios,
  "version-missing-log",
  "version-corrupt-log",
  "version-invalid-utf8-log",
  "version-empty-log",
  "version-unreadable-log",
  "version-tampered-counts",
  "version-tampered-output",
  "version-tampered-exit",
  "version-tampered-command",
  "version-tampered-required",
  "version-tampered-coverage",
  "version-tampered-platform",
  "version-tampered-arch",
  "version-tampered-scope",
  "version-tampered-runtime",
  "version-tampered-runtime-valid",
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
  assert.match(source, /^#requires -Version 7\.0/);
  assert.match(source, /\$runtimeVersion = \$PSVersionTable\.PSVersion/);
  assert.match(source, /\$runtimeVersion\.Major -lt 7/);
  assert.match(source, /GetCurrentProcess\(\)\.MainModule\.FileName/);
  assert.ok(
    source.indexOf("$runtimeVersion.Major -lt 7") <
      source.indexOf("Invoke-Check '版本一致性'"),
  );
});

test("PowerShell known checkout and evidence paths use literal path binding", () => {
  const verify = readFileSync(join(root, "scripts", "verify.ps1"), "utf8");
  assert.match(
    verify,
    /^Set-Location -LiteralPath \(Join-Path \$PSScriptRoot '\.\.'\)/m,
  );
  const release = readFileSync(
    join(root, "scripts", "verify-release.ps1"),
    "utf8",
  );
  assert.match(release, /^Add-Type -LiteralPath @\(/m);
  assert.match(
    release,
    /Get-Content -LiteralPath \(Join-Path \$PSScriptRoot '\.\.' 'package\.json'\)/,
  );
  for (const file of [
    "verify-release-pe-bytes.static-tests.ps1",
    "verify-release-snapshot.windows-tests.ps1",
  ]) {
    const source = readFileSync(join(root, "scripts", file), "utf8");
    assert.match(source, /^Add-Type -LiteralPath \(Join-Path /m);
    assert.doesNotMatch(source, /^Add-Type -Path\b/m);
    // New-Item has no LiteralPath parameter. Its creation paths must not be
    // mechanically changed with the read/navigation commands above.
    assert.doesNotMatch(source, /New-Item[^\n]*-LiteralPath\b/);
  }
  const windows = readFileSync(
    join(root, "scripts", "verify-release-snapshot.windows-tests.ps1"),
    "utf8",
  );
  assert.match(windows, /'run \[ab\]'/);
  assert.match(windows, /'run a'/);
  assert.match(windows, /'no match \[xy\]'/);
  assert.match(windows, /\$decoyPattern\.IsMatch\(\$decoyScriptsDirectory\)/);
  assert.match(windows, /WILDCARD_DECOY_MUST_NOT_BE_COMPILED/);
  assert.match(windows, /'parent with spaces \[ab\]'/);
  assert.match(windows, /'parent with spaces a'/);
  assert.match(windows, /\$locationCommands\[0\]\.Extent\.Text/);
  assert.match(windows, /Invoke-LiteralPathProbe[^\n]+verify-release-pe-bytes/);
  assert.match(windows, /源码声明版本：65535\.65535\.65535/);
  assert.match(windows, /-ScriptDirectory \$unmatchedScriptsDirectory/);
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
  assert.match(
    source,
    /@\(& \(Join-Path \$PSScriptRoot 'verify-release-pe-bytes\.static-tests\.ps1'\) -PassThru\)/,
  );
  assert.match(source, /\$byteAssertions\.Count -le 0/);
  assert.match(source, /\$byteSummary\.kind -cne 'release-pe-byte-summary'/);
  assert.match(source, /\$byteSummary\.assertions -ne \$byteAssertions\.Count/);
  assert.match(source, /\$global:LASTEXITCODE = 0/);
  assert.match(
    source,
    /Get-CompletedPeByteAssertions -Execution \$byteExecution -ExitCode \$byteExitCode/,
  );
  assert.match(source, /if \(\$ExitCode -ne 0\) \{ throw/);
  assert.match(
    source,
    /Assert-Equal \$assertion\.passed \$true \$assertion\.label/,
  );
  assert.ok(
    source.indexOf("verify-release-pe-bytes.static-tests.ps1") <
      source.indexOf("RELEASE_VERSION_SUMMARY $summary"),
  );
  const byteSource = readFileSync(
    join(root, "scripts", "verify-release-pe-bytes.static-tests.ps1"),
    "utf8",
  );
  assert.match(byteSource, /param\(\[switch\]\$PassThru\)/);
  assert.match(byteSource, /kind = 'release-pe-byte-assertion'/);
  assert.match(byteSource, /if \(\$PassThru\) \{ \$record \}/);
  assert.match(byteSource, /if \(\$PassThru\) \{ \$byteSummary \}/);
  assert.match(byteSource, /PeVersionSnapshot\]::Read\(/);
  assert.match(source, /Parser\]::ParseFile/);
  assert.match(source, /\$matches\.Count -ne 1/);
  assert.match(source, /^#requires -Version 7\.0/);
  assert.match(source, /\$runtimeVersion = \$PSVersionTable\.PSVersion/);
  assert.match(source, /\$runtimeVersion\.Major -lt 7/);
  assert.match(source, /GetCurrentProcess\(\)\.MainModule\.FileName/);
  assert.match(source, /RELEASE_VERSION_RUNTIME \$runtime/);
  assert.ok(
    source.indexOf("RELEASE_VERSION_RUNTIME $runtime") <
      source.indexOf("$script:AssertionCount = 0"),
  );
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
    "history-trend-interactions.test",
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
