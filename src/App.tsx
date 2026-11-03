import React from "react";
import { applyStoredGlass } from "./components/GlassSettings";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppConfig,
  BalanceData,
  LoadState,
  ModelName,
  UsageResult,
  ViewName,
} from "./types";
import { nextLoadStateAfterError, todayStr } from "./format";
import { currentUsageSnapshot } from "./usage-snapshot";
import { fetchCurrentUsage, invalidateUsageRequests } from "./usage-api";
import { RequestGate } from "./request-gate";
import { errorInfo } from "./error-state";
import { THEME_STORAGE_KEY, THEME_MIGRATION_KEY, THEME_ATTR } from "./theme";
import { msUntilNextAccountingDate } from "./accounting-clock";
import { DashboardPanel } from "./components/DashboardPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ModelDetailPanel } from "./components/ModelDetailPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { LocalUsagePanel } from "./components/LocalUsagePanel";
import { TrayBalancePublisher } from "./tray-balance";

/** 自动刷新退避：只对「值得重试」的错误退避，且按通道各自计数。 */
const retryableCode = (code?: string) =>
  code === "rate_limited" || code === "unavailable" || code === "unknown";
/** 未配置 / 凭据失效：该通道暂停，不参与退避，也不拖慢健康通道。 */
const pausedCode = (code?: string) =>
  code === "not_configured" || code === "credentials_invalid";
const backoffSeconds = (base: number, failures: number) =>
  Math.min(3600, base * 2 ** Math.min(6, Math.max(0, failures)));

