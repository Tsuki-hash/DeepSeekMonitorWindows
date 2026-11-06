#!/usr/bin/env node
// Real App/SettingsPanel/AlertSettings rendering with a deferred IPC boundary.
// This is not a Windows WebView2 test; native focus and IPC remain release checks.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep output beside node_modules so Node resolves the pinned React renderer.
const directory = mkdtempSync(join(root, ".settings-components-"));
try {
  const entries = [
    "settings-transactions.test",
    "desktop-ui-regressions.test",
    "usage-fidelity.test",
    "history-lifecycle.test",
    "chart-accessibility.test",
  ];
  const outfiles = entries.map((name) => join(directory, `${name}.mjs`));
  await build({
    entryPoints: entries.map((name) => join(root, `tests/${name}.tsx`)),
    outdir: directory,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    external: ["react", "react-test-renderer"],
    plugins: [
      {
        name: "synthetic-tauri",
        setup(builder) {
          builder.onResolve(
            { filter: /^@tauri-apps\/api\/(core|event|app)$/ },
            () => ({
              path: join(root, "tests/settings-tauri.ts"),
            }),
          );
        },
      },
    ],
  });
  const result = spawnSync(process.execPath, ["--test", ...outfiles], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
