import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Folder, Layers, RefreshCw } from "lucide-react";
import { fmtTokensShort } from "../format";
import { updateTime } from "../data-display";
import { errorMessage } from "../error-state";
import { localExport } from "../local-export";
import { downloadText } from "../download";
import { LocalSourceSettings } from "./LocalSourceSettings";
import { LocalDataQuality, LocalRowQuality } from "./LocalDataQuality";
import { LocalArchiveCapture } from "./LocalArchiveCapture";
import { LocalArchivePanel } from "./LocalArchivePanel";
import { LocalBackgroundSettings } from "./LocalBackgroundSettings";
import { localPeriodKey } from "../local-archive";
import {
  localTools,
  localProjects,
  localSessions,
  localAverageRate,
  localSum,
  LocalRateTracker,
} from "../local-usage";
import type { LocalRow, LocalSnapshot, LocalUsageStatus } from "../local-usage";

const tokens = (value: number | null) =>
  value == null ? "—" : fmtTokensShort(value);
const speed = (value: number | null) =>
  value == null ? "—" : `${value.toFixed(1)} tok/s`;

export function LocalUsagePanel({ onBack }: { onBack: () => void }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = React.useState<
    "stats" | "data" | "settings"
  >("stats");
  const [enabled, setEnabled] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<LocalSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState<"projects" | "sessions">("projects");
  const [project, setProject] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<string | null>(null);
  const scrollPositions = React.useRef(new Map<string, number>());
  const scrollKey = JSON.stringify([workspace, project, session, tab]);
  React.useLayoutEffect(() => {
    scrollRef.current?.scrollTo(0, scrollPositions.current.get(scrollKey) ?? 0);
  }, [scrollKey]);
  React.useEffect(() => {
    if (error) scrollRef.current?.scrollTo(0, 0);
  }, [error]);
  const [limit, setLimit] = React.useState(30);
  const [clock, setClock] = React.useState(Date.now);
  const [includePaths, setIncludePaths] = React.useState(false);
  const [exportStatus, setExportStatus] = React.useState("");
  const [sourceRevision, setSourceRevision] = React.useState(0);
  const [archiveView, setArchiveView] = React.useState<
    "manual" | "retention" | null
  >(null);
  const control = React.useRef({ sequence: 0, inFlight: false });
  const tracker = React.useRef(new LocalRateTracker());
  const background = React.useRef(false);
  const backgroundMode = React.useCallback((enabled: boolean) => {
    if (background.current !== enabled) {
      background.current = enabled;
      tracker.current.reset();
      setBusy(false);
    }
  }, []);
  const scan = React.useCallback(async (visibleOnly = false) => {
    if (control.current.inFlight) return;
    control.current.inFlight = true;
    const sequence = control.current.sequence;
    let collecting = false;
    try {
      if (visibleOnly && !(await invoke<boolean>("is_main_window_visible")))
        return;
      if (visibleOnly && background.current) {
        const status = await invoke<LocalUsageStatus>("get_local_usage");
        if (sequence !== control.current.sequence) return;
        if (status.snapshot) tracker.current.observe(status.snapshot.rows);
        setSnapshot(status.snapshot);
        setError(status.lastError || "");
        collecting = status.busy === true;
        setClock(Date.now());
        return;
      }
      setBusy(true);
      const next = await invoke<LocalSnapshot>("scan_local_usage");
      if (sequence !== control.current.sequence) return;
      tracker.current.observe(next.rows);
      setSnapshot(next);
      setError("");
      setClock(Date.now());
    } catch (failure) {
      if (sequence !== control.current.sequence) return;
      tracker.current.reset();
      setError(errorMessage(failure));
    } finally {
      control.current.inFlight = false;
      if (sequence === control.current.sequence) setBusy(collecting);
    }
  }, []);
  React.useEffect(() => {
    const owner = control.current;
    const sequence = owner.sequence;
    void invoke<LocalUsageStatus>("get_local_usage")
      .then((status) => {
        if (sequence !== owner.sequence) return;
        setEnabled(status.enabled);
        setSnapshot(status.snapshot);
        setError(status.lastError || "");
        setReady(true);
      })
      .catch((failure) => {
        if (sequence === owner.sequence) {
          setReady(true);
          setError(errorMessage(failure));
        }
      });
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      owner.sequence++;
      window.clearInterval(timer);
    };
  }, []);
  React.useEffect(() => {
    if (!ready || !enabled || archiveView) return;
    void scan(true);
    const timer = window.setInterval(() => void scan(true), 3000);
    return () => window.clearInterval(timer);
  }, [ready, enabled, scan, sourceRevision, archiveView]);
  React.useEffect(() => {
    if (snapshot?.periodKey && snapshot.periodKey !== localPeriodKey(clock)) {
      tracker.current.reset();
      setSnapshot(null);
      setProject(null);
      setSession(null);
      setExportStatus("");
    }
  }, [clock, snapshot]);
  const toggle = async () => {
    setChanging(true);
    try {
      const status = await invoke<LocalUsageStatus>("set_local_usage_enabled", {
        enabled: !enabled,
      });
      control.current.sequence++;
      tracker.current.reset();
      setSnapshot(null);
      setBusy(false);
      setEnabled(status.enabled);
      setError("");
      setProject(null);
      setSession(null);
      setExportStatus("");
      if (!status.enabled) setWorkspace("stats");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setChanging(false);
    }
  };
  const rows = snapshot?.rows ?? [];
  const projects = localProjects(rows);
  const scoped =
    project == null
      ? rows
      : (projects.find((group) => group.key === project)?.rows ?? []);
  const sessions = localSessions(scoped);
  const selected =
    session == null ? null : sessions.find((group) => group.key === session);
  const recent = tracker.current.reading(clock);
  const displayed: LocalRow[] =
    session == null ? scoped : (selected?.rows ?? []);
  const scope =
    session != null ? "session" : project != null ? "project" : "all";
  React.useEffect(() => {
    setExportStatus("");
    setIncludePaths(false);
  }, [project, session]);
  const exportData = (format: "csv" | "json") => {
    if (!snapshot || !enabled || busy || changing) return;
    const data = localExport(
      snapshot,
      displayed,
      scope,
      includePaths,
      Boolean(error),
    );
    downloadText(
      data[format],
      `deepseek-local-${scope}-${new Date(snapshot.collectedAt).toISOString().slice(0, 10)}.${format}`,
      format === "csv"
        ? "text/csv;charset=utf-8"
        : "application/json;charset=utf-8",
    );
    setExportStatus(`已发起 ${format.toUpperCase()} 下载`);
  };
  const back = () => {
    if (workspace !== "stats") setWorkspace("stats");
    else if (session != null) setSession(null);
    else if (project != null) setProject(null);
    else onBack();
  };
  if (archiveView)
    return (
      <LocalArchivePanel
        key={archiveView}
        mode={archiveView}
        onBack={() => {
          setArchiveView(null);
          setSourceRevision((value) => value + 1);
        }}
      />
    );
  return (
    <section
      className="panel history-panel local-usage-panel"
      data-testid="local-usage-panel"
    >
      <header className="history-header">
        <button
          className="history-icon-button"
          aria-label="返回上一级"
          onClick={back}
        >
          <ArrowLeft size={19} />
        </button>
        <div data-tauri-drag-region>
          <h1
            title={
              workspace === "stats"
                ? projects.find((group) => group.key === project)?.label
                : undefined
            }
          >
            {workspace === "settings"
              ? "采集设置"
              : workspace === "data"
                ? "数据管理"
                : selected
                  ? "会话明细"
                  : project != null
                    ? projects.find((group) => group.key === project)?.label ||
                      "项目明细"
                    : "Agent 用量"}
          </h1>
          <p>本月 · 本机记录，独立于平台账单</p>
        </div>
        <button
          className="history-icon-button"
          aria-label="刷新本地用量"
          disabled={!enabled || busy || changing}
          onClick={() => void scan()}
        >
          <RefreshCw size={18} className={busy ? "refresh-spin" : undefined} />
        </button>
      </header>
      <div className="local-workspace-nav" role="group" aria-label="Agent 页面">
        {(
          [
            ["stats", "用量统计"],
            ["data", "数据"],
            ["settings", "采集设置"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            aria-pressed={workspace === key}
            onClick={() => setWorkspace(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {workspace === "stats" && enabled && !selected && project == null && (
        <div className="history-range" role="group" aria-label="本地用量视图">
          <button
            aria-pressed={tab === "projects"}
            onClick={() => {
              setTab("projects");
              setLimit(30);
            }}
          >
            项目
          </button>
          <button
            aria-pressed={tab === "sessions"}
            onClick={() => {
              setTab("sessions");
              setLimit(30);
            }}
          >
            会话
          </button>
        </div>
      )}
      <div
        className="history-scroll"
        ref={scrollRef}
        onScroll={(event) =>
          scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop)
        }
      >
        {error && (
          <p role="alert" className="history-message warning">
            {error}
            {snapshot ? " · 保留上次采集结果" : ""}
          </p>
        )}
        <div hidden={workspace !== "stats"}>
          {snapshot?.rows.length === 0 && !error && (
            <article className="local-empty">
              <Folder size={24} aria-hidden="true" />
              <h2>还没有本月记录</h2>
              <p>
                先在 Agent 中完成一次调用；日志在其他目录时，可指定采集位置。
              </p>
              <button
                className="secondary"
                onClick={() => setWorkspace("settings")}
              >
                检查采集目录
              </button>
            </article>
          )}
          {snapshot?.complete === false && (
            <p className="history-message warning" role="status">
              部分目录未取得数据，当前合计只含成功来源。
            </p>
          )}
          {!ready && (
            <p className="history-message" role="status">
              正在加载本地统计…
            </p>
          )}
          {ready && !enabled && (
            <article className="card local-welcome">
              <Folder size={27} />
              <h2>你的 Agent，用了多少？</h2>
              <p>
                项目、会话、生成速度，一处查看。仅在你开启后读取本机用量记录。
              </p>
              <p>
                支持 OpenCode、Claude Code、ZCode、Hermes、OpenClaw、DeepSeek
                Harness。
              </p>
              <button
                className="primary"
                disabled={!ready || changing}
                onClick={() => void toggle()}
              >
                {changing ? "开启中…" : "开启本地统计"}
              </button>
            </article>
          )}
          {enabled && (
            <>
              {snapshot?.rows.length !== 0 && (
                <div className="history-metrics local-metrics">
                  <article className="card">
                    <span>
                      {selected
                        ? "会话 Tokens"
                        : snapshot?.complete === false
                          ? "已读取 Tokens"
                          : project != null
                            ? "项目 Tokens"
                            : "本月 Tokens"}
                    </span>
                    <strong>
                      {tokens(localSum(displayed, "totalTokens"))}
                    </strong>
                  </article>
                  <article className="card">
                    <span>
                      {selected || project != null || !recent
                        ? "平均生成速度"
                        : recent.fresh
                          ? "新增记录速度"
                          : "最近生成速度"}
                    </span>
                    <strong className="local-rate">
                      {speed(
                        selected || project != null || !recent
                          ? localAverageRate(displayed)
                          : recent.rate,
                      )}
                    </strong>
                  </article>
                </div>
              )}
              {busy && !snapshot && (
                <p role="status" className="history-message">
                  正在读取本地记录…
                </p>
              )}
              {selected ? (
                <>
                  <p className="local-session-id" title={selected.label}>
                    {localTools[selected.rows[0].tool]} · {selected.label}
                  </p>
                  <p className="local-path" title={selected.path || undefined}>
                    {selected.path || "未归属项目"}
                  </p>
                  <div className="history-models">
                    {selected.rows.map((row) => (
                      <article className="card history-model" key={row.id}>
                        <h2 className="local-model-name" title={row.model}>
                          {row.model}
                        </h2>
                        <LocalRowQuality row={row} />
                        <div className="history-breakdown">
                          {(
                            [
                              ["输入", row.input],
                              ["输出（含推理）", row.output],
                              ["缓存读取", row.cacheRead],
                              ["缓存写入", row.cacheWrite],
                              ["推理子集", row.reasoning],
                              ["记录条数", row.messageCount],
                            ] as const
                          ).map(([label, value]) => (
                            <div key={label}>
                              <span>{label}</span>
                              <strong
                                title={value == null ? "未取得" : String(value)}
                              >
                                {tokens(value)}
                              </strong>
                            </div>
                          ))}
                        </div>
                        <p className="local-model-speed">
                          {speed(localAverageRate([row]))} · 平均生成速度
                        </p>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="local-group-list">
                  {(project != null || tab === "sessions" ? sessions : projects)
                    .slice(0, limit)
                    .map((group) => (
                      <button
                        className="card local-group"
                        key={group.key}
                        onClick={() => {
                          setLimit(30);
                          if (project != null || tab === "sessions")
                            setSession(group.key);
                          else setProject(group.key);
                        }}
                      >
                        <span className="local-group-icon">
                          {project != null || tab === "sessions" ? (
                            <Layers size={17} />
                          ) : (
                            <Folder size={17} />
                          )}
                        </span>
                        <span className="local-group-copy">
                          <strong title={group.path || group.label}>
                            {project != null || tab === "sessions"
                              ? `${localTools[group.rows[0].tool]} · ${group.label}`
                              : group.label}
                          </strong>
                          <small>
                            {group.rows[0].sourceId &&
                            group.rows[0].sourceId !== "native"
                              ? `${group.rows[0].sourceLabel} · `
                              : ""}
                            {project != null || tab === "sessions"
                              ? `${group.rows.length} 个模型 · ${group.path ? group.path.replace(/\\/g, "/").split("/").pop() : "未归属"}`
                              : `${localSessions(group.rows).length} 个会话 · ${[...new Set(group.rows.map((row) => localTools[row.tool]))].join(" / ")}`}
                          </small>
                        </span>
                        <b>{tokens(localSum(group.rows, "totalTokens"))}</b>
                      </button>
                    ))}
                  {(project != null || tab === "sessions" ? sessions : projects)
                    .length > limit && (
                    <button
                      className="secondary"
                      onClick={() => setLimit((value) => value + 30)}
                    >
                      显示更多
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div hidden={workspace !== "settings"}>
          <LocalSourceSettings
            onSaved={() => {
              control.current.sequence++;
              tracker.current.reset();
              setSnapshot(null);
              setBusy(false);
              setError("");
              setProject(null);
              setSession(null);
              setExportStatus("");
              setSourceRevision((value) => value + 1);
            }}
          />
        </div>
        <div hidden={workspace !== "data"}>
          <div className="local-scope-card">
            <span>当前范围</span>
            <strong
              title={
                selected?.label ||
                projects.find((group) => group.key === project)?.label ||
                "全部本地记录"
              }
            >
              {selected?.label ||
                projects.find((group) => group.key === project)?.label ||
                "全部本地记录"}
            </strong>
            <small>
              {scope === "session"
                ? "会话"
                : scope === "project"
                  ? "项目"
                  : "本月"}{" "}
              · {displayed.length} 条模型记录
            </small>
          </div>
          {snapshot?.sources && snapshot.sources.length > 0 && (
            <details className="history-details local-source-health">
              <summary>{error ? "上次来源状态" : "来源状态"}</summary>
              {snapshot.sources.map((source) => (
                <p key={source.id}>
                  <strong>{source.label}</strong> ·{" "}
                  {source.state === "ok"
                    ? "已读取"
                    : source.state === "duplicate"
                      ? "重复目录已合并"
                      : "未取得"}
                  {source.message ? ` · ${source.message}` : ""}
                </p>
              ))}
            </details>
          )}
          {enabled && snapshot && (
            <LocalDataQuality
              rows={displayed}
              partial={snapshot.complete === false}
              stale={Boolean(error)}
            />
          )}
          {enabled && (
            <details className="history-details local-export">
              <summary>
                导出
                {scope === "session"
                  ? "当前会话"
                  : scope === "project"
                    ? "当前项目"
                    : "全部本地记录"}
              </summary>
              <label className="local-export-option">
                <input
                  type="checkbox"
                  checked={includePaths}
                  onChange={(event) => setIncludePaths(event.target.checked)}
                />
                包含项目完整路径
              </label>
              <div className="disclosure-actions">
                <button
                  className="secondary"
                  disabled={!snapshot || busy || changing}
                  onClick={() => exportData("csv")}
                >
                  CSV
                </button>
                <button
                  className="secondary"
                  disabled={!snapshot || busy || changing}
                  onClick={() => exportData("json")}
                >
                  JSON
                </button>
              </div>
              <p>
                不含凭据、源标题或对话正文；默认不含完整路径。Token可能含来源估算，不能作为账单。
              </p>
              {exportStatus && <p role="status">{exportStatus}</p>}
            </details>
          )}
          <LocalArchiveCapture
            retentionWarning={snapshot?.retentionWarning}
            collectedAt={snapshot?.collectedAt || null}
            scope={
              session != null
                ? { kind: "session", key: session, projectKey: project }
                : project != null
                  ? { kind: "project", key: project }
                  : { kind: "all" }
            }
            disabled={!enabled || busy || changing}
            onOpen={(mode) => {
              control.current.sequence++;
              tracker.current.reset();
              setBusy(false);
              setArchiveView(mode);
            }}
          />
        </div>
        <div hidden={workspace !== "settings"}>
          <LocalBackgroundSettings
            localEnabled={enabled}
            onMode={backgroundMode}
          />
          <details className="history-details local-explanation">
            <summary>关于本地数据与速度</summary>
            <p>
              统计口径由工具日志与采集引擎决定。部分旧版日志缺少原始计数时，引擎会估算
              Token；此版不能逐条区分实测和估算，不能作为实际账单。
            </p>
            <p>
              解析工具的本地记录，仅展示用量元数据，不展示或上传对话正文与源代码。项目路径用于本机归属。引擎在本应用目录缓存统计元数据，可能包含源会话标题；界面不展示这些标题。
            </p>
            <p>
              统计包含本机六款工具记录的所有模型，未验证它们是否属于当前
              DeepSeek
              账户；不与平台账单相加。本月按电脑本地日期查询，部分工具仅有会话累计，期间归属以源记录时间为准，不保证按日分摊。重新采集替换快照，不累计重复刷新。
            </p>
            <p>
              tok/s = 匹配记录的输出 Token ÷
              生成耗时；推理是否包含在输出中按来源规范化。首次读取显示平均值，后续新增性能记录显示近期速度；8秒后转为最近速度，3分钟后回到平均值。不是逐Token流式测速；缺失或部分耗时显示
              —。
            </p>
            <p>
              生成耗时通常在调用结束后落盘；来源未记录的项目、Token或耗时不会猜测。此版提供会话按模型明细，逐条请求详情暂未接入。默认仅在本页可见时采集；可单独开启后台采集，在收起后继续更新。关闭统计暂停采集并清除内存结果，保留已有会话留存与引擎缓存，原工具记录不删除。
            </p>
            <p>
              默认统计本机目录，可添加额外主目录或支持工具的数据路径，WSL目录只读取确认运行的发行版；不同来源不合并同名会话。可指定ZCode本地数据库，其WSL数据库路径暂不支持。本地费用不估算，避免与峰谷实际账单混淆。
            </p>
          </details>
          {enabled && (
            <button
              className="secondary local-stop"
              disabled={changing}
              onClick={() => void toggle()}
            >
              {changing ? "关闭中…" : "关闭本地统计"}
            </button>
          )}
        </div>
      </div>
      <footer className="local-footer">
        <span>
          {snapshot
            ? `更新 ${updateTime(snapshot.collectedAt)}${error ? " · 旧数据" : ""}`
            : enabled
              ? "等待首次采集"
              : "统计未开启"}
        </span>
        <span>本机 · 不上传</span>
      </footer>
    </section>
  );
}