function App() {
  const [showDataNotices, setShowDataNotices] = React.useState(false);
  const [view, setView] = React.useState<ViewName>("dashboard");
  const [model, setModel] = React.useState<ModelName>("flash");

  const [balance, setBalance] = React.useState<BalanceData | null>(null);
  const [balanceState, setBalanceState] = React.useState<LoadState>("loading");
  const [balanceError, setBalanceError] = React.useState("");
  const [balanceErrorCode, setBalanceErrorCode] = React.useState<string>();
  const [balanceUpdatedAt, setBalanceUpdatedAt] = React.useState<number | null>(
    null,
  );
  // 「有缓存」与「当前凭据仍有效」是两件事（评审 P2：托盘有效性）。
  // 凭据失效时余额对象与这个标记一起撤销，托盘不会把被撤销凭据的金额重新发布。
  const [balanceCredentialValid, setBalanceCredentialValid] =
    React.useState(false);
  const trayPublisher = React.useRef<TrayBalancePublisher | null>(null);
  React.useEffect(() => {
    const publisher = new TrayBalancePublisher(invoke);
    trayPublisher.current = publisher;
    void publisher.start();
    return () => publisher.stop();
  }, []);
  React.useEffect(() => {
    // 只有「凭据仍有效」的快照才允许发布；loading 期间保留旧值并标旧，
    // 但凭据一旦失效就立即变 null，避免金额短暂回闪。
    const available = balanceCredentialValid && balance != null;
    trayPublisher.current?.update({
      total: available ? balance!.totalBalance : null,
      currency: available ? balance!.currency : null,
      stale: available
        ? Boolean(balanceError || balanceState === "loading")
        : false,
    });
  }, [balance, balanceState, balanceError, balanceCredentialValid]);

  const [usage, setUsage] = React.useState<UsageResult | null>(null);
  const [usageState, setUsageState] = React.useState<LoadState>("loading");
  const [usageError, setUsageError] = React.useState("");
  const [usageErrorCode, setUsageErrorCode] = React.useState<string>();
  const [usageUpdatedAt, setUsageUpdatedAt] = React.useState<number | null>(
    null,
  );
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] =
    React.useState(60);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(false);

  // silent=true 表示后台刷新：已有数据时保留旧值，不再把面板打回「查询中…」骨架，
  // 否则开启 1 分钟自动刷新后会周期性闪烁。若当前没有可用数据（首次或上次失败），
  // 仍显示加载态，避免用户对着「查询失败」无从判断是否正在重试。
  // 请求守卫（评审 F-26）：手动刷新 / 自动刷新 / 托盘唤出三条路径可能并发，
  // 慢的旧响应（HTTP 超时上限 15s）不允许覆盖新响应，只接受各自最新一次的结果。
  const balanceRequestId = React.useRef(0);
  const availableSnapshot = React.useRef({ balance: false, usage: false });
  const failures = React.useRef({ balance: 0, usage: 0 });
  // 通道暂停状态：未配置或凭据失效时置 true，健康通道不受影响（评审 P2 独立退避）。
  const paused = React.useRef({ balance: false, usage: false });
  const balanceGate = React.useRef(new RequestGate<BalanceData>());
  const loadBalance = React.useCallback((silent = false) => {
    const requestId = ++balanceRequestId.current;
    if (silent) {
      setBalanceState((prev) => (prev === "ok" ? prev : "loading"));
    } else {
      setBalanceState("loading");
    }
    return balanceGate.current
      .run(() => invoke<BalanceData>("fetch_balance"))
      .then((data) => {
        if (requestId !== balanceRequestId.current) {
          return;
        }
        availableSnapshot.current.balance = true;
        paused.current.balance = false;
        setBalance(data);
        setBalanceUpdatedAt(Date.now());
        setBalanceCredentialValid(true);
        failures.current.balance = 0;
        setBalanceState("ok");
        setBalanceError("");
      })
      .catch((error) => {
        if (requestId !== balanceRequestId.current) {
          return;
        }
        const { message, code } = errorInfo(error);
        setBalanceErrorCode(code);
        // 只有可重试错误才累加退避次数；未配置/失效凭据走暂停通道。
        paused.current.balance = pausedCode(code);
        if (retryableCode(code)) failures.current.balance += 1;
        else failures.current.balance = 0;
        // 凭据失效：撤销快照有效性，避免托盘把旧金额当成当前余额重新发布。
        // 普通网络失败保留快照，但明确标旧。
        if (pausedCode(code)) {
          availableSnapshot.current.balance = false;
          setBalanceCredentialValid(false);
          setBalance(null);
          setBalanceUpdatedAt(null);
        }
        setBalanceError(message);
        setBalanceState((prev) =>
          nextLoadStateAfterError(
            availableSnapshot.current.balance ? "ok" : prev,
            availableSnapshot.current.balance,
            message,
            code,
          ),
        );
      });
  }, []);

  const usageRequestId = React.useRef(0);
  const usageSnapshot = React.useRef<UsageResult | null>(null);
  const loadUsage = React.useCallback((silent = false) => {
    const requestId = ++usageRequestId.current;
    const retained = currentUsageSnapshot(usageSnapshot.current, todayStr());
    usageSnapshot.current = retained;
    availableSnapshot.current.usage = retained !== null;
    setUsage(retained);
    if (!retained) setUsageUpdatedAt(null);
    if (silent && retained) {
      setUsageState((prev) => (prev === "ok" ? prev : "loading"));
    } else {
      setUsageState("loading");
    }
    return fetchCurrentUsage()
      .then((data) => {
        if (requestId !== usageRequestId.current) {
          return;
        }
        const current = currentUsageSnapshot(data, todayStr());
        if (!current) throw new Error("记账月份已变化，请重新刷新用量");
        availableSnapshot.current.usage = true;
        usageSnapshot.current = current;
        setUsage(current);
        setUsageUpdatedAt(Date.now());
        failures.current.usage = 0;
        setUsageState("ok");
        setUsageError("");
      })
      .catch((error) => {
        if (requestId !== usageRequestId.current) {
          return;
        }
        const { message, code } = errorInfo(error);
        setUsageErrorCode(code);
        paused.current.usage = pausedCode(code);
        if (retryableCode(code)) failures.current.usage += 1;
        else failures.current.usage = 0;
        setUsageError(message);
        const retained = pausedCode(code)
          ? null
          : currentUsageSnapshot(usageSnapshot.current, todayStr());
        usageSnapshot.current = retained;
        availableSnapshot.current.usage = retained !== null;
        setUsage(retained);
        if (!retained) setUsageUpdatedAt(null);
        // 同一凭据下刷新失败保留快照与时间；无凭据或失效凭据仍显示对应错误。
        setUsageState((prev) =>
          nextLoadStateAfterError(
            availableSnapshot.current.usage ? "ok" : prev,
            availableSnapshot.current.usage,
            message,
            code,
          ),
        );
      });
  }, []);

  const refreshAll = React.useCallback(
    (silent = false) => {
      return Promise.all([loadBalance(silent), loadUsage(silent)]);
    },
    [loadBalance, loadUsage],
  );

  React.useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  React.useEffect(() => {
    void invoke<AppConfig>("get_app_config")
      .then((config) => {
        setRefreshIntervalSeconds(config.refreshIntervalSeconds || 60);
        setAutoRefreshEnabled(config.autoRefreshEnabled);
      })
      .catch(() => {
        setRefreshIntervalSeconds(60);
        setAutoRefreshEnabled(false);
      });
  }, []);

  // 面板是否可见。窗口隐藏不会卸载 WebView，所以自动刷新定时器必须靠这个状态显式暂停，
  // 否则面板整天收在托盘里也会按时打接口。该状态由 Rust 侧在显隐时发的事件驱动
  // （见 lib.rs 的 EVENT_MAIN_WINDOW_SHOWN / EVENT_MAIN_WINDOW_HIDDEN），
  // 这样从托盘唤出、托盘左键切换、程序内点关闭三条路径都覆盖得到。
  const [windowVisible, setWindowVisible] = React.useState(true);
  // 首帧后按实际窗口可见性校正，避免启动时若已在托盘仍多跑一轮刷新
  React.useEffect(() => {
    void invoke<boolean>("is_main_window_visible")
      .then((visible) => setWindowVisible(visible))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    const shown = listen("main-window-shown", () => {
      setWindowVisible(true);
      // 面板被唤出即拉最新数据，避免托盘唤出后看到的是旧快照。
      // 走静默刷新：唤出瞬间面板上已有上一轮的数据，不该闪一下「查询中…」。
      refreshAll(true);
    });
    const hidden = listen("main-window-hidden", () => {
      setWindowVisible(false);
    });
    return () => {
      void shown.then((unlisten) => unlisten());
      void hidden.then((unlisten) => unlisten());
    };
  }, [refreshAll]);

  React.useEffect(() => {
    if (!autoRefreshEnabled || !windowVisible) {
      return;
    }
    // 两路各自调度（评审 P2）：余额与用量互不影响。
    // 未配置/失效凭据的通道直接暂停，不让它把健康通道的周期拖到 1 小时。
    // 用 setTimeout 链而非 setInterval：睡眠唤醒后 interval 可能连发补帧，
    // 链式调度总是等上一次结束后再计时。
    let cancelled = false;
    const timers = new Set<number>();
    const schedule = (
      channel: "balance" | "usage",
      run: (silent: boolean) => Promise<unknown>,
    ) => {
      if (cancelled) return;
      const delay = paused.current[channel]
        ? 0
        : backoffSeconds(refreshIntervalSeconds, failures.current[channel]);
      const timer = window.setTimeout(
        () => {
          timers.delete(timer);
          if (cancelled) return;
          // 暂停通道：不联网，但保留定时器以便凭据恢复后重新纳入调度。
          if (paused.current[channel]) {
            schedule(channel, run);
            return;
          }
          void run(true).finally(() => schedule(channel, run));
        },
        paused.current[channel]
          ? Math.min(300, refreshIntervalSeconds) * 1000
          : delay * 1000,
      );
      timers.add(timer);
    };
    schedule("balance", loadBalance);
    schedule("usage", loadUsage);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [
    autoRefreshEnabled,
    loadBalance,
    loadUsage,
    refreshIntervalSeconds,
    windowVisible,
  ]);

  const hideWindow = React.useCallback(() => {
    void invoke("hide_main_window").catch(() => {
      // Browser preview has no Tauri IPC. Keep it non-blocking for visual checks.
    });
  }, []);

  // 记账日期驱动（评审 P1：跨月后不能把旧累计称为「本月」）。
  // 独立于刷新路径：即使自动刷新关闭、用户一直开着面板，跨过北京时间月界时
  // 也要立即让旧月累计失效。这里**只失效、不联网**——是否重新请求仍由刷新策略决定，
  // 不在用户不知情时启用自动联网。
  React.useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const check = () => {
      if (cancelled) return;
      // currentUsageSnapshot 自带跨月拒绝；这里把它当作「日期变化探测器」。
      const retained = currentUsageSnapshot(usageSnapshot.current, todayStr());
      if (usageSnapshot.current && retained !== usageSnapshot.current) {
        usageSnapshot.current = retained;
        availableSnapshot.current.usage = retained !== null;
        setUsage(retained);
        if (!retained) {
          setUsageUpdatedAt(null);
          setUsageState((prev) => (prev === "ok" ? "error" : prev));
          setUsageError("记账月份已变化，请刷新本月用量");
          setUsageErrorCode("invalid_data");
        } else {
          setUsage(retained);
        }
      }
      timer = window.setTimeout(check, msUntilNextAccountingDate());
    };
    // 同时监听系统唤醒：睡眠跨月时定时器可能被推迟。
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // 无论设置页是否挂载，登录同步成功都使旧凭据响应失效并刷新主数据。
  React.useEffect(() => {
    const captured = listen("usage-token-captured", () => {
      usageRequestId.current += 1;
      invalidateUsageRequests();
      availableSnapshot.current.usage = false;
      usageSnapshot.current = null;
      setUsage(null);
      setUsageUpdatedAt(null);
      void loadUsage();
    });
    const cleared = listen("usage-token-cleared", () => {
      usageRequestId.current += 1;
      invalidateUsageRequests();
      availableSnapshot.current.usage = false;
      usageSnapshot.current = null;
      setUsage(null);
      setUsageUpdatedAt(null);
      setUsageState("nokey");
      setUsageError("未配置用量 Token");
    });
    const browsingCleared = listen("browsing-data-cleared", () => {
      const current = document.documentElement.getAttribute(THEME_ATTR);
      localStorage.setItem(
        THEME_STORAGE_KEY,
        current === "dark" ? "dark" : "light",
      );
      localStorage.setItem(THEME_MIGRATION_KEY, "1");
    });
    return () => {
      void captured.then((unlisten) => unlisten()).catch(() => undefined);
      void cleared.then((unlisten) => unlisten()).catch(() => undefined);
      void browsingCleared
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [loadUsage]);

  React.useEffect(() => {
    applyStoredGlass();
  }, []);
  return (
    <div
      className={`stage ${["dashboard", "local", "history"].includes(view) ? "with-navigation" : ""}`}
    >
      {view === "dashboard" && (
        <DashboardPanel
          onHistory={() => setView("history")}
          balanceUpdatedAt={balanceUpdatedAt}
          usageUpdatedAt={usageUpdatedAt}
          balance={balance}
          balanceState={balanceState}
          balanceError={balanceError}
          usage={usage}
          usageState={usageState}
          usageError={usageError}
          onRefresh={() => refreshAll()}
          onClose={hideWindow}
          onSettings={() => {
            setShowDataNotices(false);
            setView("settings");
          }}
          onDataStatus={() => {
            setShowDataNotices(true);
            setView("settings");
          }}
          onDetail={(nextModel) => {
            setModel(nextModel);
            setView("detail");
          }}
        />
      )}
      {view === "settings" && (
        <SettingsPanel
          balanceState={balanceState}
          usageState={usageState}
          balanceErrorCode={balanceErrorCode}
          usageErrorCode={usageErrorCode}
          onRetry={() => refreshAll(true)}
          balanceUpdatedAt={balanceUpdatedAt}
          usageUpdatedAt={usageUpdatedAt}
          balanceError={balanceError}
          usageError={usageError}
          showDataNotices={showDataNotices}
          usage={usage}
          onBalanceLoaded={(nextBalance) => {
            balanceRequestId.current += 1;
            balanceGate.current.invalidate();
            availableSnapshot.current.balance = true;
            setBalance(nextBalance);
            setBalanceUpdatedAt(Date.now());
            setBalanceState("ok");
            setBalanceError("");
          }}
          onBalanceCleared={() => {
            balanceRequestId.current += 1;
            balanceGate.current.invalidate();
            availableSnapshot.current.balance = false;
            setBalance(null);
            setBalanceUpdatedAt(null);
            setBalanceState("nokey");
            setBalanceError("");
          }}
          onUsageLoaded={(nextUsage) => {
            const current = currentUsageSnapshot(nextUsage, todayStr());
            if (!current) {
              void loadUsage();
              return;
            }
            // 设置页的刷新代表更新的意图：作废 App 侧在途的旧请求，
            // 避免慢响应返回后把设置页刚拿到的数据覆盖掉
            usageRequestId.current += 1;
            availableSnapshot.current.usage = true;
            usageSnapshot.current = current;
            setUsage(current);
            setUsageUpdatedAt(Date.now());
            setUsageState("ok");
            setUsageError("");
          }}
          onUsageCleared={() => {
            usageRequestId.current += 1;
            invalidateUsageRequests();
            availableSnapshot.current.usage = false;
            usageSnapshot.current = null;
            setUsage(null);
            setUsageUpdatedAt(null);
            setUsageState("nokey");
            setUsageError("未配置用量 Token");
          }}
          onRefreshIntervalChanged={setRefreshIntervalSeconds}
          onAutoRefreshChanged={setAutoRefreshEnabled}
          onBack={() => setView("dashboard")}
        />
      )}
      {view === "detail" && (
        <ModelDetailPanel
          onDataStatus={() => {
            setShowDataNotices(true);
            setView("settings");
          }}
          updatedAt={usageUpdatedAt}
          onSettings={() => {
            setShowDataNotices(false);
            setView("settings");
          }}
          model={model}
          usage={usage}
          usageState={usageState}
          usageError={usageError}
          onBack={() => setView("dashboard")}
        />
      )}
      {view === "history" && (
        <HistoryPanel onBack={() => setView("dashboard")} />
      )}
      {view === "local" && (
        <LocalUsagePanel onBack={() => setView("dashboard")} />
      )}
      {["dashboard", "local", "history"].includes(view) && (
        <nav className="primary-navigation" aria-label="主导航">
          {(
            [
              ["dashboard", "账户"],
              ["local", "Agent"],
              ["history", "历史"],
            ] as const
          ).map(([target, label]) => (
            <button
              key={target}
              aria-current={view === target ? "page" : undefined}
              onClick={() => setView(target)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
export { App };
