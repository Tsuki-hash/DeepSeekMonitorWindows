#!/usr/bin/env node
// 显式运行被 #[ignore] 标记的引擎集成测试。
//
// 复评 F20：`cargo test --lib` 默认跳过 4 项集成测试，于是「187 项通过」里
// 并不包含真实引擎行为；把 ignored 当成通过是验收假绿灯。
//
// 这个脚本做三件事：
// 1. 在临时目录里生成**合成** fixture（不读真实用户日志）；
// 2. 显式执行 `cargo test -- --ignored`，把结果原样透出；
// 3. 用非零退出码传播失败，并明确列出「未运行」的项。
//
// 用法：
//   npm run test:integration
//   npm run test:integration -- --keep   （保留临时目录便于排查）

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

const engine = join(root, "src-tauri/resources/local-usage/tokscale.exe");

/**
 * 生成六款工具的合成日志目录。
 *
 * 只写最小可解析结构：会话 + 模型 + 计数。真实引擎会读取它们，
 * 因此这一步同时验证了「引擎能读合成数据」而不只是纯函数。
 */
/**
 * 这些集成测试读取的是**真实工具日志布局**（OpenCode 的 SQLite、Claude 的 JSONL
 * 目录等），由固定引擎解析。手写一份「看起来像」的 JSON 并不等价 ——
 * 那样只会让测试失败并误导排查方向。
 *
 * 因此本脚本不伪造 fixture，而是：
 * - 若调用方已用 DSM_TEST_LOCAL_USAGE_HOME 指向真实合成目录，则显式运行；
 * - 否则明确报告「未运行」，并以退出码 2 传播，绝不当作通过。
 */
function resolveFixture() {
  const home = process.env.DSM_TEST_LOCAL_USAGE_HOME;
  if (!home) return null;
  if (!existsSync(home)) return null;
  return {
    home,
    second: process.env.DSM_TEST_LOCAL_USAGE_SECOND_HOME ?? home,
  };
}

const fixture = resolveFixture();
if (!fixture) {
  console.error(
    "未运行：缺少 DSM_TEST_LOCAL_USAGE_HOME 指向的真实合成日志目录。",
  );
  console.error(
    "这些用例读取真实工具日志布局，不能用伪造 JSON 替代；请准备合成目录后重跑。",
  );
  console.error(
    "本次结论：INTEGRATION NOT RUN —— 不能把 ignored 项计入「通过」。",
  );
  process.exitCode = 2;
} else {
  let exitCode = 0;
  try {
    const output = execFileSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--lib",
        "--",
        "--ignored",
        "--nocapture",
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: {
          ...process.env,
          DSM_TEST_LOCAL_USAGE_HOME: fixture.home,
          DSM_TEST_LOCAL_USAGE_SECOND_HOME: fixture.second,
        },
      },
    );
    console.log(output);
  } catch (error) {
    console.error(error.stdout ?? "");
    console.error(error.stderr ?? error.message);
    exitCode = typeof error.status === "number" ? error.status : 1;
  }

  if (exitCode !== 0) {
    console.error("集成测试失败：不能把 ignored 项当作通过。");
    process.exitCode = exitCode;
  } else {
    console.log(
      "集成测试已显式运行。仍未被这些用例覆盖的项（真实安装、托盘、DPI、WSL）需真机验收。",
    );
    if (!existsSync(engine)) {
      console.warn(
        "注意：本地引擎二进制不存在，请先运行 npm run local-usage:prepare。",
      );
    }
  }
}
