import { cleanSourcePath } from "./local-source-path.ts";
export type ToolPath = { tool: string; path: string };
export const toolPathLabels: Record<string, string> = {
  opencode: "OpenCode · 数据库文件",
  zcode: "ZCode · 本地数据库文件",
  claude: "Claude Code · projects目录",
  hermes: "Hermes · 含state.db的目录",
  openclaw: "OpenClaw · agents目录",
  dsh: "DeepSeek Harness · sessions目录",
};
export type SourceOptions = {
  includeDefault: boolean;
  homes: string[];
  toolPaths?: ToolPath[];
};
export type WslStatus = { state: string; distros: string[] };
export function sourceOptions(
  includeDefault: boolean,
  text: string,
  paths: ToolPath[] = [],
): SourceOptions {
  const homes = text
    .split(/\r?\n/)
    .map((value) => value.trim().replace(/\//g, "\\").replace(/\\+$/, ""))
    .filter(Boolean);
  if (homes.length > 3) throw new Error("最多添加3个额外主目录");
  if (!includeDefault && !homes.length && !paths.length)
    throw new Error("请保留默认目录或至少添加一个来源");
  const seen = new Set<string>();
  for (let index = 0; index < homes.length; index++) {
    const { path, key } = cleanSourcePath(homes[index], true);
    if (seen.has(key)) throw new Error("主目录重复，请保留一项");
    seen.add(key);
    homes[index] = path;
  }
  if (paths.length > 3) throw new Error("最多添加3个单工具路径");
  const tools = new Set<string>();
  const toolPaths = paths.map((entry) => {
    if (!Object.prototype.hasOwnProperty.call(toolPathLabels, entry.tool))
      throw new Error("此工具请使用用户主目录入口");
    if (tools.has(entry.tool)) throw new Error("每款工具只能设置一个额外路径");
    tools.add(entry.tool);
    const { path } = cleanSourcePath(entry.path, false);
    if (
      entry.tool === "zcode" &&
      (path.startsWith("\\\\") || !/\.(?:db|sqlite|sqlite3)$/i.test(path))
    )
      throw new Error(
        "ZCode请填写本地SQLite数据库文件，不支持WSL或WAL/SHM文件",
      );
    if (
      entry.tool === "opencode" &&
      !/^opencode(?:-[a-z0-9._-]+)?\.db$/.test(path.split("\\").pop() || "")
    )
      throw new Error(
        "OpenCode请填写opencode.db或opencode-渠道.db文件，不能选择WAL/SHM",
      );
    return { tool: entry.tool, path };
  });
  return { includeDefault, homes, ...(toolPaths.length ? { toolPaths } : {}) };
}
export function wslStateLabel(status: WslStatus) {
  if (status.state === "ok") return `运行中：${status.distros.join("、")}`;
  if (status.state === "not-installed") return "未检测到已注册的WSL发行版";
  if (status.state === "not-running")
    return "没有正在运行的WSL发行版，请自行启动后重试";
  if (status.state === "not-supported") return "当前系统不支持WSL目录";
  return "WSL状态暂不可用";
}
