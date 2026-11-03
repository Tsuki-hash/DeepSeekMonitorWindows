import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, ShieldCheck } from "lucide-react";
import { errorMessage } from "../error-state";

export type LocalDataOverview = {
  apiKeyConfigured: boolean;
  usageTokenConfigured: boolean;
  localEnabled: boolean;
  localCollecting: boolean;
  archiveEntries: number;
  retentionEntries: number;
  retentionBytes: number;
  engineCacheBytes: number;
  engineCacheMayHoldTitles: boolean;
};

const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;

/**
 * 统一的本机数据管理入口。
 *
 * 评审 P2：清除 Key、清除 Token、忘记登录、停止采集、清空归档各有不同作用，
 * 分散在多处容易让人误以为其中一个动作就删光了本机数据。这里把「有什么、
 * 多大、怎么清」集中在一处，并对每一项说明清理边界。
 */
export function LocalDataManagement({
  onClearArchives,
  onClearRetention,
}: {
  onClearArchives?: () => void;
  onClearRetention?: () => void;
}) {
  const [overview, setOverview] = React.useState<LocalDataOverview | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [confirmCache, setConfirmCache] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      setOverview(await invoke<LocalDataOverview>("get_local_data_overview"));
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  const clearCache = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await invoke("clear_local_engine_cache");
      setMessage("引擎缓存已清理；原工具日志未改动");
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      setConfirmCache(false);
    }
  };
  return (
    <details className="history-details local-data-management">
      <summary>
        <Database size={14} aria-hidden="true" /> 本机数据管理
      </summary>
      <p className="muted">
        下列数据都只保存在这台电脑。每项作用不同，清理一项不影响其他项。
      </p>
      {overview && (
        <ul className="local-data-list">
          <li>
            <strong>API Key</strong>
            <span>{overview.apiKeyConfigured ? "已配置" : "未配置"}</span>
            <small>仅用于查询余额；在「设置 · API Key」清除。</small>
          </li>
          <li>
            <strong>用量 Token</strong>
            <span>{overview.usageTokenConfigured ? "已配置" : "未配置"}</span>
            <small>
              「清除
              Token」保留网页登录会话；「退出并忘记账户」同时清除网页登录数据。
            </small>
          </li>
          <li>
            <strong>WebView2 登录数据</strong>
            <span>随「退出并忘记账户」清理</span>
            <small>清理后需要重新登录；主题与透明度偏好会保留。</small>
          </li>
          <li>
            <strong>Agent 引擎缓存</strong>
            <span>{kib(overview.engineCacheBytes)}</span>
            <small>
              可能包含源会话标题等元数据；停止采集不代表缓存被删。
              {overview.localCollecting ? " 当前正在采集，暂不能清理。" : ""}
            </small>
          </li>
          <li>
            <strong>手动快照</strong>
            <span>{overview.archiveEntries} 条</span>
            <small>
              默认不含完整路径；在「数据 · 查看历史归档」导出或清空。
            </small>
          </li>
          <li>
            <strong>自动留存</strong>
            <span>
              {overview.retentionEntries} 条 · {kib(overview.retentionBytes)}
            </span>
            <small>
              关闭留存不会删除已有记录；清空后若留存仍开启，新采集会重新产生记录。
            </small>
          </li>
        </ul>
      )}
      <div className="disclosure-actions">
        {confirmCache ? (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void clearCache()}
            >
              {busy ? "清理中…" : "确认清理引擎缓存"}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmCache(false)}
            >
              取消
            </button>
          </>
        ) : (
          <button
            className="secondary"
            disabled={busy || overview?.localCollecting}
            onClick={() => setConfirmCache(true)}
          >
            清理引擎缓存
          </button>
        )}
        {onClearArchives && (
          <button className="secondary" onClick={onClearArchives}>
            清空手动快照
          </button>
        )}
        {onClearRetention && (
          <button className="secondary" onClick={onClearRetention}>
            清空自动留存
          </button>
        )}
      </div>
      <p className="muted">
        <ShieldCheck size={13} aria-hidden="true" />{" "}
        只删除本应用数据，不删除原工具日志， 也不承诺取证级安全擦除。
      </p>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
