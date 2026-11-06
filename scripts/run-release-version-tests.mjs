#!/usr/bin/env node
// The pure-function suite is a required source gate, never installer acceptance.
// Both full gates use this entry point and validate actual assertion completion.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hasNotRun } from "./run-rust-tests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT = { PASS: 0, FAIL: 1, "NOT RUN": 2, ERROR: 4 };
const scope = "release-version-pure-functions";
const args = [
  "-NoProfile",
  "-File",
  "scripts/verify-release-version.static-tests.ps1",
];
export const REQUIRED_VERSION_SUITES = ["filename", "pe-header", "pe-version"];

function parseExecution(stdout) {
  const rows = [];
  const summaries = [];
  let malformed = false;
  for (const line of stdout.split(/\r?\n/)) {
    for (const [prefix, values] of [
      ["RELEASE_VERSION_ASSERT ", rows],
      ["RELEASE_VERSION_SUMMARY ", summaries],
    ]) {
      if (!line.startsWith(prefix)) continue;
      try {
        values.push(JSON.parse(line.slice(prefix.length)));
      } catch {
        malformed = true;
      }
    }
  }
  const summary = summaries[0];
  const passed = rows.filter((row) => row?.status === "PASS").length;
  const failed = rows.filter((row) => row?.status === "FAIL").length;
  const valid =
    !malformed &&
    summaries.length === 1 &&
    rows.length > 0 &&
    rows.every(
      (row, index) =>
        row?.index === index + 1 &&
        REQUIRED_VERSION_SUITES.includes(row.suite) &&
        typeof row.label === "string" &&
        row.label.trim().length > 0 &&
        ["PASS", "FAIL"].includes(row.status),
    ) &&
    summary?.schemaVersion === 1 &&
    summary.scope === scope &&
    summary.completed === true &&
    Number.isSafeInteger(summary.assertions) &&
    summary.assertions === rows.length &&
    summary.passed === passed &&
    summary.failed === failed &&
    stdout
      .trimEnd()
      .split(/\r?\n/)
      .at(-1)
      .startsWith("RELEASE_VERSION_SUMMARY ");
  return { rows, summary: summary ?? null, valid, passed, failed };
}

function evaluate(result) {
  const execution = parseExecution(result.stdout);
  const coverage = REQUIRED_VERSION_SUITES.map((suite) => ({
    suite,
    executed: execution.rows.filter((row) => row?.suite === suite).length,
  }));
  const reasons = [];
  if (!execution.valid || coverage.some((item) => item.executed === 0))
    reasons.push(
      "ERROR: require sequential assertion rows, nonzero execution in all three suites, and one matching completion summary.",
    );
  if (hasNotRun(`${result.stdout}\n${result.stderr}`))
    reasons.push("NOT RUN: output contains an unexecuted-scenario marker.");
  const verdict =
    result.error || result.signal || result.code === null
      ? "ERROR"
      : result.code !== 0
        ? "FAIL"
        : !execution.valid ||
            !execution.passed ||
            execution.failed > 0 ||
            coverage.some((item) => item.executed === 0)
          ? "ERROR"
          : reasons.length
            ? "NOT RUN"
            : "PASS";
  return {
    verdict,
    reasons,
    coverage,
    assertions: execution.rows,
    summary: execution.summary,
    // These are assertion counts, not test-function or installer-test counts.
    counts:
      verdict === "PASS"
        ? {
            unit: "assertions",
            tests: execution.rows.length,
            executed: execution.rows.length,
            passed: execution.passed,
            failed: execution.failed,
            ignored: 0,
            parseable: true,
          }
        : null,
  };
}

export function runReleaseVersionGate() {
  const result = spawnSync("pwsh", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  const powershell = {
    command: "pwsh",
    args: [...args],
    code: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
  Object.assign(powershell, evaluate(powershell));
  return {
    schemaVersion: 1,
    scope,
    platform: process.platform,
    arch: process.arch,
    requiredSuites: [...REQUIRED_VERSION_SUITES],
    powershell,
    verdict: powershell.verdict,
  };
}

// Recompute from the recorded native exit and unmodified output. Legacy PASS
// prose, missing logs, stale schemas and declared/tampered counts fail closed.
export function readReleaseVersionGateLog(path, code) {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"));
    const result = log.powershell;
    if (
      log.schemaVersion !== 1 ||
      log.scope !== scope ||
      log.platform !== process.platform ||
      log.arch !== process.arch ||
      !isDeepStrictEqual(log.requiredSuites, REQUIRED_VERSION_SUITES) ||
      !Object.hasOwn(EXIT, log.verdict) ||
      EXIT[log.verdict] !== code ||
      result?.verdict !== log.verdict ||
      result.command !== "pwsh" ||
      !isDeepStrictEqual(result.args, args) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !(
        result.code === null ||
        (Number.isInteger(result.code) && result.code >= 0)
      ) ||
      !(result.error === null || typeof result.error === "string") ||
      !(result.signal === null || typeof result.signal === "string")
    )
      return null;
    const expected = evaluate(result);
    if (
      !Object.keys(expected).every((key) =>
        isDeepStrictEqual(result[key], expected[key]),
      )
    )
      return null;
    return log;
  } catch {
    return null;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const log = runReleaseVersionGate();
  const index = process.argv.indexOf("--log-file");
  if (index >= 0)
    writeFileSync(
      resolve(process.argv[index + 1]),
      JSON.stringify(log, null, 2),
    );
  process.stdout.write(log.powershell.stdout);
  process.stderr.write(log.powershell.stderr);
  if (log.powershell.error) console.error(log.powershell.error);
  for (const reason of log.powershell.reasons) console.log(reason);
  console.log(`Release version pure-function gate: ${log.verdict}`);
  process.exitCode = EXIT[log.verdict];
}
