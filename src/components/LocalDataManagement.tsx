import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, ShieldCheck } from "lucide-react";
import { errorMessage } from "../error-state";

export type LocalDataOverview = {
  apiKeyConfigured: boolean;
  usageTokenConfigured: boolean;
  localEnabled: boolean;
  localCollecting: boolean;
  /** null 表示读取失败：磁盘数据可能仍在，不能显示成 0 条。 */
  archiveEntries: number | null;
  archiveError?: string | null;
  retentionEntries: number | null;
  retentionBytes: number | null;
  retentionError?: string | null;
  /** null 表示读取失败或超出预算：显示「未知」，不能显示 0 KiB。 */
  engineCacheBytes: number | null;
  engineCacheMayHoldTitles: boolean;
};

const kib = (bytes: number | null) =>
  bytes == null ? "未知" : `${(bytes / 1024).toFixed(0)} KiB`;
const countText = (value: number | null, unit: string) =>
  value == null ? "未知（无法读取）" : `${value} ${unit}`;

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
  /** 采集状态或快照变化时变化的信号：驱动 overview 重新读取（复评 T06）。 */
  refreshSignal,
  /** 复评 Q03：按错误类型打开对应管理页，而不是固定导向手动归档。 */
  onOpenArchiveManager,
  onOpenRetentionManager,
}: {
  onClearArchives?: () => void;
  onClearRetention?: () => void;
  refreshSignal?: string;
  onOpenArchiveManager?: () => void;
  onOpenRetentionManager?: () => void;
}) {
  const [overview, setOverview] = React.useState<LocalDataOverview | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [confirmCache, setConfirmCache] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  // 复评 T06：overview 原先只在挂载时读一次，而组件在 hidden 分区保持挂载 ——
  // 采集启停、新快照都不会刷新，清缓存按钮可能被过期的 localCollecting 永久禁用。
  // 用代际丢弃迟到响应：两次刷新并发时，只有最新一次的结果允许写入。
  const loadGeneration = React.useRef(0);
  const load = React.useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const value = await invoke<LocalDataOverview>("get_local_data_overview");
      if (generation !== loadGeneration.current) return; // 迟到的旧结果，丢弃
      setOverview(value);
      setError("");
    } catch (failure) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(failure));
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  // 复评 T06：展开时与采集/快照状态变化时都重新读取。
  React.useEffect(() => {
    if (open) void load();
  }, [open, load, refreshSignal]);
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
    <details
      className="history-details local-data-management"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
            <span>{countText(overview.archiveEntries, "条")}</span>
            <small>
              默认不含完整路径；在「数据 · 查看历史归档」导出或清空。
            </small>
          </li>
          <li>
            <strong>自动留存</strong>
            <span>
              {countText(overview.retentionEntries, "条")} ·{" "}
              {kib(overview.retentionBytes)}
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
      {(overview?.archiveError || overview?.retentionError) && (
        <p className="data-error" role="alert">
          {overview.archiveError && `手动快照：${overview.archiveError}`}
          {overview.archiveError && overview.retentionError ? "；" : ""}
          {overview.retentionError && `自动留存：${overview.retentionError}`}
          。数据可能仍在磁盘上。
          {/* 复评 Q03：恢复入口按错误类型分开，留存错误直接到留存列表。 */}
          {onOpenArchiveManager && overview?.archiveError && (
            <button className="link-button" onClick={onOpenArchiveManager}>
              打开手动快照管理 ›
            </button>
          )}
          {onOpenRetentionManager && overview?.retentionError && (
            <button className="link-button" onClick={onOpenRetentionManager}>
              打开自动留存管理 ›
            </button>
          )}
          {!onOpenArchiveManager && !onOpenRetentionManager && (
            <span>可在「数据」页的归档/留存列表删除或清空（有二次确认）。</span>
          )}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
