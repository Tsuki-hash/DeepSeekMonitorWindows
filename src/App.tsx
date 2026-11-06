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
import { balancePublishable } from "./refresh-policy";
import { useChannelScheduler } from "./use-channel-scheduler";
import {
  initialChannelState,
  onChannelFailure,
  onChannelSuccess,
  onCredentialChanged,
  scheduledDelaySeconds,
} from "./channel-state";
import type { ChannelState } from "./channel-state";
import { DashboardPanel } from "./components/DashboardPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ModelDetailPanel } from "./components/ModelDetailPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { LocalUsagePanel } from "./components/LocalUsagePanel";
import { TrayBalancePublisher } from "./tray-balance";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { onboardingTasks, shouldShowOnboarding } from "./onboarding";
import { panelModeLabel, suggestedMode } from "./panel-mode";
import type { PanelMode } from "./panel-mode";
import { Maximize2, Minimize2 } from "lucide-react";
import { attemptLeave, resolveLeave, useLeaveGuard } from "./leave-guard";
import { LeaveDecisions } from "./leave-guard";
import type { LeaveDecision } from "./leave-guard";
import { draftGuardActions, draftGuardText } from "./draft-guard";

// 刷新退避与托盘发布策略抽到 refresh-policy（纯函数，可单测）。

