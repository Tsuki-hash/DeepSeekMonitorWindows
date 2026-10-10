import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { errorMessage } from "../error-state";
import { fmtTokensShort } from "../format";
import { downloadText } from "../download";
import { localSum, localTools } from "../local-usage";
import {
  archiveScopeLabel,
  archiveExport,
  archiveLocalRows,
} from "../local-archive";
import type { ArchiveEntry, ArchiveSummary } from "../local-archive";
import { LocalDataQuality } from "./LocalDataQuality";
const time = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function LocalArchivePanel({
  onBack,
  mode = "manual",
}: {
  onBack: () => void;
  mode?: "manual" | "retention";
}) {
  const retained = mode === "retention";
  const listCommand = retained ? "list_local_retention" : "list_local_archives";
  const readCommand = retained ? "read_local_retention" : "read_local_archive";
  const deleteCommand = retained
    ? "delete_local_retention"
    : "delete_local_archive";
  const clearCommand = retained
    ? "clear_local_retention"
    : "clear_local_archives";
  const singleLabel = retained ? "删除这条留存" : "删除这份归档";
  const clearLabel = retained ? "清空全部会话留存" : "清空全部归档";
  const [entries, setEntries] = React.useState<ArchiveSummary[]>([]),
    [selected, setSelected] = React.useState<ArchiveEntry | null>(null),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState(""),
    [message, setMessage] = React.useState(""),
    [confirm, setConfirm] = React.useState<"all" | "one" | null>(null),
    [limit, setLimit] = React.useState(30);
  const owner = React.useRef({ active: true, sequence: 0 });
  const reload = React.useCallback(async () => {
    const seq = ++owner.current.sequence;
    setBusy(true);
    setError("");
    setConfirm(null);
    try {
      const rows = await invoke<ArchiveSummary[]>(listCommand);
      if (owner.current.active && seq === owner.current.sequence)
        setEntries(rows);
    } catch (failure) {
      if (owner.current.active && seq === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active && seq === owner.current.sequence)
        setBusy(false);
    }
  }, [listCommand]);
  React.useEffect(() => {
    const state = owner.current;
    state.active = true;
    void reload();
    return () => {
      state.active = false;
      state.sequence++;
    };
  }, [reload]);
  const open = async (id: string) => {
    const seq = ++owner.current.sequence;
    setBusy(true);
    setError("");
    setMessage("");
    setConfirm(null);
    try {
      const entry = await invoke<ArchiveEntry>(readCommand, { id });
      if (owner.current.active && seq === owner.current.sequence) {
        setSelected(entry);
        setLimit(30);
      }
    } catch (failure) {
      if (owner.current.active && seq === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active && seq === owner.current.sequence)
        setBusy(false);
    }
  };
  const remove = async () => {
    const seq = ++owner.current.sequence;
    const action = confirm;
    setBusy(true);
    setError("");
    try {
      await invoke(
        action === "all" ? clearCommand : deleteCommand,
        action === "all" ? {} : { id: selected?.id },
      );
      if (owner.current.active && seq === owner.current.sequence) {
        setSelected(null);
        setEntries((rows) =>
          action === "all" ? [] : rows.filter((row) => row.id !== selected?.id),
        );
        setConfirm(null);
        setMessage(
          action === "all"
            ? retained
              ? "会话留存已清空"
              : "全部归档已清空"
            : retained
              ? "这条留存已删除"
              : "这份归档已删除",
        );
        await reload();
      }
    } catch (failure) {
      if (owner.current.active && seq === owner.current.sequence)
        setError(errorMessage(failure));
    } finally {
      if (owner.current.active && seq === owner.current.sequence)
        setBusy(false);
    }
  };
  const back = () => {
    owner.current.sequence++;
    setBusy(false);
    setConfirm(null);
    setError("");
    if (selected) setSelected(null);
    else onBack();
  };
  const exportData = (format: "json" | "csv") => {
    if (!selected) return;
    const data = archiveExport(selected, retained);
    downloadText(
      data[format],
      `deepseek-${retained ? "retained-session" : "archive"}-${selected.periodKey}-${archiveScopeLabel(selected.scope)}.${format}`,
      format === "json"
        ? "application/json;charset=utf-8"
        : "text/csv;charset=utf-8",
    );
    setMessage(`已发起 ${format.toUpperCase()} 下载`);
  };
  const rows = selected ? archiveLocalRows(selected) : [];
  return (
    <section className="panel history-panel local-archive-panel">
      <header className="history-header">
        <button
          className="history-icon-button"
          aria-label="返回本地统计"
          onClick={back}
        >
          <ArrowLeft size={19} />
        </button>
        <div data-tauri-drag-region>
          <h1>
            {retained
              ? selected
                ? "留存会话"
                : "会话留存"
              : selected
                ? "归档快照"
                : "历史归档"}
          </h1>
          <p>
            {retained
              ? "已读最近汇总 · 与当前统计分开"
              : "手动保留 · 与当前统计分开"}
          </p>
        </div>
        <button
          className="history-icon-button"
          aria-label={retained ? "重新读取留存" : "重新读取归档"}
          disabled={busy || Boolean(selected)}
          onClick={() => void reload()}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      <div className="history-scroll">
        {error && (
          <p className="history-message warning" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="history-message">
            {message}
          </p>
        )}
        {busy && (
          <p role="status" className="history-message">
            正在读取或处理归档…
          </p>
        )}
        {selected ? (
          <>
            <p className="history-message">
              {selected.periodKey} · {archiveScopeLabel(selected.scope)} · 采集{" "}
              {time(selected.collectedAt)}
              <br />
              {retained ? "最后留存" : "保存"} {time(selected.savedAt)} ·{" "}
              {selected.rows.length}条汇总
              {selected.stale ? " · 上次结果" : ""}
              {!selected.complete ? " · 来源不完整" : ""}
            </p>
            <div className="history-metrics local-metrics">
              <article className="card">
                <span>{retained ? "留存会话 Tokens" : "这份快照 Tokens"}</span>
                <strong>
                  {localSum(rows, "totalTokens") == null
                    ? "—"
                    : fmtTokensShort(localSum(rows, "totalTokens") || 0)}
                </strong>
              </article>
              <article className="card">
                <span>模型汇总记录</span>
                <strong>{rows.length}</strong>
              </article>
            </div>
            <div className="history-models">
              {selected.rows.slice(0, limit).map((row, index) => (
                <article
                  className="card history-model local-archive-row"
                  key={index}
                >
                  <h2>{localTools[row.tool] || row.tool}</h2>
                  <p className="local-model-name" title={row.model}>
                    {row.model}
                  </p>
                  <div className="local-quality-counts">
                    <div>
                      <span title={row.projectLabel || "未归属项目"}>
                        {row.projectLabel || "未归属项目"}
                      </span>
                      <strong>
                        {row.totalTokens == null
                          ? "—"
                          : fmtTokensShort(row.totalTokens)}{" "}
                        Tokens
                      </strong>
                    </div>
                  </div>
                  <details>
                    <summary>会话与来源</summary>
                    <p className="local-session-id">{row.sessionId}</p>
                    <p>{row.sourceLabel || "本机"}</p>
                    {row.projectPath && (
                      <p className="local-path">{row.projectPath}</p>
                    )}
                  </details>
                </article>
              ))}
            </div>
            {selected.rows.length > limit && (
              <button
                className="secondary"
                onClick={() => setLimit((value) => value + 30)}
              >
                显示更多归档记录
              </button>
            )}
            <LocalDataQuality
              rows={rows}
              partial={!selected.complete}
              stale={selected.stale}
            />
            <details className="history-details local-archive-export">
              <summary>{retained ? "导出这条留存" : "导出这份归档"}</summary>
              <p>
                {selected.includesPaths
                  ? "保存时已包含完整路径，导出也会包含。"
                  : "保存时未包含完整路径，导出不会追加路径。"}
              </p>
              <div className="disclosure-actions">
                <button className="secondary" onClick={() => exportData("csv")}>
                  CSV
                </button>
                <button
                  className="secondary"
                  onClick={() => exportData("json")}
                >
                  JSON
                </button>
              </div>
            </details>
          </>
        ) : (
          <>
            {!busy && !error && !entries.length && (
              <p className="history-message">
                {retained
                  ? "暂无会话留存。开启自动留存后，成功采集的会话会保留在这里。"
                  : "暂无归档。在本地统计中展开“保存快照与历史归档”，手动保存。"}
              </p>
            )}
            <div className="local-group-list">
              {entries.map((entry) => (
                <button
                  className="card local-group"
                  key={entry.id}
                  disabled={busy}
                  onClick={() => void open(entry.id)}
                >
                  <span className="local-group-copy">
                    <strong>
                      {entry.periodKey} ·{" "}
                      {retained && entry.tool
                        ? localTools[entry.tool] || entry.tool
                        : archiveScopeLabel(entry.scope)}
                      {retained && entry.projectLabel
                        ? ` · ${entry.projectLabel}`
                        : ""}
                    </strong>
                    <small>
                      {retained
                        ? `${entry.sourceLabel || "本机"} · ${entry.sessionId?.slice(0, 16) || "会话"} · `
                        : ""}
                      {time(entry.savedAt)} · {entry.rowCount}条
                      {entry.stale ? " · 上次结果" : ""}
                      {!entry.complete ? " · 不完整" : ""}
                    </small>
                  </span>
                  <b>查看 ›</b>
                </button>
              ))}
            </div>
          </>
        )}
        <details className="history-details local-archive-manage">
          <summary>{retained ? "管理会话留存" : "管理归档"}</summary>
          <p>
            {retained
              ? "留存是最近已读取的会话汇总，不证明日志已删除，不加入当前统计。只删除本应用留存；自动留存开启时，后续成功采集可能重新保存当前会话。"
              : "归档不会更新或合并到当前统计，不证明工具日志已删除，也不能当账单。这里只删除本应用保存的快照，不删除工具日志或引擎缓存。"}
          </p>
          <div className="disclosure-actions">
            {selected && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setConfirm("one")}
              >
                {singleLabel}
              </button>
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm("all")}
            >
              {clearLabel}
            </button>
          </div>
          {confirm && (
            <>
              <p>
                确认{confirm === "all" ? clearLabel : singleLabel}
                ？原工具日志和当前统计不变。
              </p>
              <div className="disclosure-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {`确认${confirm === "all" ? clearLabel : singleLabel}`}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </button>
              </div>
            </>
          )}
        </details>
      </div>
      <footer className="local-footer">
        <span>
          {selected
            ? `引擎 ${selected.engineVersion}`
            : `本机留存 · ${entries.length}/${retained ? 128 : 12}${retained ? "项" : "份"}`}
        </span>
      </footer>
    </section>
  );
}
