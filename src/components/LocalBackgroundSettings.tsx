import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../error-state";
import { updateTime } from "../data-display";
import { useLocalSettingsRefresh } from "../local-settings-sync";

export type LocalBackgroundStatus = {
  enabled: boolean;
  stopSavePending?: boolean;
  effective: boolean;
  state: string;
  watchedRoots: number;
  lastAttempt: number | null;
  lastSuccess: number | null;
  error: string | null;
  watchWarning: string | null;
};
export function LocalBackgroundSettings({
  localEnabled,
  onMode,
}: {
  localEnabled: boolean;
  onMode: (enabled: boolean) => void;
}) {
  const [status, setStatus] = React.useState<LocalBackgroundStatus | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const owner = React.useRef({
    active: true,
    sequence: 0,
    operation: 0,
    saving: false,
    failure: "",
  });
  // Reads and saves have separate ownership: a completion event may refresh
  // status while its IPC response is still in flight, without stranding busy.
  const read = React.useCallback(async () => {
    const current = owner.current;
    const sequence = ++current.sequence;
    try {
      const value = await invoke<LocalBackgroundStatus>("get_local_background");
      if (!current.active || sequence !== current.sequence) return null;
      setStatus(value);
      setError(
        current.failure
          ? `上次请求提示：${current.failure}；当前设置已重新读取，请以当前开关为准`
          : "",
      );
      onMode(value.enabled);
      return { value, sequence };
    } catch (failure) {
      if (current.active && sequence === current.sequence)
        setError(current.failure || errorMessage(failure));
      return null;
    }
  }, [onMode]);
  React.useEffect(() => {
    const current = owner.current;
    current.active = true;
    const timer = window.setInterval(() => {
      if (!current.saving) void read();
    }, 5000);
    return () => {
      current.active = false;
      current.sequence++;
      current.operation++;
      window.clearInterval(timer);
    };
  }, [read]);
  useLocalSettingsRefresh(() => {
    setMessage("");
    return read();
  });
  const save = async (enabled: boolean) => {
    const current = owner.current;
    if (!current.active || current.saving) return;
    current.saving = true;
    current.failure = "";
    current.sequence++;
    const operation = ++current.operation;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await invoke<LocalBackgroundStatus>("set_local_background", { enabled });
      if (!current.active || current.operation !== operation) return;
      const result = await read();
      if (
        current.active &&
        current.operation === operation &&
        result?.sequence === current.sequence &&
        result.value.enabled === enabled &&
        (enabled || !result.value.stopSavePending)
      )
        setMessage(enabled ? "后台采集已开启" : "后台采集已关闭，已有留存保留");
    } catch (failure) {
      if (current.active && current.operation === operation) {
        current.failure = errorMessage(failure);
        setError(current.failure);
        await read();
      }
    } finally {
      if (current.active && current.operation === operation) {
        current.saving = false;
        setBusy(false);
      }
    }
  };
  const effective = localEnabled && status?.enabled;
  return (
    <details className="history-details local-background-settings">
      <summary>后台采集</summary>
      <label className="local-export-option">
        <input
          type="checkbox"
          checked={status?.enabled === true}
          disabled={!status || busy || (!localEnabled && !status.enabled)}
          onChange={(event) => void save(event.target.checked)}
        />
        收起后继续采集
      </label>
      <p>
        默认关闭。开启后，离开此页或隐藏到托盘仍更新本地用量；工具目录变化时合并刷新，约每分钟兜底一次，失败自动退避。退出应用后停止。开启后，成功采集的结果也会写入「自动会话留存」（需在「数据」页单独开启留存）。
      </p>
      <p>
        只读已配置来源；WSL不做目录监听，只定时读取已确认运行的发行版。关闭本地统计会暂停后台采集，重新开启后恢复。
      </p>
      {status && (
        <p className="local-background-state" role="status">
          {effective
            ? status.state === "watching"
              ? `目录监听 · ${status.watchedRoots}处`
              : "定时采集中"
            : status.enabled
              ? "已暂停 · 请开启本地统计"
              : "后台采集已关闭"}
          {effective && status.lastSuccess
            ? ` · 最近成功 ${updateTime(status.lastSuccess)}`
            : ""}
        </p>
      )}
      {effective && status?.watchWarning && (
        <p role="status">{status.watchWarning}</p>
      )}
      {effective && status?.error && (
        <p className="history-message warning" role="alert">
          {status.error} · 后台会退避重试，已有数据保留
        </p>
      )}
      {status?.stopSavePending && (
        <p role="status">
          后台采集本次已停止，关闭设置尚未保存，重启前请重试。
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="history-message warning" role="alert">
          {error}
        </p>
      )}
      {(!status || !status.enabled) && (error || status?.stopSavePending) && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void save(false)}
        >
          {status ? "重新保存后台关闭状态" : "关闭并重置后台设置"}
        </button>
      )}
    </details>
  );
}
