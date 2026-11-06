import React from "react";
import { HistoryTrend } from "./HistoryTrend";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { todayStr, fmtTokensShort, fmtMoneyDisplay, mmdd } from "../format";
import { historyDateLabel } from "../history-date-label";
import { updateTime, snapshotAge } from "../data-display";
import { fetchMonthUsage } from "../usage-api";
import { historyCache } from "../history-cache";
import {
  buildHistory,
  historyWindow,
  historyDates,
  historyExport,
  sumModels,
  isUnusedHistoryModel,
} from "../history";
import {
  classifyHistoryFailure,
  historyFailureOutcome,
  failedMonthsOnly,
} from "../history-failure";
import type { HistoryRange, HistorySnapshot } from "../history";
import type { RawModelUsage } from "../types";

const knownSum = (models: RawModelUsage[], field: "totalTokens" | "cost") =>
  !models.length || models.some((model) => model[field] == null)
    ? null
    : models.reduce((sum, model) => sum + model[field]!, 0);
const valueText = (value: number | null, metric: "totalTokens" | "cost") =>
  value == null
    ? "—"
    : metric === "cost"
      ? fmtMoneyDisplay(value)
      : fmtTokensShort(value);

// 日期显示规则在 history-date-label（纯函数，可单测）。
const dateLabel = (date: string, from: string, to: string) =>
  historyDateLabel(date, from, to, mmdd);

