#!/usr/bin/env node
// Windows release evidence, not a wrapper around cargo's exit code. Non-Windows
// development can run the suite, but cannot satisfy this release gate.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT = { PASS: 0, FAIL: 1, "NOT RUN": 2, ERROR: 4 };
const windowsTargets = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
  ia32: "i686-pc-windows-msvc",
};

// Exact test names are intentional: a removed, renamed, filtered or cfg-excluded
// required test must stop release until its replacement is explicitly reviewed.
export const REQUIRED_WINDOWS_TESTS = [
  "credentials::tests::密文带前缀_明文不带",
  "credentials::tests::加密后能原样解回",
  "credentials::tests::密文里不出现明文",
  "credentials::tests::同一明文两次加密_密文不同",
  "config::tests::落盘的凭据是密文_不是明文",
  "config::tests::明文旧配置_读取后自动迁移为密文",
  "config::tests::已加密配置_重复读取不改变内容",
  "config::tests::n09_same_secret_reencrypted_ciphertext_is_not_an_account_change",
  "config::tests::n05_key_and_token_versions_change_only_after_their_successful_commits",
  "cache_watch::windows_impl::tests::目录不存在时返回_none",
  "cache_watch::windows_impl::tests::目录变更触发信号_无变更则超时",
];

// Keep recognizing legacy Chinese skips so an old early-return test cannot
// silently regain PASS. Require punctuation to avoid matching a test's name.
export const hasNotRun = (text) =>
  /(?:NOT RUN|跳过)\s*[：:]/i.test(String(text));

const cargoArguments = (platform, arch) => [
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--lib",
  ...(platform === "win32" && windowsTargets[arch]
    ? ["--target", windowsTargets[arch]]
    : []),
  "--",
  "--show-output",
  "--format=pretty",
  "--color=never",
  "--test-threads=1",
];

function parseExecution(stdout) {
  const summaries = [
    ...stdout.matchAll(
      /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;[^\r\n]*\r?$/gm,
    ),
  ];
  const executions = [
    ...stdout.matchAll(
      /^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$/gm,
    ),
  ].map((match) => ({ name: match[1], status: match[2] }));
  if (summaries.length !== 1)
    return { rawCounts: null, executions, valid: false };
  const [, outcome, ...parts] = summaries[0];
  const [passed, failed, ignored, measured, filtered] = parts.map(Number);
  const rawCounts = {
    passed,
    failed,
    ignored,
    tests: passed + failed + ignored,
    executed: passed + failed,
    measured,
    filtered,
    parseable: true,
  };
  const valid =
    [passed, failed, ignored, measured, filtered].every(Number.isSafeInteger) &&
    measured === 0 &&
    filtered === 0 &&
    new Set(executions.map((item) => item.name)).size === executions.length &&
    executions.length === rawCounts.tests &&
    executions.filter((item) => item.status === "ok").length === passed &&
    executions.filter((item) => item.status === "FAILED").length === failed &&
    executions.filter((item) => item.status === "ignored").length === ignored &&
    (outcome === "ok") === (failed === 0);
  return { rawCounts, executions, valid };
}

function evaluate(result, platform, arch) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const { rawCounts, executions, valid } = parseExecution(stdout);
  const markers = hasNotRun(`${stdout}\n${stderr}`);
  const supportedPlatform =
    platform === "win32" && Boolean(windowsTargets[arch]);
  const coverage = REQUIRED_WINDOWS_TESTS.map((name) => {
    const execution = executions.find((item) => item.name === name);
    return {
      name,
      status:
        execution?.status === "FAILED"
          ? "FAIL"
          : supportedPlatform && !markers && valid && execution?.status === "ok"
            ? "PASS"
            : "NOT RUN",
    };
  });
  const reasons = [];
  if (!supportedPlatform)
    reasons.push(
      `NOT RUN: Windows MSVC release coverage requires Windows; host=${platform}/${arch}.`,
    );
  if (markers)
    reasons.push(
      "NOT RUN: test output contains an explicit unexecuted-scenario marker.",
    );
  if (rawCounts?.ignored)
    reasons.push(`NOT RUN: ${rawCounts.ignored} test(s) were ignored.`);
  const missing = coverage.filter((item) => item.status === "NOT RUN");
  if (missing.length)
    reasons.push(
      `NOT RUN: ${missing.length} required Windows test(s) lack verified execution.`,
    );
  if (!valid || !rawCounts?.executed)
    reasons.push(
      "ERROR: libtest result rows and one unfiltered summary must agree with nonzero execution.",
    );
  const verdict =
    result.error || result.signal || result.code === null
      ? "ERROR"
      : result.code !== 0
        ? "FAIL"
        : !valid || !rawCounts?.passed || rawCounts.failed > 0
          ? "ERROR"
          : reasons.length
            ? "NOT RUN"
            : "PASS";
  return {
    verdict,
    reasons,
    coverage,
    executions,
    // A returned-early test may be reported as `ok` by libtest. Only the full
    // Windows coverage gate can promote those raw totals to verified counts.
    counts: verdict === "PASS" ? rawCounts : null,
    rawCounts,
  };
}

