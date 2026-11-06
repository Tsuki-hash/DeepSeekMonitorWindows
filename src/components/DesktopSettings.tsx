import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui";
import { errorMessage } from "../error-state";
type DesktopOptions = {
  alwaysOnTop: boolean;
  shortcutEnabled: boolean;
  error: string | null;
};
export function DesktopSettings() {
  const [options, setOptions] = React.useState<DesktopOptions | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  // 复评 N20：首读失败后必须能**同页重试**。旧实现只在挂载时读一次，
  // 失败后两个开关保持禁用且没有重试入口（只能退出再进设置页）。
  // 现在用带 active/sequence 所有权的 reload：旧失败不覆盖新成功，
  // 重试中防连点。
  const owner = React.useRef({ active: true, sequence: 0 });
  const reload = React.useCallback(async () => {
    const sequence = ++owner.current.sequence;
    setBusy(true);
    setError("");
    try {
      const value = await invoke<DesktopOptions>("get_desktop_options");
      if (owner.current.active && sequence === owner.current.sequence) {
        setOptions(value);
        setError(value.error || "");
      }
    } catch (failure) {
      if (owner.current.active && sequence === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active && sequence === owner.current.sequence)
        setBusy(false);
    }
  }, []);
  React.useEffect(() => {
    const current = owner.current;
    current.active = true;
    void reload();
    return () => {
      current.active = false;
      current.sequence++;
    };
  }, [reload]);
  const save = async (next: DesktopOptions) => {
    setBusy(true);
    setError("");
    try {
      const value = await invoke<DesktopOptions>("set_desktop_options", {
        alwaysOnTop: next.alwaysOnTop,
        shortcutEnabled: next.shortcutEnabled,
      });
      setOptions(value);
      setError(value.error || "");
    } catch (failure) {
      setError(errorMessage(failure));
      try {
        setOptions(await invoke<DesktopOptions>("get_desktop_options"));
      } catch {
        /* Retain displayed state when the system query is unavailable. */
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="settings-disclosure desktop-settings">
      <summary>桌面快捷操作</summary>
      <Toggle
        label="面板保持置顶"
        checked={options?.alwaysOnTop || false}
        disabled={busy || !options}
        onChange={(value) =>
          options && void save({ ...options, alwaysOnTop: value })
        }
      />
      <Toggle
        label="快捷键显隐面板"
        checked={options?.shortcutEnabled || false}
        disabled={busy || !options}
        onChange={(value) =>
          options && void save({ ...options, shortcutEnabled: value })
        }
      />
      <p className="muted">
        Ctrl + Alt + D 显示或收起面板。若被其他应用占用，开启时会提示。
      </p>
      <p className="muted">
        托盘悬停及右键菜单显示最近成功查询的余额；收起后不为此额外查询。
      </p>
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
      {!options && (
        <div className="disclosure-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void reload()}
          >
            {busy ? "正在读取…" : "重新读取桌面设置"}
          </button>
        </div>
      )}
    </details>
  );
}
