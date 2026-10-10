import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui";
import { errorMessage } from "../error-state";
import { sourceOptions, wslStateLabel, toolPathLabels } from "../local-sources";
import type { SourceOptions, WslStatus, ToolPath } from "../local-sources";

export function LocalSourceSettings({ onSaved }: { onSaved: () => void }) {
  const [options, setOptions] = React.useState<SourceOptions | null>(null);
  const [includeDefault, setIncludeDefault] = React.useState(true);
  const [homes, setHomes] = React.useState("");
  const [toolPaths, setToolPaths] = React.useState<ToolPath[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [wsl, setWsl] = React.useState<WslStatus | null>(null);
  const owner = React.useRef({ active: true, sequence: 0 });
  const accept = React.useCallback((value: SourceOptions) => {
    setOptions(value);
    setIncludeDefault(value.includeDefault);
    setHomes(value.homes.join("\n"));
    setToolPaths(value.toolPaths || []);
  }, []);
  const reload = React.useCallback(async () => {
    const sequence = ++owner.current.sequence;
    try {
      const value = await invoke<SourceOptions>("get_local_sources");
      if (owner.current.active && sequence === owner.current.sequence) {
        accept(value);
        setError("");
      }
    } catch (failure) {
      if (owner.current.active && sequence === owner.current.sequence)
        setError(errorMessage(failure));
    }
  }, [accept]);
  React.useEffect(() => {
    const current = owner.current;
    current.active = true;
    void reload();
    return () => {
      current.active = false;
      current.sequence++;
    };
  }, [reload]);
  const dirty =
    options &&
    (includeDefault !== options.includeDefault ||
      homes !== options.homes.join("\n") ||
      JSON.stringify(toolPaths) !== JSON.stringify(options.toolPaths || []));
  const save = async (reset = false) => {
    setError("");
    setMessage("");
    let next: SourceOptions;
    try {
      next = reset
        ? { includeDefault: true, homes: [] }
        : sourceOptions(includeDefault, homes, toolPaths);
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    setBusy(true);
    const sequence = ++owner.current.sequence;
    try {
      const value = await invoke<SourceOptions>("save_local_sources", {
        options: next,
      });
      if (owner.current.active && sequence === owner.current.sequence) {
        accept(value);
        setMessage("目录已保存，旧采集已作废");
        onSaved();
      }
    } catch (failure) {
      if (owner.current.active && sequence === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active) setBusy(false);
    }
  };
  const listWsl = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    setWsl(null);
    try {
      const value = await invoke<WslStatus>("list_running_wsl");
      if (owner.current.active) setWsl(value);
    } catch (failure) {
      if (owner.current.active) setError(errorMessage(failure));
    } finally {
      if (owner.current.active) setBusy(false);
    }
  };
  return (
    <details className="history-details local-source-settings">
      <summary>采集目录</summary>
      <Toggle
        label="包含本机默认目录"
        checked={includeDefault}
        disabled={busy || !options}
        onChange={(value) => {
          setIncludeDefault(value);
          setMessage("");
        }}
      />
      <label className="local-source-label">
        额外用户主目录
        <textarea
          aria-label="额外主目录"
          rows={3}
          maxLength={4096}
          disabled={busy || !options}
          value={homes}
          onChange={(event) => {
            setHomes(event.target.value);
            setMessage("");
          }}
          placeholder={
            "D:\\AgentData\\User\n\\\\wsl.localhost\\Ubuntu\\home\\user"
          }
        />
      </label>
      <p>
        一行一个，最多3个。填包含 .claude、.hermes
        等子目录的用户主目录，不是项目目录或单个日志文件。
      </p>
      <details className="local-tool-paths">
        <summary>
          单工具数据路径{toolPaths.length ? ` · ${toolPaths.length}项` : ""}
        </summary>
        <p>
          最多3项，每款工具一项。OpenCode与ZCode选数据库文件，其余选记录目录。ZCode仅支持本地盘；其他工具支持运行中的WSL。
        </p>
        {toolPaths.map((entry, index) => (
          <div className="local-tool-path" key={index}>
            <label className="local-source-label">
              工具
              <select
                aria-label={`工具${index + 1}`}
                value={entry.tool}
                disabled={busy || !options}
                onChange={(event) => {
                  setToolPaths((rows) =>
                    rows.map((row, i) =>
                      i === index ? { ...row, tool: event.target.value } : row,
                    ),
                  );
                  setMessage("");
                }}
              >
                {Object.entries(toolPathLabels).map(([tool, label]) => (
                  <option key={tool} value={tool}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="local-source-label">
              数据路径
              <textarea
                rows={
                  entry.path.startsWith("\\\\") || entry.path.length > 72
                    ? 3
                    : entry.path.length > 42
                      ? 2
                      : 1
                }
                aria-label={`工具路径${index + 1}`}
                maxLength={1024}
                value={entry.path}
                disabled={busy || !options}
                placeholder={
                  entry.tool === "opencode"
                    ? "D:\\AgentData\\opencode.db"
                    : entry.tool === "zcode"
                      ? "D:\\AgentData\\db.sqlite"
                      : "D:\\AgentData\\sessions"
                }
                onChange={(event) => {
                  setToolPaths((rows) =>
                    rows.map((row, i) =>
                      i === index ? { ...row, path: event.target.value } : row,
                    ),
                  );
                  setMessage("");
                }}
              />
            </label>
            <button
              className="secondary"
              disabled={busy || !options}
              onClick={() => {
                setToolPaths((rows) => rows.filter((_, i) => i !== index));
                setMessage("");
              }}
            >
              移除路径{index + 1}
            </button>
          </div>
        ))}
        <button
          className="secondary"
          disabled={busy || !options || toolPaths.length >= 3}
          onClick={() => {
            setToolPaths((rows) => [
              ...rows,
              {
                tool:
                  Object.keys(toolPathLabels).find(
                    (tool) => !rows.some((row) => row.tool === tool),
                  ) || "opencode",
                path: "",
              },
            ]);
            setMessage("");
          }}
        >
          添加工具路径
        </button>
      </details>
      <div className="disclosure-actions">
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? "处理中…" : "保存目录"}
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void listWsl()}
        >
          读取运行中的 WSL
        </button>
      </div>
      {dirty && <p>修改尚未保存</p>}
      {wsl && <p role="status">{wslStateLabel(wsl)}</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
      {!options && error && (
        <div className="disclosure-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void reload()}
          >
            重新读取目录设置
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void save(true)}
          >
            恢复默认目录设置
          </button>
        </div>
      )}
      <details className="local-source-help">
        <summary>目录与WSL说明</summary>
        <p>
          单工具WSL示例：\\wsl.localhost\Ubuntu\home\user\.claude\projects。未确认运行的发行版跳过。只写本应用设置，不修改工具配置或复制数据库；不要重复添加已被默认或主目录覆盖的同一批日志。
        </p>
        <p>
          WSL只查询运行中的发行版，不执行安装、启动或Linux命令。请填写自己的WSL用户主目录；发行版停止时跳过该来源。
        </p>
        <p>
          保存先校验目录格式，可访问性在采集时检查；目录不可用会提示，部分失败只显示成功来源，全部失败保留旧数据。更改目录取消旧采集并清除旧快照。
        </p>
        <p>
          相同主目录不重复扫描。不同主目录的项目与同名会话分开；复制到不同目录的日志可能重复，不与平台账单相加。主目录与偏好仅存本机，源日志不删除；引擎缓存留在本应用目录。
        </p>
        <p>
          默认扫描沿用引擎的环境变量路径；可取消包含默认目录，仅采集指定来源。额外主目录按标准布局读取，单工具路径使用本应用隔离设置。覆盖与缺失字段仍取决于工具日志和采集引擎。
        </p>
      </details>
    </details>
  );
}
