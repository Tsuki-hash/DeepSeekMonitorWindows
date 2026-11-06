import React from "react";
import { HistoryTrend } from "./HistoryTrend";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { todayStr, fmtTokensShort, fmtMoneyDisplay, mmdd } from "../format";
import { historyDateLabel } from "../history-date-label";
import { mergeHistoryMonths } from "../history-merge";
import type { HistoryScope } from "../history-merge";
import { updateTime, snapshotAge } from "../data-display";
import { fetchMonthUsage } from "../usage-api";
import { historyCache } from "../history-cache";
import {
  buildHistory,
  historyWindow,
  historyDates,
  historyExport,
  returnedHistoryModels,
  retainHistoryWindow,
  safeKnownSum,
  isUnusedHistoryModel,
} from "../history";
import {
  classifyHistoryFailure,
  historyFailureOutcome,
  failedMonthsOnly,
} from "../history-failure";
import type { HistoryRange, HistorySnapshot } from "../history";

// 复评 R17：顶部/趋势合计改用共享的安全版本（Token 检查安全整数，
// 金额只检查有限），不再用裸 reduce 产生不安全整数。
const knownSum = safeKnownSum;
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
  onConfigureUsage,
  usageTokenConfigured = true,
  windowVisible = true,
}: {
  onBack: () => void;
  /** 直接打开并定位到用量 Token 设置（复评 F10：不能只回首页）。 */
  onConfigureUsage?: () => void;
  /** 真实配置状态：区分「首次配置」与「凭据失效」，不能默认当成失效。 */
  usageTokenConfigured?: boolean;
  /** Native tray visibility; a hidden WebView remains mounted. */
  windowVisible?: boolean;
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
  // The display clock may invalidate the date label, never the request identity.
  const date = todayStr();
  const visibleRef = React.useRef(windowVisible);
  visibleRef.current = windowVisible;
  const configuredRef = React.useRef(usageTokenConfigured);
  configuredRef.current = usageTokenConfigured;
  const requestInProgress = React.useRef(false);
  const needsInitialQuery = React.useRef(true);
  const sequence = React.useRef({ value: 0 });
  // 全部历史分批加载（评审 P2）：先查最近一批，明确「还有更早月份未加载」，
  // 不把未加载误当成「平台没有记录」。`loadedFrom` 记录已请求到的最早月份。
  const BATCH_MONTHS = 12;
  // 用 ref 而非 state：它只影响「继续加载」的目标范围，不需要触发重渲染，
  // 也避免把它放进 request 依赖后与重置 effect 形成循环。
  const loadedFrom = React.useRef<string | null>(null);
  // 快照也走 ref：继续加载时需要读上一批结果，但不应让 request 依赖它而重置列表。
  const snapshotRef = React.useRef<HistorySnapshot | null>(null);
  // 复评 R02/R05：上一批的作用域身份与累计失败月份，供合并器判断能否继承。
  const previousScopeRef = React.useRef<HistoryScope | null>(null);
  const failedRef = React.useRef<string[]>([]);
  // 凭据代际：账号/Token 变化时递增，避免跨账户继承旧月份。
  const scopeEpoch = React.useRef(0);
  React.useEffect(() => {
    // historyCache 的 epoch 在凭据变化时递增；镜像到本地代际用于作用域比较。
    scopeEpoch.current = epoch;
  }, [epoch]);
  const request = React.useCallback(
    async (
      force = false,
      monthsOnly: string[] | null = null,
      older = false,
    ) => {
      // Date ticks and hidden windows cannot initiate a query. An explicit
      // refresh/show reads the current date, rather than a captured render date.
      if (!visibleRef.current) return;
      const id = ++sequence.current.value;
      const requestedEpoch = historyCache.epoch();
      const window = historyWindow(range, todayStr(), selectedMonth);
      const requestedScope: HistoryScope = {
        range,
        from: window.from,
        to: window.to,
        epoch: requestedEpoch,
      };
      const previousScope = previousScopeRef.current;
      const sameSelection =
        previousScope?.epoch === requestedEpoch &&
        previousScope.range === range &&
        (range !== "custom" ||
          previousScope.from.slice(0, 7) === selectedMonth);
      const canRetain =
        sameSelection &&
        snapshotRef.current != null &&
        snapshotEpoch.current === requestedEpoch;
      // A rolling date window is not a new user selection or account. Rebase
      // the same account's source months, without changing their as-of dates.
      const retained = canRetain
        ? retainHistoryWindow(snapshotRef.current!, window)
        : null;
      // 三种模式：
      // - 默认：`all` 首次请求最近一批，刷新保留并覆盖已加载范围。
      // - `monthsOnly`：只重试失败月份（保留其他成功月份）。
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
          : alreadyLoaded == null
            ? window.months.slice(-BATCH_MONTHS)
            : window.months.filter((month) => month >= alreadyLoaded);
      } else {
        targets = window.months;
      }
      // 本次请求之前已成功取得的月份：重试与继续加载都要保留它们。
      const previousMonths = retained?.months ?? [];
      // 复评 R05：失败月份跨批次持久，只有本次成功才清除。
      const previousFailed = sameSelection
        ? failedRef.current.filter((month) => window.months.includes(month))
        : [];
      const attempted: string[] = [];
      const successful: HistorySnapshot["months"] = [];
      const failedMonths: string[] = [];
      // 复评 R04：所有写状态的地方都必须先确认「这次请求仍然有效」。
      // 旧请求在切换范围/取消/换凭据后返回，只能丢弃，不得覆盖新状态。
      const stillOwner = () =>
        visibleRef.current &&
        id === sequence.current.value &&
        requestedEpoch === historyCache.epoch() &&
        scopeEpoch.current === requestedScope.epoch;
      // 统一收尾：按月份合并（区分 attempted/successful/failed/unloaded），
      // 正常结束与提前停止走同一条边界计算（复评 F02/R02/R05）。
      const commit = (stopText?: string) => {
        const merged = mergeHistoryMonths({
          scope: requestedScope,
          previousScope: sameSelection ? requestedScope : null,
          windowMonths: window.months,
          planned: targets,
          attempted,
          successful,
          previous: previousMonths,
          failed: failedMonths,
          previousFailed,
        });
        if (merged.coveredFrom && range === "all") {
          const previousFrom = loadedFrom.current;
          loadedFrom.current =
            previousFrom != null && previousFrom < merged.coveredFrom
              ? previousFrom
              : merged.coveredFrom;
        }
        if (successful.length || previousMonths.length) {
          snapshotEpoch.current = requestedEpoch;
          // A rolling window can have unqueried months above the old loaded
          // range (e.g. "load older" after a month boundary). Do not rely on
          // the merge helper's older-only, contiguous-range approximation.
          const accounted = new Set([
            ...merged.months.map((month) => month.month),
            ...merged.failedMonths,
          ]);
          const next = buildHistory(
            window,
            merged.months,
            merged.failedMonths,
            window.months.filter((month) => !accounted.has(month)),
          );
          snapshotRef.current = next;
          setSnapshot(next);
          // 复评 T03：快照、作用域身份与失败集合必须**同一次提交**。
          // 原实现只在整批结束或分类错误终止时记录 scope，首次批次中途停止
          // （停止查询/新请求使 sequence 失效）后 scope 仍为 null，
          // 继续加载时同身份月份被合并器的防线拒绝继承，用户已看到的月份静默消失。
        }
        // Failed-only batches also own a scope, even without a usable snapshot.
        previousScopeRef.current = requestedScope;
        setFailed(merged.failedMonths);
        failedRef.current = merged.failedMonths;
        if (stopText) {
          setRecovery(stopText as never);
        } else if (merged.failedMonths.length) {
          setRecovery("partial");
          setError(
            `${merged.failedMonths.length}个月份未取得，未返回日期标为未知。`,
          );
        } else {
          // A retry may clear the final failure after earlier commits in the
          // same batch showed partial recovery. Clear that intermediate status.
          setRecovery(null);
          setError("");
        }
      };
      needsInitialQuery.current = false;
      requestInProgress.current = true;
      setBusy(true);
      setError("");
      setRecovery(null);
      setExportStatus("");
      setProgress({ done: 0, total: targets.length });
      for (const month of [...targets].reverse()) {
        if (!stillOwner()) return;
        attempted.push(month);
        const [year, number] = month.split("-").map(Number);
        try {
          successful.push(
            await historyCache.get(
              month,
              // A registered cache request is already in flight and can be
              // shared by a new valid consumer (including effect replay).
              // Page ownership guards the loop/commit, not this shared loader.
              () => fetchMonthUsage(number, year),
              force,
            ),
          );
        } catch (failure) {
          // 复评 R04：先复核所有权，迟到的失败结果直接丢弃。
          if (!stillOwner()) return;
          const classified = classifyHistoryFailure(failure, month);
          const outcome = historyFailureOutcome(
            classified,
            [...failedMonths, month],
            configuredRef.current,
          );
          failedMonths.push(month);
          // 凭据/限流类失败立即停止：不让循环对每个月份重复无效请求。
          if (!outcome.continue) {
            setProgress({ done: attempted.length, total: targets.length });
            setError(outcome.text);
            commit(outcome.recovery);
            requestInProgress.current = false;
            setBusy(false);
            return;
          }
        }
        if (!stillOwner()) return;
        setProgress({ done: attempted.length, total: targets.length });
        commit();
      }
      if (!stillOwner()) return;
      commit();
      requestInProgress.current = false;
      setBusy(false);
    },
    [range, selectedMonth],
  );
  React.useEffect(() => {
    // Only an actual range/month selection or credential epoch clears data.
    // A display clock tick must not discard loaded batches or model filters.
    sequence.current.value++;
    requestInProgress.current = false;
    needsInitialQuery.current = true;
    snapshotEpoch.current = -1;
    setSnapshot(null);
    setSelected("");
    setBusy(false);
    setError("");
    setRecovery(null);
    setFailed([]);
    setExportStatus("");
    loadedFrom.current = null;
    // 复评 R02：切范围时必须同步清空快照与继承来源，否则 request 会读到旧月份。
    snapshotRef.current = null;
    previousScopeRef.current = null;
    failedRef.current = [];
    if (visibleRef.current) void request();
    const owner = sequence.current;
    return () => {
      owner.value++;
    };
  }, [request, epoch]);
  const previousVisible = React.useRef(windowVisible);
  React.useEffect(() => {
    const wasVisible = previousVisible.current;
    previousVisible.current = windowVisible;
    if (!windowVisible) {
      sequence.current.value++;
      if (requestInProgress.current) {
        requestInProgress.current = false;
        setBusy(false);
        setError(
          "窗口已隐藏，后续月份查询已停止；已取得记录保留，可重新查询或继续加载。",
        );
      }
      return;
    }
    if (wasVisible) return;
    setClock(Date.now());
    const retained = snapshotRef.current;
    const nextWindow = historyWindow(range, todayStr(), selectedMonth);
    // Showing the native window is an explicit refresh opportunity, matching
    // App's tray contract. A fixed historical month has no new date window.
    if (needsInitialQuery.current || !retained) {
      void request();
    } else if (
      retained.window.from !== nextWindow.from ||
      retained.window.to !== nextWindow.to
    ) {
      // Catch up only the former open month and newly entered months. Earlier
      // all-history batches stay intact and are not fetched again on every show.
      // Force the former open month too: its last-day cache may still be warm.
      const changedMonths = nextWindow.months.filter(
        (month) => month >= retained.window.to.slice(0, 7),
      );
      void request(
        true,
        changedMonths.length ? changedMonths : nextWindow.months.slice(-1),
      );
    }
  }, [windowVisible, range, selectedMonth, request]);
  React.useEffect(() => {
    const tick = () => setClock(Date.now());
    const timer = window.setInterval(tick, 60000);
    // Browser wake-up only updates labels. Native show above owns any query.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const currentWindow = historyWindow(range, date, selectedMonth);
  const windowOutdated = Boolean(
    snapshot &&
    (snapshot.window.from !== currentWindow.from ||
      snapshot.window.to !== currentWindow.to),
  );
  const earlierUnloaded =
    snapshot?.unloadedMonths.filter(
      (month) => loadedFrom.current != null && month < loadedFrom.current,
    ) ?? [];
  const pendingLoadedMonths =
    snapshot?.unloadedMonths.filter(
      (month) => loadedFrom.current != null && month >= loadedFrom.current,
    ) ?? [];
  const summaryModels = snapshot ? returnedHistoryModels(snapshot) : [];
  const knownNames = new Set(summaryModels.map((model) => model.model));
  // Source-only models remain selectable, but absent day fields remain unknown.
  // Never borrow a full source month's totals for a returned-day aggregate.
  const sourceOnly = snapshot
    ? [
        ...new Map(
          snapshot.months
            .flatMap((month) => month.usage.rawModels ?? [])
            .filter((model) => !knownNames.has(model.model))
            .map(
              (model) =>
                [
                  model.model,
                  {
                    ...model,
                    totalTokens: null,
                    requestCount: null,
                    cacheHitTokens: null,
                    cacheMissTokens: null,
                    responseTokens: null,
                    otherTokens: null,
                    cost: null,
                  },
                ] as const,
            ),
        ).values(),
      ]
    : [];
  const allModels = [...summaryModels, ...sourceOnly];
  const models = selected
    ? summaryModels.filter((model) => model.model === selected)
    : summaryModels;
  const displayedModels = selected
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
  const visibleModels = displayedModels.filter(
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
            returnedHistoryModels(snapshot, month).filter(
              (model) => !selected || model.model === selected,
            ),
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
  const stale = Boolean(error && snapshot) || windowOutdated;
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
          {earlierUnloaded.length > 0 ? (
            <button
              className="link-button"
              disabled={busy}
              onClick={() => void request(false, null, true)}
            >
              继续加载更早月份 ›
            </button>
          ) : null}
          {pendingLoadedMonths.length > 0 && (
            <button
              className="link-button"
              disabled={busy}
              onClick={() => void request(true, pendingLoadedMonths)}
            >
              补查未加载月份（{pendingLoadedMonths.length}）
            </button>
          )}
        </p>
      )}
      <div className="history-scroll">
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
            <span>已返回日记录 Tokens</span>
            <strong>
              {valueText(knownSum(models, "totalTokens"), "totalTokens")}
            </strong>
          </article>
          <article className="card">
            <span>已返回日记录费用</span>
            <strong>{valueText(knownSum(models, "cost"), "cost")}</strong>
          </article>
        </div>
        {snapshot && (
          <p className="history-message">
            当前记录：{snapshot.window.from} 至 {snapshot.window.to}。
            {snapshot.missingDates.length ||
            snapshot.unloadedMonths.length ||
            snapshot.failedMonths.length
              ? ` 覆盖不完整：${snapshot.missingDates.length} 日未返回、${snapshot.unloadedMonths.length} 个月未加载、${snapshot.failedMonths.length} 个月查询失败。小计不代表完整区间用量。`
              : " 汇总只包含已返回日记录。"}
          </p>
        )}
        {windowOutdated && snapshot && (
          <p className="history-message warning" role="status">
            记账日期已变化，当前仍为 {snapshot.window.from} 至{" "}
            {snapshot.window.to}
            的已查询记录。重新查询或重新显示窗口时更新，已加载范围与模型筛选保留。
          </p>
        )}
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
                onClick={() => (onConfigureUsage ?? onBack)()}
              >
                去设置页重新同步 Token
              </button>
            )}
            {recovery === "configure" && (
              <button
                className="secondary"
                onClick={() => (onConfigureUsage ?? onBack)()}
              >
                去设置页配置用量 Token
              </button>
            )}
            {failed.length > 0 && (
              <button
                className="secondary"
                disabled={busy}
                // 第五轮复评 N01：失败月份重试必须 force —— 否则 5 分钟 TTL 内
                // 会直接命中旧成功缓存，不发出请求却把旧值当本次成功，
                // 清掉 failed/error 表现成「已恢复」。
                onClick={() => void request(true, failed)}
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
                requestInProgress.current = false;
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
                <h2>{range === "all" ? "每月已返回日记录合计" : "每日趋势"}</h2>
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
              <summary>平台原始月汇总 · 独立来源口径</summary>
              <p>
                以下保留平台月接口原值，可能包含未返回每日明细的用量，不能当作上方已返回日合计。
                当前月仅截至来源查询日；JSON 将这些值单列为
                sourceMonthlySnapshots。
              </p>
              <table>
                <thead>
                  <tr>
                    <th>来源月份 / 模型</th>
                    <th>原始月 Tokens</th>
                    <th>原始月费用</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.months.flatMap((month) =>
                    (month.usage.rawModels ?? [])
                      .filter((model) => !selected || model.model === selected)
                      .map((model) => (
                        <tr key={`${month.month}-${model.model}`}>
                          <td>
                            {month.month}
                            <span title={model.model}>{model.model}</span>
                          </td>
                          <td>{valueText(model.totalTokens, "totalTokens")}</td>
                          <td>{valueText(model.cost, "cost")}</td>
                        </tr>
                      )),
                  )}
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
                个日期未返回模型明细，不代表零用量。所有区间的顶部、模型汇总与趋势均只合计
                已返回日记录，与 CSV 日记录及 JSON monthly
                同源；未返回、未加载不补零。
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
          title="导出已返回日记录、同源区间月合计及独立的原始月来源"
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
