#!/usr/bin/env node
// Shared Rust gate for verify/release. Capability probes are separate from libtest:
// a missing prerequisite is NOT RUN, never a successful test assertion.
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function probeLinks() {
  let dir;
  const results = [];
  const kinds =
    process.platform === "win32"
      ? ["file", "dir", "junction"]
      : ["file", "dir"];
  try {
    dir = mkdtempSync(join(tmpdir(), "dsm-link-probe-"));
    const targetFile = join(dir, "target.txt");
    const targetDir = join(dir, "target-dir");
    writeFileSync(targetFile, "dsm-link-probe");
    mkdirSync(targetDir);
    for (const kind of kinds) {
      try {
        const target = kind === "file" ? targetFile : targetDir;
        const link = join(dir, `link-${kind}`);
        symlinkSync(target, link, kind);
        if (
          !lstatSync(link).isSymbolicLink() ||
          realpathSync(link) !== realpathSync(target)
        ) {
          throw new Error("link did not resolve to the probe target");
        }
        if (
          kind === "file" &&
          readFileSync(link, "utf8") !== "dsm-link-probe"
        ) {
          throw new Error("file link was not readable");
        }
        results.push({ id: kind, verdict: "PASS" });
      } catch (error) {
        results.push({ id: kind, verdict: "NOT RUN", reason: String(error) });
      }
    }
  } catch (error) {
    for (const kind of kinds)
      results.push({ id: kind, verdict: "NOT RUN", reason: String(error) });
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        results.push({ id: "cleanup", verdict: "FAIL", reason: String(error) });
      }
    }
  }
  return results;
}

export function runRustGate() {
  const capabilities = probeLinks();
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
  const missingCapability = capabilities.some(
    (item) => item.verdict === "NOT RUN",
  );
  // Missing prerequisites or legacy early-return markers make claimed pass counts untrustworthy.
  // Preserve raw output, but do not promote its libtest PASS count to evidence.
  const counts = markers || missingCapability ? null : parseCounts(output);
  const verdict =
    result.error || result.signal || result.status === null
      ? "ERROR"
      : result.status !== 0
        ? "FAIL"
        : markers || missingCapability
          ? "NOT RUN"
          : !counts ||
              counts.tests === 0 ||
              counts.passed === 0 ||
              counts.failed > 0
            ? "ERROR"
            : "PASS";
  const rust = {
    command: "cargo",
    args: cargoArgs,
    code: result.status,
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
    stdout,
    stderr,
    verdict,
    counts,
  };
  const all = [...capabilities.map((item) => item.verdict), verdict];
  const overall = all.includes("ERROR")
    ? "ERROR"
    : all.includes("FAIL")
      ? "FAIL"
      : all.includes("NOT RUN")
        ? "NOT RUN"
        : "PASS";
  return {
    schemaVersion: 1,
    platform: process.platform,
    capabilities,
    rust,
    verdict: overall,
  };
}

// The release record must fail closed if its structured evidence is absent,
// malformed, or disagrees with the child process exit status.
export function readRustGateLog(path, code) {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"));
    const expected = { PASS: 0, FAIL: 1, "NOT RUN": 2, ERROR: 4 };
    if (log.schemaVersion !== 1 || expected[log.verdict] !== code) return null;
    const kinds =
      log.platform === "win32" ? ["file", "dir", "junction"] : ["file", "dir"];
    if (!Array.isArray(log.capabilities) || !log.rust) return null;
    if (
      !kinds.every(
        (id) => log.capabilities.filter((item) => item.id === id).length === 1,
      )
    )
      return null;
    if (
      !log.capabilities.every((item) =>
        ["PASS", "FAIL", "NOT RUN"].includes(item.verdict),
      )
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
    const all = [...log.capabilities.map((item) => item.verdict), rust.verdict];
    const verdict = all.includes("ERROR")
      ? "ERROR"
      : all.includes("FAIL")
        ? "FAIL"
        : all.includes("NOT RUN")
          ? "NOT RUN"
          : "PASS";
    return verdict === log.verdict ? log : null;
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
  for (const item of log.capabilities)
    console.log(
      `${item.verdict}: link capability ${item.id}${item.reason ? `: ${item.reason}` : ""}`,
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