function App() {
  const [showDataNotices, setShowDataNotices] = React.useState(false);
  // 复评 R16：设置页需要定位到用量 Token 区块时由这里指定。
  const [settingsTarget, setSettingsTarget] = React.useState<
    "usageToken" | null
  >(null);
  const [view, setView] = React.useState<ViewName>("dashboard");
  // 全局离开拦截（复评 F09）：任何导航出口都先问 blocker，草稿不再被静默丢弃。
  const { blocker: leaveBlocker, register: registerLeaveBlocker } =
    useLeaveGuard();
  const [pendingLeave, setPendingLeave] = React.useState<{
    action: () => void;
    subject: string;
  } | null>(null);
  // 复评 R08：保存是异步的，用户可能在途中取消或连点。
  // 用代际令牌确保只有最新决策能执行导航，且保存中禁用按钮。
  const leaveDecisions = React.useRef(new LeaveDecisions());
  const [leaveSubmitting, setLeaveSubmitting] = React.useState(false);
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
    const published = balancePublishable({
      credentialValid: balanceCredentialValid,
      balance,
      stale: Boolean(balanceError || balanceState === "loading"),
    });
    trayPublisher.current?.update({
      total: published?.totalBalance ?? null,
      currency: published?.currency ?? null,
      stale: published?.stale ?? false,
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
  // 退避基数用 ref 读取：它只影响「下次间隔」，不应改变 loadBalance/loadUsage 的
  // 回调身份（否则每次改间隔都会重建请求函数并打断在途刷新）。
  const refreshIntervalRef = React.useRef(60);
  React.useEffect(() => {
    refreshIntervalRef.current = refreshIntervalSeconds;
  }, [refreshIntervalSeconds]);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(false);
  // 每通道独立的状态版本（复评 R01）：一个通道的变化不得重排另一个通道。
  const [channelRevision, setChannelRevision] = React.useState({
    balance: 0,
    usage: 0,
  });

  // silent=true 表示后台刷新：已有数据时保留旧值，不再把面板打回「查询中…」骨架，
  // 否则开启 1 分钟自动刷新后会周期性闪烁。若当前没有可用数据（首次或上次失败），
  // 仍显示加载态，避免用户对着「查询失败」无从判断是否正在重试。
  // 请求守卫（评审 F-26）：手动刷新 / 自动刷新 / 托盘唤出三条路径可能并发，
  // 慢的旧响应（HTTP 超时上限 15s）不允许覆盖新响应，只接受各自最新一次的结果。
  const balanceRequestId = React.useRef(0);
  const availableSnapshot = React.useRef({ balance: false, usage: false });
  // 通道状态（复评 F01/F05）：暂停、失败数、下次延迟由同一状态机维护。
  // 原先 paused/failures 分散在两个 ref，且调度重算时丢掉 code，退避从未生效。
  const channels = React.useRef({
    balance: initialChannelState(60),
    usage: initialChannelState(60),
  });
  const applyChannel = React.useCallback(
    (name: "balance" | "usage", next: ChannelState) => {
      channels.current[name] = next;
      // 只递增本通道的版本：另一通道的 timer 与截止时间保持不变。
      setChannelRevision((value) => ({
        ...value,
        [name]: value[name] + 1,
      }));
    },
    [],
  );
  const balanceGate = React.useRef(new RequestGate<BalanceData>());
  const loadBalance = React.useCallback(
    (silent = false) => {
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
          applyChannel(
            "balance",
            onChannelSuccess(
              channels.current.balance,
              refreshIntervalRef.current,
            ),
          );
          setBalance(data);
          setBalanceUpdatedAt(Date.now());
          setBalanceCredentialValid(true);
          setBalanceState("ok");
          setBalanceError("");
          setBalanceErrorCode(undefined);
        })
        .catch((error) => {
          if (requestId !== balanceRequestId.current) {
            return;
          }
          const { message, code } = errorInfo(error);
          setBalanceErrorCode(code);
          const next = onChannelFailure(
            channels.current.balance,
            code,
            refreshIntervalRef.current,
          );
          applyChannel("balance", next);
          // 凭据失效：撤销快照有效性，避免托盘把旧金额当成当前余额重新发布。
          // 普通网络失败保留快照，但明确标旧。
          if (next.paused) {
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
    },
    [applyChannel],
  );

  const usageRequestId = React.useRef(0);
  const usageSnapshot = React.useRef<UsageResult | null>(null);
  const loadUsage = React.useCallback(
    (silent = false) => {
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
          applyChannel(
            "usage",
            onChannelSuccess(
              channels.current.usage,
              refreshIntervalRef.current,
            ),
          );
          setUsage(current);
          setUsageUpdatedAt(Date.now());
          setUsageState("ok");
          setUsageError("");
          setUsageErrorCode(undefined);
        })
        .catch((error) => {
          if (requestId !== usageRequestId.current) {
            return;
          }
          const { message, code } = errorInfo(error);
          setUsageErrorCode(code);
          const next = onChannelFailure(
            channels.current.usage,
            code,
            refreshIntervalRef.current,
          );
          applyChannel("usage", next);
          setUsageError(message);
          const retained = next.paused
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
    },
    [applyChannel],
  );

  const refreshAll = React.useCallback(
    (silent = false) => {
      return Promise.all([loadBalance(silent), loadUsage(silent)]);
    },
    [loadBalance, loadUsage],
  );

  React.useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // 首次使用分流（评审 P2）：只在三个任务都未完成时出现，任一完成即收起。
  const [onboardingDismissed, setOnboardingDismissed] = React.useState(false);
  const [configSnapshot, setConfigSnapshot] = React.useState<{
    apiKeyConfigured: boolean;
    usageTokenConfigured: boolean;
  } | null>(null);

  // 配置状态必须能被重新读取：保存/清除凭据、开启本地统计后，
  // 首次引导与历史页的恢复文案都依赖它（复评 F12）。
  const reloadConfig = React.useCallback(() => {
    return invoke<AppConfig>("get_app_config")
      .then((config) => {
        setRefreshIntervalSeconds(config.refreshIntervalSeconds || 60);
        setAutoRefreshEnabled(config.autoRefreshEnabled);
        setConfigSnapshot({
          apiKeyConfigured: config.apiKeyConfigured,
          usageTokenConfigured: config.usageTokenConfigured,
        });
        return config;
      })
      .catch(() => {
        setRefreshIntervalSeconds(60);
        setAutoRefreshEnabled(false);
        return null;
      });
  }, []);
  React.useEffect(() => {
    void reloadConfig();
  }, [reloadConfig]);

  // 本地统计是否开启（复评 R09）：引导卡与历史页都要用真实状态。
  // 原实现只在启动时读一次，用户在同会话里启停本地采集后引导仍显示旧状态。
  // 现在封装成可重读函数，并在进入首页/Agent 页时刷新（开关就在这些页面上）。
  const [localEnabled, setLocalEnabled] = React.useState(false);
  const [localStatusLoaded, setLocalStatusLoaded] = React.useState(false);
  const reloadLocalStatus = React.useCallback(() => {
    return invoke<{ enabled: boolean }>("get_local_usage")
      .then((status) => {
        setLocalEnabled(status.enabled === true);
        setLocalStatusLoaded(true);
        return status.enabled === true;
      })
      .catch(() => {
        setLocalStatusLoaded(true);
        return null;
      });
  }, []);
  React.useEffect(() => {
    void reloadLocalStatus();
  }, [reloadLocalStatus]);
  // 每次回到首页或 Agent 页都重新读取：这两个页面可能刚改过开关。
  React.useEffect(() => {
    if (view === "dashboard" || view === "local") void reloadLocalStatus();
  }, [reloadLocalStatus, view]);

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

  // 两路各自独立调度（复评 R01）：每个通道有自己的 timer 与截止时间，
  // 一个通道完成不会推迟另一个通道的退避截止时间。
  const balanceDelay = scheduledDelaySeconds({
    ...channels.current.balance,
    nextDelaySeconds:
      channels.current.balance.failures === 0 &&
      !channels.current.balance.paused
        ? refreshIntervalSeconds
        : channels.current.balance.nextDelaySeconds,
  });
  const usageDelay = scheduledDelaySeconds({
    ...channels.current.usage,
    nextDelaySeconds:
      channels.current.usage.failures === 0 && !channels.current.usage.paused
        ? refreshIntervalSeconds
        : channels.current.usage.nextDelaySeconds,
  });
  useChannelScheduler({
    enabled: autoRefreshEnabled,
    visible: windowVisible,
    paused: channels.current.balance.paused,
    delaySeconds: balanceDelay,
    run: () => loadBalance(true),
    revision: channelRevision.balance,
  });
  useChannelScheduler({
    enabled: autoRefreshEnabled,
    visible: windowVisible,
    paused: channels.current.usage.paused,
    delaySeconds: usageDelay,
    run: () => loadUsage(true),
    revision: channelRevision.usage,
  });

  // 面板尺寸（评审 P2）：用户显式切换后固定，不再被视图建议覆盖。
  const [manualMode, setManualMode] = React.useState<PanelMode | null>(null);
  const mode = suggestedMode(view, manualMode);
  React.useEffect(() => {
    void invoke("set_panel_mode", { mode }).catch(() => {
      // 浏览器预览没有 Tauri IPC；尺寸切换失败不影响数据展示。
    });
  }, [mode]);

  // 配置尚未读取完成时不展示引导，避免把老用户当新手（复评 F12）。
  // 复评 R09：加载完成条件必须覆盖所依赖的状态，否则启动瞬间可能用默认值判断。
  const configLoaded = configSnapshot !== null && localStatusLoaded;
  const showOnboarding =
    configLoaded &&
    shouldShowOnboarding({
      apiKeyConfigured: configSnapshot.apiKeyConfigured,
      usageTokenConfigured: configSnapshot.usageTokenConfigured,
      localEnabled,
      dismissed: onboardingDismissed,
    });

  // 统一的导航出口：有未保存草稿时先拦下来，用户决定后再执行。
  const navigate = React.useCallback(
    (action: () => void) => {
      if (attemptLeave(leaveBlocker.current, action) === "blocked") {
        setPendingLeave({
          action,
          subject: leaveBlocker.current?.subject ?? "当前设置",
        });
      }
    },
    [leaveBlocker],
  );

  const decideLeave = React.useCallback(
    (decision: LeaveDecision) => {
      const pending = pendingLeave;
      if (!pending) return;
      if (decision === "cancel") {
        // 取消使当前令牌失效：保存途中迟到的成功也不得导航。
        leaveDecisions.current.cancel(leaveDecisions.current.begin());
        setPendingLeave(null);
        setLeaveSubmitting(false);
        return;
      }
      if (leaveSubmitting) return; // 连点只认第一次
      const ticket = leaveDecisions.current.begin();
      setLeaveSubmitting(true);
      void resolveLeave(leaveBlocker.current, decision, pending.action, () =>
        leaveDecisions.current.isCurrent(ticket),
      ).then((left) => {
        leaveDecisions.current.finish(ticket);
        setLeaveSubmitting(false);
        if (left) setPendingLeave(null);
      });
    },
    [leaveBlocker, leaveSubmitting, pendingLeave],
  );

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
      // 复评 F01：新 Token 已通过验证，必须先解除暂停，否则自动刷新会一直停在暂停态。
      applyChannel(
        "usage",
        onCredentialChanged(
          channels.current.usage,
          true,
          refreshIntervalRef.current,
        ),
      );
      setUsage(null);
      setUsageUpdatedAt(null);
      setUsageState("loading");
      setUsageError("");
      setUsageErrorCode(undefined);
      void loadUsage();
      void reloadConfig();
    });
    const cleared = listen("usage-token-cleared", () => {
      usageRequestId.current += 1;
      invalidateUsageRequests();
      availableSnapshot.current.usage = false;
      usageSnapshot.current = null;
      applyChannel(
        "usage",
        onCredentialChanged(
          channels.current.usage,
          false,
          refreshIntervalRef.current,
        ),
      );
      setUsage(null);
      setUsageUpdatedAt(null);
      setUsageState("nokey");
      setUsageError("未配置用量 Token");
      setUsageErrorCode("not_configured");
      void reloadConfig();
    });
    const browsingCleared = listen("browsing-data-cleared", () => {
      // 「退出并忘记账户」只应清除网页登录数据，外观偏好必须保留。
      // 主题与透明度都存在 localStorage 里，清理 WebView 数据会一并清掉，
      // 所以先把当前生效值写回，再重新应用，避免用户以为设置被重置。
      const current = document.documentElement.getAttribute(THEME_ATTR);
      localStorage.setItem(
        THEME_STORAGE_KEY,
        current === "dark" ? "dark" : "light",
      );
      localStorage.setItem(THEME_MIGRATION_KEY, "1");
      applyStoredGlass();
    });
    return () => {
      void captured.then((unlisten) => unlisten()).catch(() => undefined);
      void cleared.then((unlisten) => unlisten()).catch(() => undefined);
      void browsingCleared
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [applyChannel, loadUsage, reloadConfig]);

  React.useEffect(() => {
    applyStoredGlass();
  }, []);

  // 视图切换的焦点管理（评审 P2 无障碍）：
  // 进入新视图时把焦点移到该视图的标题，返回时由各面板自己的返回按钮
  // 触发 `restoreFocus`。这样纯键盘用户不会在切换后「丢失」当前位置。
  const stageRef = React.useRef<HTMLDivElement>(null);
  const previousView = React.useRef(view);
  React.useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    // 让 React 先把新视图渲染出来，再找标题。
    const frame = window.requestAnimationFrame(() => {
      const heading = stageRef.current?.querySelector<HTMLElement>(
        "h1, [role='heading'], .panel h2",
      );
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  // 复评 R17：提示出现时把焦点移入，关闭后还回原处，读屏用户不会「丢失」。
  const leavePromptRef = React.useRef<HTMLDivElement>(null);
  const leaveReturnFocus = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!pendingLeave) {
      const node = leaveReturnFocus.current;
      leaveReturnFocus.current = null;
      if (node?.isConnected) node.focus();
      return;
    }
    // 记录触发控件，再把焦点移入提示的第一个按钮。
    leaveReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => {
      leavePromptRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingLeave]);

  const leavePrompt = pendingLeave ? (
    <div
      ref={leavePromptRef}
      className="leave-guard"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="leave-guard-title"
      aria-describedby="leave-guard-desc"
    >
      <p id="leave-guard-title" className="leave-guard-title">
        {draftGuardText(pendingLeave.subject)}
      </p>
      <p id="leave-guard-desc" className="muted">
        选择后才会离开；保存失败会留在当前页。
      </p>
      <div className="disclosure-actions">
        <button
          className="primary"
          disabled={leaveSubmitting}
          onClick={() => decideLeave("save")}
        >
          {leaveSubmitting ? "保存中…" : draftGuardActions.save}
        </button>
        <button
          className="secondary"
          disabled={leaveSubmitting}
          onClick={() => decideLeave("discard")}
        >
          {draftGuardActions.discard}
        </button>
        <button className="secondary" onClick={() => decideLeave("cancel")}>
          {draftGuardActions.cancel}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={stageRef}
      data-panel-mode={mode}
      className={`stage mode-${mode} ${["dashboard", "local", "history"].includes(view) ? "with-navigation" : ""}`}
    >
      {view === "dashboard" && (
        <>
          <DashboardPanel
            onboarding={
              showOnboarding ? (
                <OnboardingPanel
                  tasks={onboardingTasks({
                    apiKeyConfigured: configSnapshot?.apiKeyConfigured ?? false,
                    usageTokenConfigured:
                      configSnapshot?.usageTokenConfigured ?? false,
                    localEnabled,
                    dismissed: onboardingDismissed,
                  })}
                  onChoose={(task) => {
                    setOnboardingDismissed(true);
                    setShowDataNotices(false);
                    // 平台用量与余额都在设置页配置；本地统计在 Agent 页开启。
                    setView(task === "local" ? "local" : "settings");
                  }}
                  onDismiss={() => setOnboardingDismissed(true)}
                />
              ) : null
            }
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
        </>
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
          targetSection={settingsTarget}
          usage={usage}
          onBalanceLoaded={(nextBalance) => {
            balanceRequestId.current += 1;
            balanceGate.current.invalidate();
            availableSnapshot.current.balance = true;
            // 复评 F01：设置页验证成功等同一次成功请求，必须解除暂停并恢复托盘有效性。
            applyChannel(
              "balance",
              onCredentialChanged(
                channels.current.balance,
                true,
                refreshIntervalRef.current,
              ),
            );
            channels.current.balance = onChannelSuccess(
              channels.current.balance,
              refreshIntervalRef.current,
            );
            setBalance(nextBalance);
            setBalanceUpdatedAt(Date.now());
            setBalanceCredentialValid(true);
            setBalanceState("ok");
            setBalanceError("");
            setBalanceErrorCode(undefined);
            void reloadConfig();
          }}
          onBalanceCleared={() => {
            balanceRequestId.current += 1;
            balanceGate.current.invalidate();
            availableSnapshot.current.balance = false;
            applyChannel(
              "balance",
              onCredentialChanged(
                channels.current.balance,
                false,
                refreshIntervalRef.current,
              ),
            );
            setBalance(null);
            setBalanceUpdatedAt(null);
            setBalanceCredentialValid(false);
            setBalanceState("nokey");
            setBalanceError("");
            setBalanceErrorCode(undefined);
            void reloadConfig();
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
            // 复评 F01：用量成功路径原先不清 paused，凭据恢复后自动刷新永久暂停。
            applyChannel(
              "usage",
              onChannelSuccess(
                channels.current.usage,
                refreshIntervalRef.current,
              ),
            );
            setUsage(current);
            setUsageUpdatedAt(Date.now());
            setUsageState("ok");
            setUsageError("");
            setUsageErrorCode(undefined);
            void reloadConfig();
          }}
          onUsageCleared={() => {
            usageRequestId.current += 1;
            invalidateUsageRequests();
            availableSnapshot.current.usage = false;
            usageSnapshot.current = null;
            applyChannel(
              "usage",
              onCredentialChanged(
                channels.current.usage,
                false,
                refreshIntervalRef.current,
              ),
            );
            setUsage(null);
            setUsageUpdatedAt(null);
            setUsageState("nokey");
            setUsageError("未配置用量 Token");
            setUsageErrorCode("not_configured");
            void reloadConfig();
          }}
          onRefreshIntervalChanged={setRefreshIntervalSeconds}
          onAutoRefreshChanged={setAutoRefreshEnabled}
          onBack={() => {
            setSettingsTarget(null);
            setView("dashboard");
          }}
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
        <HistoryPanel
          onBack={() => navigate(() => setView("dashboard"))}
          usageTokenConfigured={configSnapshot?.usageTokenConfigured ?? false}
          onConfigureUsage={() => {
            // 复评 F10/R16：直接进入设置页并滚动聚焦到用量 Token 区块。
            setShowDataNotices(false);
            setSettingsTarget("usageToken");
            setView("settings");
          }}
        />
      )}
      {view === "local" && (
        <LocalUsagePanel
          onBack={() => navigate(() => setView("dashboard"))}
          onRegisterLeaveBlocker={registerLeaveBlocker}
        />
      )}
      {leavePrompt}
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
              onClick={() => {
                if (view === target) return;
                navigate(() => setView(target));
              }}
            >
              {label}
            </button>
          ))}
          <button
            className="nav-mode-toggle"
            aria-label={panelModeLabel(mode)}
            title={panelModeLabel(mode)}
            onClick={() =>
              setManualMode(mode === "expanded" ? "compact" : "expanded")
            }
          >
            {mode === "expanded" ? (
              <Minimize2 size={15} />
            ) : (
              <Maximize2 size={15} />
            )}
          </button>
        </nav>
      )}
    </div>
  );
}
export { App };
