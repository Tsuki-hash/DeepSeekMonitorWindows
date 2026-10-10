export function cleanSourcePath(value: string, homeOnly: boolean) {
  const path = value.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  if (
    !path ||
    new TextEncoder().encode(path).length > 1024 ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    /["<>|*?]/.test(path) ||
    path
      .split("\\")
      .some((part) => part === "." || part === ".." || /[ .]$/.test(part))
  )
    throw new Error("路径格式不可用，请填写本地或WSL绝对路径");
  const wsl = /^\\\\(wsl\$|wsl\.localhost)\\([^\\:]+)\\([^:]+)$/i.exec(path);
  const native = /^[a-z]:\\[^\\:]+(?:\\[^\\:]+)*$/i.test(path);
  if (wsl && wsl[3].split("\\").some((part) => !part))
    throw new Error("WSL路径不能包含空层级");
  if (wsl && homeOnly && !/^home\\[^\\]+$/.test(wsl[3]) && wsl[3] !== "root")
    throw new Error("WSL请填写用户主目录，单工具目录使用单独路径入口");
  if (!wsl && !native)
    throw new Error(
      "请填写本地或WSL绝对路径，不支持盘根、相对路径或其他网络共享",
    );
  return {
    path: wsl ? `\\\\wsl.localhost\\${wsl[2]}\\${wsl[3]}` : path,
    key: wsl ? `wsl:${wsl[2].toLowerCase()}:${wsl[3]}` : path.toLowerCase(),
  };
}