export function HistoryPanel({
  onBack,
  onLocalUsage,
}: {
  onBack: () => void;
  onLocalUsage?: () => void;
}) {
  const [range, setRange] = React.useState<HistoryRange>("month");
  const [selectedMonth, setSelectedMonth] = React.useState(
    todayStr().slice(0, 7),
  );
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [metric, setMetric] = React.useState<"totalTokens" | "cost">(
    "totalTokens",
  );
  const [showUnused, setShowUnused] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const [snapshot, setSnapshot] = React.useState<HistorySnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [recovery, setRecovery] = React.useState<
    "configure" | "relogin" | "retry" | "partial" | null
  >(null);
  const [failed, setFailed] = React.useState<string[]>([]);
  const [exportStatus, setExportStatus] = React.useState("");
  const snapshotEpoch = React.useRef(-1);
  const [clock, setClock] = React.useState(Date.now);
  const epoch = React.useSyncExternalStore(
    historyCache.subscribe,
    historyCache.epoch,
  );
  React.useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  const date = todayStr();
  const sequence = React.useRef({ value: 0 });
  // 全部历史分批加载（评审 P2）：先查最近一批，明确「还有更早月份未加载」，
  // 不把未加载误当成「平台没有记录」。`loadedFrom` 记录已请求到的最早月份。
  const BATCH_MONTHS = 12;
  // 用 ref 而非 state：它只影响「继续加载」的目标范围，不需要触发重渲染，
  // 也避免把它放进 request 依赖后与重置 effect 形成循环。
  const loadedFrom = React.useRef<string | null>(null);
  // 快照也走 ref：继续加载时需要读上一批结果，但不应让 request 依赖它而重置列表。
  const snapshotRef = React.useRef<HistorySnapshot | null>(null);
  const request = React.useCallback(
    async (
      force = false,
      monthsOnly: string[] | null = null,
      older = false,
    ) => {
      const id = ++sequence.current.value;
      const requestedEpoch = historyCache.epoch();
      const window = historyWindow(range, date, selectedMonth);
      // 三种模式：
      // - 默认：`all` 只请求最近一批；其他区间请求整个窗口。
      // - `monthsOnly`：只重试失败月份。
      // - `older=true`：把已加载范围再往前扩一批。
      let targets: string[];
      if (monthsOnly) {
        targets = failedMonthsOnly(monthsOnly, window.months);
      } else if (range === "all") {
        const alreadyLoaded = loadedFrom.current;
        targets = older
          ? window.months
              .filter((month) => alreadyLoaded != null && month < alreadyLoaded)
              .slice(-BATCH_MONTHS)
          : window.months.slice(-BATCH_MONTHS);
      } else {
        targets = window.months;
      }
      // 未加载月份 = 窗口内**早于本次已覆盖范围**的月份。
      // 已加载的月份（含本次目标与之前批次）都不算未加载；只有还没查过的更早月份才算。
      const requested = new Set(targets);
      // 本次请求**计划**覆盖到的最早月份；若中途因鉴权/限流停止，
      // 实际覆盖范围会回退到「已成功加载的最早月份」（见下方 unloaded 重算）。
      const plannedFrom = monthsOnly
        ? loadedFrom.current
        : (targets[0] ?? null);
      const unloadedFor = (coveredFrom: string | null) =>
        window.months.filter(
          (month) =>
            !requested.has(month) && coveredFrom != null && month < coveredFrom,
        );
      const unloaded = unloadedFor(plannedFrom);
      setBusy(true);
      setError("");
      setRecovery(null);
      setExportStatus("");
      // 继续加载更早月份时，保留已加载的月份，只追加新结果。
      const kept =
        older && snapshotRef.current ? snapshotRef.current.months : [];
      const successful: HistorySnapshot["months"] = [...kept];
      const failed: string[] = [];
      setProgress({ done: 0, total: targets.length });
      for (const month of [...targets].reverse()) {
        if (
          id !== sequence.current.value ||
          requestedEpoch !== historyCache.epoch()
        )
          return;
        const [year, number] = month.split("-").map(Number);
        try {
          successful.push(
            await historyCache.get(
              month,
              () => fetchMonthUsage(number, year),
              force,
            ),
          );
        } catch (failure) {
          const classified = classifyHistoryFailure(failure, month);
          const outcome = historyFailureOutcome(classified, [...failed, month]);
          failed.push(month);
          // 凭据/限流类失败立即停止：不让循环对每个月份重复无效请求。
          if (!outcome.continue) {
            setProgress({
              done: successful.length + failed.length,
              total: targets.length,
            });
            if (successful.length) {
              snapshotEpoch.current = requestedEpoch;
              // 提前停止时，实际覆盖范围比计划小：未查的月份必须继续算「未加载」。
              const actualFrom = successful
                .map((month) => month.month)
                .sort()[0];
              setSnapshot(
                buildHistory(
                  window,
                  [...successful],
                  [...failed],
                  unloadedFor(actualFrom ?? null),
                ),
              );
            }
            setFailed(failed);
            setRecovery(outcome.recovery);
            setError(outcome.text);
            setBusy(false);
            return;
          }
        }
        if (
          id !== sequence.current.value ||
          requestedEpoch !== historyCache.epoch()
        )
          return;
        setProgress({
          done: successful.length + failed.length,
          total: targets.length,
        });
        if (successful.length) {
          snapshotEpoch.current = requestedEpoch;
          setSnapshot(
            buildHistory(window, [...successful], [...failed], unloaded),
          );
        }
      }
      // 记录本次已加载到的最早月份，供「继续加载更早月份」使用。
      // 用实际成功的月份而不是计划目标：若最早就那个月失败，边界应停在它之后。
      if (!monthsOnly && range === "all" && successful.length) {
        loadedFrom.current = successful.map((month) => month.month).sort()[0];
      }
      setFailed(failed);
      if (failed.length) {
        setRecovery("partial");
        setError(`${failed.length}个月份未取得，未返回日期标为未知。`);
      }

      setBusy(false);
    },
    [range, date, selectedMonth],
  );
  React.useEffect(() => {
    setSnapshot(null);
    setSelected("");
    loadedFrom.current = null;
    void request();
    const owner = sequence.current;
    return () => {
      owner.value++;
    };
  }, [request, epoch]);
  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const summaryModels = snapshot
    ? sumModels(
        range === "30days"
          ? snapshot.rows.map((row) => row.model)
          : snapshot.months.flatMap((month) => month.usage.rawModels ?? []),
      )
    : [];
  const knownNames = new Set(summaryModels.map((model) => model.model));
  const dailyOnly =
    snapshot && range !== "30days"
      ? sumModels(snapshot.rows.map((row) => row.model)).filter(
          (model) => !knownNames.has(model.model),
        )
      : [];
  const allModels = [...summaryModels, ...dailyOnly];
  const models = selected
    ? allModels.filter((model) => model.model === selected)
    : allModels;
  const unusedModels = new Set(
    allModels
      .filter(
        (model) =>
          isUnusedHistoryModel(model) &&
          !snapshot?.rows.some(
            (row) =>
              row.model.model === model.model &&
              !isUnusedHistoryModel(row.model),
          ),
      )
      .map((model) => model.model),
  );
  const visibleModels = models.filter(
    (model) => showUnused || selected || !unusedModels.has(model.model),
  );
  const rows =
    snapshot?.rows.filter((row) => !selected || row.model.model === selected) ??
    [];
  const days =
    range === "all" && snapshot
      ? snapshot.window.months.map((month) => ({
          date: `${month}-01`,
          value: knownSum(
            (
              snapshot.months.find((item) => item.month === month)?.usage
                .rawModels ?? []
            ).filter((model) => !selected || model.model === selected),
            metric,
          ),
        }))
      : snapshot
        ? historyDates(snapshot.window.from, snapshot.window.to).map(
            (date) => ({
              date,
              value: knownSum(
                rows.filter((row) => row.date === date).map((row) => row.model),
                metric,
              ),
            }),
          )
        : [];
  const warnings = [
    ...new Set(
      snapshot?.months.flatMap((month) => month.usage.warnings ?? []) ?? [],
    ),
  ];
  const stale = Boolean(error && snapshot);
  const fetchedAt = snapshot?.months.length
    ? Math.min(...snapshot.months.map((month) => month.fetchedAt))
    : null;
  const legacy = snapshot?.months.some(
    (month) => month.usage.schemaVersion !== 2,
  );
  const download = (format: "csv" | "json") => {
    if (!snapshot || busy || snapshotEpoch.current !== historyCache.epoch())
      return;
    const exported = historyExport(snapshot, Date.now(), stale);
    const blob = new Blob([exported[format]], {
      type:
        format === "csv"
          ? "text/csv;charset=utf-8"
          : "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `deepseek-usage-${snapshot.window.from}-${snapshot.window.to}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    setExportStatus(`已发起 ${format.toUpperCase()} 下载`);
  };

  return (
    <section className="panel history-panel" data-testid="history-panel">
      <header className="history-header">
        <button
          className="history-icon-button"
          aria-label="返回主面板"
          onClick={onBack}
        >
          <ArrowLeft size={19} />
        </button>
        <div data-tauri-drag-region>
          <h1>用量历史</h1>
          <p>北京时间记账 · 平台已返回记录</p>
        </div>
        <button
          className="history-icon-button"
          aria-label="重新查询历史"
          disabled={busy}
          onClick={() => void request(true)}
        >
          <RefreshCw size={18} className={busy ? "refresh-spin" : undefined} />
        </button>
      </header>
      <div className="history-range" role="group" aria-label="历史统计区间">
        {(
          [
            ["month", "本月"],
            ["previous", "上月"],
            ["30days", "近30天"],
            ["custom", "历史月份"],
            ["all", "全部"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={range === value}
            onClick={() => setRange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {range === "custom" && (
        <label className="history-month-picker">
          月份
          <input
            type="month"
            aria-label="历史月份"
            min="2020-01"
            max={date.slice(0, 7)}
            value={selectedMonth}
            onChange={(event) => {
              if (
                event.target.value &&
                event.target.value >= "2020-01" &&
                event.target.value <= date.slice(0, 7)
              )
                setSelectedMonth(event.target.value);
            }}
          />
        </label>
      )}
      {range === "all" && (
        <p className="history-all-note">
          2020年起平台可返回记录 · 先加载最近 {BATCH_MONTHS} 个月
          {snapshot?.unloadedMonths.length
            ? ` · 还有 ${snapshot.unloadedMonths.length} 个月未加载`
            : ""}
          {snapshot?.unloadedMonths.length ? (
            <button
              className="link-button"
              disabled={busy}
              onClick={() => void request(false, null, true)}
            >
              继续加载更早月份 ›
            </button>
          ) : null}
        </p>
      )}
      <div className="history-scroll">
        {onLocalUsage && (
          <button className="local-entry" onClick={onLocalUsage}>
            项目与会话<span>本机 Agent 用量 ›</span>
          </button>
        )}
        <label className="history-filter">
          模型
          <select
            aria-label="历史模型"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">全部模型</option>
            {allModels.map((model) => (
              <option key={model.model} value={model.model}>
                {model.model}
              </option>
            ))}
          </select>
        </label>
        <div className="history-metrics">
          <article className="card">
            <span>已返回 Tokens</span>
            <strong>
              {valueText(knownSum(models, "totalTokens"), "totalTokens")}
            </strong>
          </article>
          <article className="card">
            <span>已返回费用</span>
            <strong>{valueText(knownSum(models, "cost"), "cost")}</strong>
          </article>
        </div>
        {error && (
          <p className="history-message warning" role="alert">
            {error}
            {stale && !snapshot?.failedMonths.length
              ? " · 保留上次查询结果"
              : ""}
          </p>
        )}
        {recovery && !busy && (
          <div className="disclosure-actions history-recovery">
            {recovery === "relogin" && (
              <button
                className="secondary"
                onClick={() => {
                  // 重新登录入口在设置页；这里只提示去向，不在此处重复实现同步。
                  onBack();
                }}
              >
                去设置页重新同步 Token
              </button>
            )}
            {recovery === "configure" && (
              <button className="secondary" onClick={onBack}>
                去设置页配置用量 Token
              </button>
            )}
            {failed.length > 0 && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void request(false, failed)}
              >
                只重试失败月份（{failed.length}）
              </button>
            )}
          </div>
        )}
        {busy && (
          <p className="history-message" role="status">
            正在查询 {progress.done}/{progress.total} 个月…
            <button
              className="history-cancel"
              onClick={() => {
                sequence.current.value++;
                setBusy(false);
                setError("查询已停止；未加载月份标为未知，可重新查询。");
              }}
            >
              停止查询
            </button>
          </p>
        )}
        {snapshot && (
          <>
            <article className="card history-chart">
              <div className="history-chart-title">
                <h2>{range === "all" ? "每月趋势" : "每日趋势"}</h2>
                <div role="group" aria-label="趋势指标">
                  <button
                    aria-pressed={metric === "totalTokens"}
                    onClick={() => setMetric("totalTokens")}
                  >
                    Tokens
                  </button>
                  <button
                    aria-pressed={metric === "cost"}
                    onClick={() => setMetric("cost")}
                  >
                    费用
                  </button>
                </div>
              </div>
              <HistoryTrend
                key={`${range}-${selected}-${metric}`}
                days={days}
                monthly={range === "all"}
                metric={metric}
                dateLabel={(value) =>
                  dateLabel(value, snapshot.window.from, snapshot.window.to)
                }
              />
            </article>
            {unusedModels.size > 0 && (
              <label className="history-unused-toggle">
                <input
                  type="checkbox"
                  checked={showUnused}
                  onChange={(event) => setShowUnused(event.target.checked)}
                />
                显示无用量模型（{unusedModels.size}）
              </label>
            )}
            <div className="history-models">
              {visibleModels.map((model) => (
                <details className="card history-model" key={model.model}>
                  <summary>
                    <span title={model.model}>{model.model}</span>
                    <div>
                      <strong>
                        {valueText(model.totalTokens, "totalTokens")}
                      </strong>
                      <strong>{valueText(model.cost, "cost")}</strong>
                    </div>
                  </summary>
                  <div className="history-breakdown">
                    {(
                      [
                        ["请求数", model.requestCount],
                        ["缓存命中", model.cacheHitTokens],
                        ["未命中输入", model.cacheMissTokens],
                        ["输出", model.responseTokens],
                        ["未归类", model.otherTokens],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong
                          title={value == null ? "未取得" : String(value)}
                        >
                          {valueText(value, "totalTokens")}
                        </strong>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
            {!visibleModels.length && (
              <p className="history-message">
                {models.length
                  ? "该区间模型均无用量，可开启上方选项查看。"
                  : "尚未取得该区间的模型明细。"}
              </p>
            )}
            <details className="history-details">
              <summary>每日明细 · {rows.length}条记录</summary>
              <table>
                <thead>
                  <tr>
                    <th>日期 / 模型</th>
                    <th>Tokens</th>
                    <th>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.date}-${row.model.model}`}>
                      <td>
                        {dateLabel(
                          row.date,
                          snapshot.window.from,
                          snapshot.window.to,
                        )}
                        <span title={row.model.model}>{row.model.model}</span>
                      </td>
                      <td>{valueText(row.model.totalTokens, "totalTokens")}</td>
                      <td>{valueText(row.model.cost, "cost")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <details className="history-details">
              <summary>
                数据来源与状态
                {snapshot.failedMonths.length ||
                snapshot.missingDates.length ||
                warnings.length ||
                legacy
                  ? " · 待核对"
                  : ""}
              </summary>
              <p>
                DeepSeek 平台用量及费用接口；仅当前本机网页登录会话，不与余额
                Key 做账户匹配，也不与本地工具日志相加。
              </p>
              <p>
                最早成功查询：{updateTime(fetchedAt, true)}
                （本机时间）；数据年龄：
                {snapshotAge(fetchedAt, clock)}。
              </p>
              <p>
                {snapshot.window.from} 至 {snapshot.window.to}；
                {snapshot.missingDates.length}
                个日期未返回模型明细，不代表零用量。近30天汇总只覆盖已返回记录。
              </p>
              {legacy && (
                <p>当前响应缺少新版原始模型明细，请使用最新桌面程序。</p>
              )}
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </details>
          </>
        )}
      </div>
      <footer className="history-export">
        <button
          title="导出区间内全部模型的每日记录"
          disabled={!snapshot || busy || legacy}
          onClick={() => download("csv")}
        >
          <Download size={14} />
          CSV
        </button>
        <button
          title="导出每日记录及所查询月份的完整汇总"
          disabled={!snapshot || busy || legacy}
          onClick={() => download("json")}
        >
          <Download size={14} />
          JSON
        </button>
        <span role="status">{exportStatus || "导出全部模型 · 不含凭据"}</span>
      </footer>
    </section>
  );
}