export function runRustGate() {
  const args = cargoArguments(process.platform, process.arch);
  const result = spawnSync("cargo", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  const rust = {
    command: "cargo",
    args,
    code: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
  Object.assign(rust, evaluate(rust, process.platform, process.arch));
  return {
    schemaVersion: 3,
    scope: "deepseek-windows-release",
    platform: process.platform,
    arch: process.arch,
    requiredPlatform: "win32",
    requiredTests: [...REQUIRED_WINDOWS_TESTS],
    rust,
    verdict: rust.verdict,
  };
}

// Recompute evidence from raw result rows on the same host. Never trust declared
// PASS, totals, coverage or platform alone, including an older schema's log.
export function readRustGateLog(pathOrBytes, code) {
  try {
    // Validate the same captured bytes the caller archives, without a second
    // filesystem read. Existing path-based callers remain supported.
    const bytes = Buffer.isBuffer(pathOrBytes)
      ? pathOrBytes
      : readFileSync(pathOrBytes);
    const log = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      log.schemaVersion !== 3 ||
      log.scope !== "deepseek-windows-release" ||
      log.platform !== process.platform ||
      log.arch !== process.arch ||
      log.requiredPlatform !== "win32" ||
      !isDeepStrictEqual(log.requiredTests, REQUIRED_WINDOWS_TESTS) ||
      !Object.hasOwn(EXIT, log.verdict) ||
      EXIT[log.verdict] !== code ||
      log.verdict !== log.rust?.verdict
    )
      return null;
    const rust = log.rust;
    if (
      rust.command !== "cargo" ||
      !isDeepStrictEqual(rust.args, cargoArguments(log.platform, log.arch)) ||
      typeof rust.stdout !== "string" ||
      typeof rust.stderr !== "string" ||
      !(
        rust.code === null ||
        (Number.isInteger(rust.code) && rust.code >= 0)
      ) ||
      !(rust.error === null || typeof rust.error === "string") ||
      !(rust.signal === null || typeof rust.signal === "string")
    )
      return null;
    const expected = evaluate(rust, log.platform, log.arch);
    if (
      !Object.keys(expected).every((key) =>
        isDeepStrictEqual(rust[key], expected[key]),
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
  const log = runRustGate();
  const index = process.argv.indexOf("--log-file");
  if (index >= 0)
    writeFileSync(
      resolve(process.argv[index + 1]),
      JSON.stringify(log, null, 2),
    );
  console.log(
    `Rust release gate host: ${log.platform}/${log.arch}; required: Windows MSVC`,
  );
  process.stdout.write(log.rust.stdout);
  process.stderr.write(log.rust.stderr);
  if (log.rust.error) console.error(log.rust.error);
  for (const reason of log.rust.reasons) console.log(reason);
  for (const item of log.rust.coverage)
    console.log(`[required Windows test] ${item.status}: ${item.name}`);
  console.log(`Rust gate: ${log.verdict}`);
  if (log.rust.counts === null)
    console.log(
      "Verified Rust test counts: unavailable; raw libtest pass totals are diagnostic only.",
    );
  process.exitCode = EXIT[log.verdict];
}
