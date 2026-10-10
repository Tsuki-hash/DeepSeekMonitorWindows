import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOptions, wslStateLabel } from "./local-sources.ts";
test("单工具路径格式与OpenCode数据库名校验，支持仅单路径来源", () => {
  assert.deepEqual(
    sourceOptions(false, "", [
      { tool: "opencode", path: "D:/Logs/opencode-stable.1.db" },
    ]).toolPaths,
    [{ tool: "opencode", path: "D:\\Logs\\opencode-stable.1.db" }],
  );
  for (const [tool, path] of [
    ["opencode", "D:\\Logs\\opencode.db-wal"],
    ["opencode", "D:\\Logs\\custom.db"],
    ["zcode", "D:\\Logs\\db.sqlite-wal"],
    ["claude", "\\\\server\\share\\user"],
    ["hermes", ""],
    ["claude", "D:\\A\nD:\\B"],
  ])
    assert.throws(() => sourceOptions(true, "", [{ tool, path }]));
});
test("ZCode单数据库支持本地文件，拒绝目录、WAL/SHM、WSL及重复工具", () => {
  for (const path of [
    "D:/Logs/custom.db",
    "D:/Logs/usage.sqlite",
    "D:/Logs/usage.SQLITE3",
  ])
    assert.equal(
      sourceOptions(false, "", [{ tool: "zcode", path }]).toolPaths?.[0].path,
      path.replace(/\//g, "\\"),
    );
  for (const path of [
    "D:/Logs/",
    "D:/Logs/db.sqlite-wal",
    "D:/Logs/db.sqlite-shm",
    "//wsl$/Ubuntu/home/User/db.sqlite",
  ])
    assert.throws(() => sourceOptions(true, "", [{ tool: "zcode", path }]));
  assert.throws(() =>
    sourceOptions(true, "", [
      { tool: "zcode", path: "D:/A/db.sqlite" },
      { tool: "zcode", path: "D:/B/db.sqlite" },
    ]),
  );
});
test("WSL单工具深层路径支持五工具，服务器别名统一且Linux大小写保留", () => {
  for (const [tool, tail] of [
    ["opencode", ".local/share/opencode/opencode.db"],
    ["claude", ".claude/projects"],
    ["hermes", ".hermes"],
    ["openclaw", ".openclaw/agents"],
    ["dsh", ".dsh/sessions"],
  ]) {
    const options = sourceOptions(false, "", [
      { tool, path: `//wsl$/Ubuntu/home/User/${tail}` },
    ]);
    assert.equal(
      options.toolPaths?.[0].path,
      `\\\\wsl.localhost\\Ubuntu\\home\\User\\${tail.replace(/\//g, "\\")}`,
    );
  }
  assert.throws(() =>
    sourceOptions(true, "", [{ tool: "claude", path: "\\\\wsl$\\Ubuntu" }]),
  );
  assert.throws(() =>
    sourceOptions(true, "", [
      { tool: "claude", path: "\\\\wsl$\\Ubuntu\\home\\user\\..\\Logs" },
    ]),
  );
  assert.throws(() =>
    sourceOptions(true, "\\\\wsl$\\Ubuntu\\home\\user\\.claude\\projects"),
  );
});
test("单工具路径每工具一项及容量限制，不改写旧偏好返回结构", () => {
  assert.throws(() =>
    sourceOptions(true, "", [
      { tool: "claude", path: "D:\\A" },
      { tool: "claude", path: "D:\\B" },
    ]),
  );
  assert.throws(() =>
    sourceOptions(
      true,
      "",
      ["opencode", "claude", "hermes", "dsh"].map((tool) => ({
        tool,
        path: "D:\\A",
      })),
    ),
  );
  assert.deepEqual(sourceOptions(true, ""), {
    includeDefault: true,
    homes: [],
  });
});
test("额外主目录解析保留空行和斜杠语义，拒绝盘符根/相对/设备/共享路径", () => {
  assert.deepEqual(sourceOptions(true, "D:/Agent User\n\n"), {
    includeDefault: true,
    homes: ["D:\\Agent User"],
  });
  for (const home of [
    "C:\\",
    "C:Data",
    "%USERPROFILE%\\Data",
    "/home/user",
    "\\\\server\\share\\data",
    "\\\\?\\C:\\Data",
    "D:\\A\\..\\B",
  ])
    assert.throws(() => sourceOptions(true, home));
  assert.throws(() => sourceOptions(false, ""));
  assert.throws(() => sourceOptions(true, "D:\\A\nD:\\B\nD:\\C\nD:\\D"));
});
test("重复Windows主目录和WSL别名去重，WSL用户大小写保持独立", () => {
  assert.throws(() => sourceOptions(true, "D:\\A\nd:\\a"));
  assert.throws(() =>
    sourceOptions(
      true,
      "\\\\wsl$\\Ubuntu\\home\\User\n\\\\wsl.localhost\\ubuntu\\home\\User",
    ),
  );
  assert.equal(
    sourceOptions(
      false,
      "\\\\wsl$\\Ubuntu\\home\\User\n\\\\wsl$\\Ubuntu\\home\\user",
    ).homes.length,
    2,
  );
  assert.ok(
    wslStateLabel({ state: "not-running", distros: [] }).includes("自行启动"),
  );
});
