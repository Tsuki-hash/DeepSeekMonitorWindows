import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../error-state";
import { archiveScopeLabel } from "../local-archive";
import type { ArchiveScope, ArchiveEntry } from "../local-archive";
export function LocalArchiveCapture({
  collectedAt,
  scope,
  disabled,
  retentionWarning,
  onOpen,
}: {
  collectedAt: number | null;
  scope: ArchiveScope;
  disabled: boolean;
  retentionWarning?: string | null;
  onOpen: (mode: "manual" | "retention") => void;
}) {
  const [paths, setPaths] = React.useState(false),
    [saving, setSaving] = React.useState(false),
    [error, setError] = React.useState(""),
    [message, setMessage] = React.useState("");
  const owner = React.useRef({ active: true, sequence: 0 });
  const retentionOwner = React.useRef({ active: true, sequence: 0 });
  const [retention, setRetention] = React.useState(false),
    [retentionReady, setRetentionReady] = React.useState(false),
    [retentionBusy, setRetentionBusy] = React.useState(false),
    [retentionError, setRetentionError] = React.useState(""),
    [retentionMessage, setRetentionMessage] = React.useState("");
  React.useEffect(() => {
    const state = retentionOwner.current;
    state.active = true;
    const seq = ++state.sequence;
    void invoke<boolean>("get_local_retention_enabled")
      .then((value) => {
        if (state.active && seq === state.sequence) {
          setRetention(value);
          setRetentionReady(true);
        }
      })
      .catch((failure) => {
        if (state.active && seq === state.sequence)
          setRetentionError(errorMessage(failure));
      });
    return () => {
      state.active = false;
      state.sequence++;
    };
  }, []);
  const changeRetention = async (value: boolean) => {
    const seq = ++retentionOwner.current.sequence;
    setRetentionBusy(true);
    setRetentionError("");
    setRetentionMessage("");
    try {
      const enabled = await invoke<boolean>("set_local_retention_enabled", {
        enabled: value,
      });
      if (
        retentionOwner.current.active &&
        seq === retentionOwner.current.sequence
      ) {
        setRetention(enabled);
        setRetentionReady(true);
        setRetentionMessage(
          enabled
            ? "已开启，下次成功采集时自动留存"
            : "自动留存已关闭，已有记录保留",
        );
      }
    } catch (failure) {
      if (
        retentionOwner.current.active &&
        seq === retentionOwner.current.sequence
      )
        setRetentionError(errorMessage(failure));
    } finally {
      if (
        retentionOwner.current.active &&
        seq === retentionOwner.current.sequence
      )
        setRetentionBusy(false);
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
      <details className="local-retention-settings">
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
          开启后，每次成功采集保存会话的最近汇总；来源或月份不同分开保留，与当前统计不相加。仅在本地页可见时采集，隐藏后不持续扫描。
        </p>
        <p>
          不保存项目完整路径、正文或凭据；会话ID和项目名称会保留。最多128条月度会话记录、总8MiB，满后提示。记录未再出现不代表已删除。
        </p>
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
        {!retentionReady && retentionError && (
          <button
            className="secondary"
            disabled={retentionBusy}
            onClick={() => void changeRetention(false)}
          >
            关闭并重置自动留存设置
          </button>
        )}
        {retention && retentionWarning && (
          <p role="alert" className="data-error">
            留存未更新，当前统计仍可用：{retentionWarning}
          </p>
        )}
      </details>
    </details>
  );
}
