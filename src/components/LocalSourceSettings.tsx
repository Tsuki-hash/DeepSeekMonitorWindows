import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui";
import { errorMessage } from "../error-state";
import { useLocalSettingsRefresh } from "../local-settings-sync";
import { sourceOptions, wslStateLabel, toolPathLabels } from "../local-sources";
import type { SourceOptions, WslStatus, ToolPath } from "../local-sources";

function sameSources(left: SourceOptions, right: SourceOptions) {
  return (
    left.includeDefault === right.includeDefault &&
    JSON.stringify(left.homes) === JSON.stringify(right.homes) &&
    JSON.stringify(left.toolPaths || []) ===
      JSON.stringify(right.toolPaths || [])
  );
}

export function LocalSourceSettings({
  onSaved,
  onDirtyChanged,
  onSaveRequested,
}: {
  onSaved: () => void;
  /** 把「有未保存修改」上报给父级，用于离开前拦截（评审 P2）。 */
  onDirtyChanged?: (dirty: boolean) => void;
  /**
   * 把「保存」动作交给父级调用（复评 F09）：
   * 全局离开拦截的「保存并离开」需要真的保存成功后再离开。
   * 返回值表示是否保存成功。
   */
  onSaveRequested?: (save: () => Promise<boolean>) => void;
}) {
  const [options, setOptions] = React.useState<SourceOptions | null>(null);
  const [includeDefault, setIncludeDefault] = React.useState(true);
  const [homes, setHomes] = React.useState("");
  const [toolPaths, setToolPaths] = React.useState<ToolPath[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [wslBusy, setWslBusy] = React.useState(false);
  const busy = saving || wslBusy;
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [wsl, setWsl] = React.useState<WslStatus | null>(null);
  // Reads, saves, WSL queries and draft edits are independent owners. Events
  // update the saved baseline but must never adopt it over an edited draft.
  const owner = React.useRef({
    active: true,
    sequence: 0,
    saving: false,
    failure: "",
  });
  const readOwner = React.useRef({ sequence: 0 });
  const wslOwner = React.useRef({ active: true, sequence: 0, inFlight: false });
  const draft = React.useRef({ revision: 0, dirty: false });
  const dirty = Boolean(
    options &&
    (includeDefault !== options.includeDefault ||
      homes !== options.homes.join("\n") ||
      JSON.stringify(toolPaths) !== JSON.stringify(options.toolPaths || [])),
  );
  draft.current.dirty = dirty;
  const edited = () => {
    draft.current.revision++;
    draft.current.dirty = true;
    setMessage("");
  };
  const [loadingOptions, setLoadingOptions] = React.useState(true);
  const accept = React.useCallback((value: SourceOptions) => {
    setOptions(value);
    setIncludeDefault(value.includeDefault);
    setHomes(value.homes.join("\n"));
    setToolPaths(value.toolPaths || []);
    draft.current.dirty = false;
  }, []);
  const reload = React.useCallback(
    async (saved?: { revision: number; value: SourceOptions }) => {
      const sequence = ++readOwner.current.sequence;
      const revision = draft.current.revision;
      const adoptCleanDraft = !draft.current.dirty && !owner.current.saving;
      setLoadingOptions(true);
      try {
        const value = await invoke<SourceOptions>("get_local_sources");
        if (!owner.current.active || sequence !== readOwner.current.sequence)
          return null;
        const confirmedSave =
          saved != null &&
          saved.revision === draft.current.revision &&
          sameSources(saved.value, value);
        if (
          confirmedSave ||
          (adoptCleanDraft &&
            !draft.current.dirty &&
            revision === draft.current.revision &&
            !owner.current.saving)
        ) {
          accept(value);
        } else {
          setOptions(value);
        }
        setError(
          owner.current.failure
            ? `上次保存提示：${owner.current.failure}；已重新读取已保存设置，当前输入保留`
            : "",
        );
        setLoadingOptions(false);
        return { sequence, confirmedSave };
      } catch (failure) {
        if (owner.current.active && sequence === readOwner.current.sequence) {
          setError(owner.current.failure || errorMessage(failure));
          setLoadingOptions(false);
        }
        return null;
      }
    },
    [accept],
  );
  React.useEffect(() => {
    const current = owner.current;
    const wslState = wslOwner.current;
    const reads = readOwner.current;
    current.active = true;
    wslState.active = true;
    return () => {
      current.active = false;
      current.sequence++;
      reads.sequence++;
      wslState.active = false;
      wslState.sequence++;
    };
  }, []);
  useLocalSettingsRefresh(() => reload());
  // 把脏状态同步给父级：页面切换前需要据此决定是否拦截。
  React.useEffect(() => {
    onDirtyChanged?.(Boolean(dirty));
  }, [dirty, onDirtyChanged]);
  React.useEffect(() => () => onDirtyChanged?.(false), [onDirtyChanged]);
  const save = async (reset = false): Promise<boolean> => {
    const current = owner.current;
    if (!current.active || current.saving || wslOwner.current.inFlight)
      return false;
    setError("");
    setMessage("");
    let next: SourceOptions;
    try {
      next = reset
        ? { includeDefault: true, homes: [] }
        : sourceOptions(includeDefault, homes, toolPaths);
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
    current.saving = true;
    current.failure = "";
    readOwner.current.sequence++;
    setSaving(true);
    const sequence = ++current.sequence;
    const revision = draft.current.revision;
    try {
      const value = await invoke<SourceOptions>("save_local_sources", {
        options: next,
      });
      if (!current.active || sequence !== current.sequence) return false;
      const result = await reload({ revision, value });
      if (
        current.active &&
        sequence === current.sequence &&
        result?.sequence === readOwner.current.sequence &&
        result.confirmedSave &&
        revision === draft.current.revision
      ) {
        setMessage("目录已保存，旧采集已作废");
        onSaved();
        return true;
      }
      return false;
    } catch (failure) {
      if (current.active && sequence === current.sequence) {
        current.failure = errorMessage(failure);
        setError(current.failure);
        // A timeout is not a rollback. Re-read now, then again when the native
        // worker actually completes. Neither path overwrites a newer draft.
        await reload();
      }
      return false;
    } finally {
      if (current.active && sequence === current.sequence) {
        current.saving = false;
        setSaving(false);
      }
    }
  };

  // 把保存动作登记给父级，供全局「保存并离开」调用。
  // 用 ref 转发：save 每次渲染都是新函数，直接放进依赖会反复登记。
  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useEffect(() => {
    onSaveRequested?.(() => saveRef.current());
  }, [onSaveRequested]);
  const listWsl = async () => {
    if (
      !wslOwner.current.active ||
      wslOwner.current.inFlight ||
      owner.current.saving
    )
      return;
    wslOwner.current.inFlight = true;
    setWslBusy(true);
    // 复评 F10：WSL 查询只用**自己的**代际，绝不递增目录读取的序号 ——
    // 否则一次 WSL 查询就会作废在途的目录初读。
    const sequence = ++wslOwner.current.sequence;
    setError("");
    setMessage("");
    setWsl(null);
    try {
      const value = await invoke<WslStatus>("list_running_wsl");
      if (wslOwner.current.active && sequence === wslOwner.current.sequence)
        setWsl(value);
    } catch (failure) {
      if (wslOwner.current.active && sequence === wslOwner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (wslOwner.current.active && sequence === wslOwner.current.sequence) {
        wslOwner.current.inFlight = false;
        setWslBusy(false);
      }
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
          edited();
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
            edited();
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
                  edited();
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
                  edited();
                }}
              />
            </label>
            <button
              className="secondary"
              disabled={busy || !options}
              onClick={() => {
                setToolPaths((rows) => rows.filter((_, i) => i !== index));
                edited();
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
            edited();
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
          // 复评 F10：目录配置还没读到时禁用 WSL 查询，避免在「不知道
          // 当前设置」的状态下发起无关查询；读取完成后自动可用。
          disabled={busy || !options}
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
      {loadingOptions && !options && (
        <p className="muted" role="status">
          正在读取目录设置…
        </p>
      )}
      {!options && !loadingOptions && (
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
