#!/usr/bin/env node
// Shared DeepSeek Rust gate for verify/release. Removed Agent directory/link
// capabilities are no longer prerequisites and are never reported as passing.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoArgs = [
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--lib",
  "--",
  "--show-output",
];

export const hasNotRun = (text) => /NOT RUN[：:]/.test(String(text));

function parseCounts(output) {
  const match =
    /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/m.exec(
      output,
    );
  if (!match) return null;
  const [passed, failed, ignored] = match.slice(1).map(Number);
  return {
    passed,
    failed,
    ignored,
    tests: passed + failed + ignored,
    parseable: true,
  };
}

export function runRustGate() {
  const result = spawnSync("cargo", cargoArgs, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const output = `${stdout}\n${stderr}`;
  const markers = hasNotRun(output);
  // Explicitly missing scenarios invalidate the claimed libtest pass count.
  const counts = markers ? null : parseCounts(output);
  const verdict =
    result.error || result.signal || result.status === null
      ? "ERROR"
      : result.status !== 0
        ? "FAIL"
        : markers
          ? "NOT RUN"
          : !counts ||
              counts.tests === 0 ||
              counts.passed === 0 ||
              counts.failed > 0
            ? "ERROR"
            : "PASS";
  return {
    schemaVersion: 2,
    scope: "deepseek-account",
    platform: process.platform,
    rust: {
      command: "cargo",
      args: cargoArgs,
      code: result.status,
      signal: result.signal ?? null,
      error: result.error ? String(result.error) : null,
      stdout,
      stderr,
      verdict,
      counts,
    },
    verdict,
  };
}

// Fail closed on absent/malformed evidence, stale Agent-era logs, or mismatched
// exit status. A successful command with no executed assertions is not a pass.
export function readRustGateLog(path, code) {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"));
    const expected = { PASS: 0, FAIL: 1, "NOT RUN": 2, ERROR: 4 };
    if (
      log.schemaVersion !== 2 ||
      log.scope !== "deepseek-account" ||
      expected[log.verdict] !== code ||
      !log.rust ||
      log.verdict !== log.rust.verdict
    )
      return null;
    const rust = log.rust;
    if (!Object.hasOwn(expected, rust.verdict)) return null;
    if (
      rust.verdict === "PASS" &&
      (rust.code !== 0 ||
        rust.error ||
        rust.signal ||
        hasNotRun(`${rust.stdout}\n${rust.stderr}`))
    )
      return null;
    if (rust.counts !== null) {
      if (
        !rust.counts ||
        !["passed", "failed", "ignored", "tests"].every(
          (key) =>
            Number.isSafeInteger(rust.counts[key]) && rust.counts[key] >= 0,
        )
      )
        return null;
      if (
        rust.counts.tests !==
        rust.counts.passed + rust.counts.failed + rust.counts.ignored
      )
        return null;
    }
    if (
      rust.verdict === "PASS" &&
      (!rust.counts || rust.counts.passed === 0 || rust.counts.failed !== 0)
    )
      return null;
    if (rust.verdict === "NOT RUN" && rust.counts !== null) return null;
    return log;
  } catch {
    return null;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const log = runRustGate();
  const index = process.argv.indexOf("--log-file");
  if (index >= 0)
    writeFileSync(
      resolve(process.argv[index + 1]),
      JSON.stringify(log, null, 2),
    );
  console.log(
    `Rust gate platform: ${log.platform} (Windows-only assertions require Windows)`,
  );
  process.stdout.write(log.rust.stdout);
  process.stderr.write(log.rust.stderr);
  if (log.rust.error) console.error(log.rust.error);
  console.log(`Rust gate: ${log.verdict}`);
  if (log.rust.counts === null)
    console.log(
      "Verified Rust assertion counts: unavailable; raw libtest pass totals are not accepted.",
    );
  process.exitCode = { PASS: 0, FAIL: 1, "NOT RUN": 2, ERROR: 4 }[log.verdict];
}
