import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../error-state";
import { archiveScopeLabel } from "../local-archive";
import { useLocalSettingsRefresh } from "../local-settings-sync";
import type { ArchiveScope, ArchiveEntry } from "../local-archive";
export function LocalArchiveCapture({
  collectedAt,
  scope,
  disabled,
  retentionWarning,
  backgroundEnabled = false,
  onOpen,
}: {
  collectedAt: number | null;
  scope: ArchiveScope;
  disabled: boolean;
  retentionWarning?: string | null;
  /** 后台采集是否开启：决定留存说明里「隐藏后是否仍会采集」。 */
  backgroundEnabled?: boolean;
  onOpen: (mode: "manual" | "retention") => void;
}) {
  const [paths, setPaths] = React.useState(false),
    [saving, setSaving] = React.useState(false),
    [error, setError] = React.useState(""),
    [message, setMessage] = React.useState("");
  const owner = React.useRef({ active: true, sequence: 0 });
  const retentionOwner = React.useRef({
    active: true,
    sequence: 0,
    operation: 0,
    saving: false,
    failure: "",
  });
  const [retention, setRetention] = React.useState(false),
    [retentionReady, setRetentionReady] = React.useState(false),
    [retentionBusy, setRetentionBusy] = React.useState(false),
    [retentionError, setRetentionError] = React.useState(""),
    [retentionMessage, setRetentionMessage] = React.useState("");
  // 容量计量：满额前就能看到剩余条数与占用，而不是只在写满时报错。
  const [capacity, setCapacity] = React.useState<{
    entries: number;
    maxEntries: number;
    bytes: number;
    maxBytes: number;
    remainingEntries: number;
  } | null>(null);
  // 第五轮复评 N05：容量只在挂载时读一次会长期过期 —— 持续采集改变留存
  // 条数后仍显示旧余量。改为按需刷新并记录读取时间；读取失败保留上次
  // 结果并明确标旧，不把失败伪装成最新值。
  const [capacityReadAt, setCapacityReadAt] = React.useState<number | null>(
    null,
  );
  const [capacityStale, setCapacityStale] = React.useState(false);
  const [retentionOpen, setRetentionOpen] = React.useState(false);
  // 容量读取独立的代际：与留存开关读写互不失效。
  const capacityOwner = React.useRef({ active: true, sequence: 0 });
  const refreshCapacity = React.useCallback(() => {
    const state = capacityOwner.current;
    const seq = ++state.sequence;
    void invoke<{
      entries: number;
      maxEntries: number;
      bytes: number;
      maxBytes: number;
      remainingEntries: number;
    }>("get_local_retention_capacity")
      .then((value) => {
        if (state.active && seq === state.sequence) {
          setCapacity(value);
          setCapacityReadAt(Date.now());
          setCapacityStale(false);
        }
      })
      .catch(() => {
        if (state.active && seq === state.sequence) setCapacityStale(true);
      });
  }, []);
  React.useEffect(() => {
    const state = capacityOwner.current;
    state.active = true;
    refreshCapacity();
    return () => {
      state.active = false;
      state.sequence++;
    };
  }, [refreshCapacity]);
  // 成功采集（collectedAt 变化）后留存可能新增记录：重读一次。
  React.useEffect(() => {
    if (collectedAt == null) return;
    refreshCapacity();
  }, [refreshCapacity, collectedAt]);
  // 留存区默认隐藏但仍挂载：展开时重读，避免后台采集后的旧余量。
  React.useEffect(() => {
    if (retentionOpen) refreshCapacity();
  }, [refreshCapacity, retentionOpen]);
  const readRetention = React.useCallback(async () => {
    const state = retentionOwner.current;
    const sequence = ++state.sequence;
    try {
      const enabled = await invoke<boolean>("get_local_retention_enabled");
      if (!state.active || sequence !== state.sequence) return null;
      setRetention(enabled);
      setRetentionReady(true);
      setRetentionError(
        state.failure
          ? `上次请求提示：${state.failure}；当前设置已重新读取，请以当前开关为准`
          : "",
      );
      return { enabled, sequence };
    } catch (failure) {
      if (state.active && sequence === state.sequence)
        setRetentionError(state.failure || errorMessage(failure));
      return null;
    }
  }, []);
  React.useEffect(() => {
    const state = retentionOwner.current;
    state.active = true;
    return () => {
      state.active = false;
      state.sequence++;
      state.operation++;
    };
  }, []);
  useLocalSettingsRefresh(() => {
    setRetentionMessage("");
    refreshCapacity();
    return readRetention();
  });
  const changeRetention = async (value: boolean) => {
    const state = retentionOwner.current;
    if (!state.active || state.saving) return;
    state.saving = true;
    state.failure = "";
    state.sequence++;
    const operation = ++state.operation;
    setRetentionBusy(true);
    setRetentionError("");
    setRetentionMessage("");
    try {
      await invoke<boolean>("set_local_retention_enabled", { enabled: value });
      if (!state.active || operation !== state.operation) return;
      const result = await readRetention();
      if (
        state.active &&
        operation === state.operation &&
        result?.sequence === state.sequence &&
        result.enabled === value
      ) {
        setRetentionMessage(
          value
            ? "已开启，下次成功采集时自动留存"
            : "自动留存已关闭，已有记录保留",
        );
        // Keep the N05 capacity refresh after a confirmed change.
        refreshCapacity();
      }
    } catch (failure) {
      if (state.active && operation === state.operation) {
        state.failure = errorMessage(failure);
        setRetentionError(state.failure);
        await readRetention();
      }
    } finally {
      if (state.active && operation === state.operation) {
        state.saving = false;
        setRetentionBusy(false);
      }
    }
  };
  React.useEffect(() => {
    const state = owner.current;
    state.active = true;
    return () => {
      state.active = false;
      state.sequence++;
    };
  }, []);
  const scopeKey = JSON.stringify(scope);
  React.useEffect(() => {
    owner.current.sequence++;
    setPaths(false);
    setMessage("");
    setError("");
  }, [scopeKey]);
  const save = async () => {
    const seq = ++owner.current.sequence;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await invoke<ArchiveEntry>("save_local_archive", {
        collectedAt,
        scope,
        includePaths: paths,
      });
      if (owner.current.active && seq === owner.current.sequence)
        setMessage("快照已保留，可在历史归档查看");
    } catch (failure) {
      if (owner.current.active && seq === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active) setSaving(false);
    }
  };
  return (
    <details className="history-details local-archive-capture">
      <summary>保存快照与历史归档</summary>
      <p>
        保存当前{archiveScopeLabel(scope.kind)}
        的用量元数据，工具日志清理后仍可查看。手动保存，归档与当前统计分开，不相加。
      </p>
      <label className="local-export-option">
        <input
          type="checkbox"
          checked={paths}
          disabled={saving}
          onChange={(event) => setPaths(event.target.checked)}
        />
        本次保留项目完整路径
      </label>
      <div className="disclosure-actions">
        <button
          className="secondary"
          disabled={disabled || saving || collectedAt == null}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存当前快照"}
        </button>
        <button
          className="secondary"
          disabled={saving}
          onClick={() => onOpen("manual")}
        >
          查看历史归档
        </button>
      </div>
      <p>
        默认不留完整项目路径；会话ID和项目名称会保留，不含正文或凭据。最多12份、总8MiB，满后提示，不自动覆盖。清空只删除本应用归档。
      </p>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="data-error">
          {error}
        </p>
      )}
      <details
        className="local-retention-settings"
        onToggle={(event) => setRetentionOpen(event.currentTarget.open)}
      >
        <summary>自动会话留存</summary>
        <label className="local-export-option">
          <input
            type="checkbox"
            checked={retention}
            disabled={!retentionReady || retentionBusy}
            onChange={(event) => void changeRetention(event.target.checked)}
          />
          自动留存已读取会话
        </label>
        <p>
          开启后，每次成功采集保存会话的最近汇总；来源或月份不同分开保留，与当前统计不相加。
          {backgroundEnabled
            ? "后台采集已开启：收起或隐藏面板后成功采集的结果同样参与留存。"
            : "当前仅在本页可见时采集；若需收起后继续留存，请另行开启「后台采集」。"}
        </p>
        <p>
          不保存项目完整路径、正文或凭据；会话ID和项目名称会保留。最多128条月度会话记录、总8MiB。满额后已存在会话继续更新，新会话不再写入，并提示可导出后清理。记录未再出现不代表已删除。
        </p>
        {capacity && (
          <p className="muted" role="status">
            已用 {capacity.entries}/{capacity.maxEntries} 条 ·{" "}
            {(capacity.bytes / 1024).toFixed(0)}/
            {(capacity.maxBytes / 1024).toFixed(0)} KiB
            {capacity.remainingEntries === 0
              ? " · 已满：新会话将等待清理"
              : ` · 还可新增 ${capacity.remainingEntries} 条`}
            {capacityReadAt != null &&
              (capacityStale
                ? ` · 最新读取失败，以下为 ${new Date(capacityReadAt).toLocaleTimeString()} 的结果`
                : ` · 读取于 ${new Date(capacityReadAt).toLocaleTimeString()}`)}
          </p>
        )}
        <button
          className="secondary"
          disabled={retentionBusy || saving}
          onClick={() => onOpen("retention")}
        >
          查看会话留存
        </button>
        {retentionMessage && <p role="status">{retentionMessage}</p>}
        {retentionError && (
          <p role="alert" className="data-error">
            {retentionError}
          </p>
        )}
        {(!retentionReady || !retention) && retentionError && (
          <button
            className="secondary"
            disabled={retentionBusy}
            onClick={() => void changeRetention(false)}
          >
            {retentionReady
              ? "重新保存自动留存关闭状态"
              : "关闭并重置自动留存设置"}
          </button>
        )}
        {retention && retentionWarning && (
          <p role="alert" className="data-error">
            留存提示，当前统计仍可用：{retentionWarning}
          </p>
        )}
      </details>
    </details>
  );
}
