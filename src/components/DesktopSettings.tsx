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
  React.useEffect(() => {
    let active = true;
    void invoke<DesktopOptions>("get_desktop_options")
      .then((value) => {
        if (active) {
          setOptions(value);
          setError(value.error || "");
        }
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, []);
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
    </details>
  );
}
