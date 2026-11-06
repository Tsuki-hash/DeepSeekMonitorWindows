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
  UsageTokenCaptured,
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
import { TrayBalancePublisher } from "./tray-balance";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { onboardingTasks, shouldShowOnboarding } from "./onboarding";
import { panelModeLabel, suggestedMode } from "./panel-mode";
import type { PanelMode } from "./panel-mode";
import { Maximize2, Minimize2 } from "lucide-react";
import { attemptLeave, useLeaveGuard } from "./leave-guard";
import { LeaveDecisionRunner } from "./leave-guard";
import type { LeaveDecision } from "./leave-guard";
import { LeavePromptDialog } from "./components/LeavePromptDialog";
import {
  applyReadConfig,
  getCommitRevision,
  getCommittedConfig,
  getValidatedBalance,
  markBalanceObserved,
  setCommittedConfig,
  subscribeCommittedConfig,
} from "./config-store";

// 刷新退避与托盘发布策略抽到 refresh-policy（纯函数，可单测）。

type DetailFocusOrigin = {
  model: ModelName;
  navigationId: number;
  accountEpoch: number;
};
type ViewFocusRequest = {
  navigationId: number;
  view: ViewName;
  activeElement: Element | null;
  origin: DetailFocusOrigin | null;
};

function App() {
  // 复评 R16：设置页需要定位到用量 Token 区块时由这里指定。
  const [settingsTarget, setSettingsTarget] = React.useState<
    "usageToken" | "dataNotices" | null
  >(null);
  // 页面与导航代际一起提交，不能让旧 RAF 误认并发渲染中的新页面。
  const [page, setPage] = React.useState<{
    view: ViewName;
    navigationId: number;
  }>({ view: "dashboard", navigationId: 0 });
  const { view } = page;
  const stageRef = React.useRef<HTMLDivElement>(null);
  const committedPage = React.useRef(page);
  const navigationId = React.useRef(0);
  const focusFrame = React.useRef<number | null>(null);
  const focusRequest = React.useRef<ViewFocusRequest | null>(null);
  const detailFocusOrigin = React.useRef<DetailFocusOrigin | null>(null);
  const accountFocusEpoch = React.useRef(0);
  const [committedAccountFocusEpoch, setAccountFocusEpoch] = React.useState(0);
  const visibleForFocus = React.useRef(true);
  const windowVisibilityRevision = React.useRef(0);
  const cancelFocusFrame = React.useCallback(() => {
    if (focusFrame.current !== null) {
      window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
    }
  }, []);
  const cancelViewFocus = React.useCallback(() => {
    cancelFocusFrame();
    focusRequest.current = null;
  }, [cancelFocusFrame]);
  const invalidateAccountFocus = React.useCallback(() => {
    // 失效后又恢复为同一凭据，也不能复活先前账户状态的入口。
    const nextEpoch = ++accountFocusEpoch.current;
    detailFocusOrigin.current = null;
    if (focusRequest.current) focusRequest.current.origin = null;
    // 保留当前导航的标题回退，但必须等账户更新真正提交后再执行。
    cancelFocusFrame();
    setAccountFocusEpoch(nextEpoch);
  }, [cancelFocusFrame]);
  const setView = React.useCallback(
    (nextView: ViewName, origin: DetailFocusOrigin | null = null) => {
      cancelViewFocus();
      const nextId = ++navigationId.current;
      focusRequest.current = {
        navigationId: nextId,
        view: nextView,
        activeElement: document.activeElement,
        origin,
      };
      detailFocusOrigin.current = null;
      setPage({ view: nextView, navigationId: nextId });
      return nextId;
    },
    [cancelViewFocus],
  );
  // 全局离开拦截（复评 F09）：任何导航出口都先问 blocker，草稿不再被静默丢弃。
  const { blocker: leaveBlocker, register: registerLeaveBlocker } =
    useLeaveGuard();
  const [pendingLeave, setPendingLeave] = React.useState<{
    action: () => void;
    subject: string;
  } | null>(null);
  // 复评 R08：保存是异步的，用户可能在途中取消或连点。
  // 第五轮复评 Q04：决策、导航意图与提交状态收敛到共享运行器 ——
  // 新导航意图立即作废旧决策，旧保存的迟到完成只清理自身。
  const [leaveSubmitting, setLeaveSubmitting] = React.useState(false);
  const leaveRunner = React.useRef<LeaveDecisionRunner | null>(null);
  if (leaveRunner.current === null) {
    leaveRunner.current = new LeaveDecisionRunner(
      () => leaveBlocker.current,
      setLeaveSubmitting,
      () => setPendingLeave(null),
    );
  }
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
      if (channels.current[name].paused !== next.paused) {
        invalidateAccountFocus();
      }
      channels.current[name] = next;
      // 只递增本通道的版本：另一通道的 timer 与截止时间保持不变。
      setChannelRevision((value) => ({
        ...value,
        [name]: value[name] + 1,
      }));
    },
    [invalidateAccountFocus],
  );
  const balanceGate = React.useRef(new RequestGate<BalanceData>());
  const loadBalance = React.useCallback(
    (silent = false) => {
      // 配置不可读不是「尚未配置」。错误快照拥有账户状态，重读恢复前
      // 不再让手动刷新、托盘唤出或调度器覆盖这个错误与撤销结果。
      if (getCommittedConfig()?.configReadError) return Promise.resolve();
      const requestId = ++balanceRequestId.current;
      const credentialRevision = getCommittedConfig()?.apiKeyRevision;
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
          markBalanceObserved(credentialRevision);
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
          markBalanceObserved(credentialRevision);
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
      if (getCommittedConfig()?.configReadError) return Promise.resolve();
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

  // 首次配置入口：余额与平台用量都未配置时出现，任一完成即收起。
  const [onboardingDismissed, setOnboardingDismissed] = React.useState(false);
  const [configSnapshot, setConfigSnapshot] = React.useState<{
    apiKeyConfigured: boolean;
    usageTokenConfigured: boolean;
    configReadError: string | null;
  } | null>(null);

  // Application ownership is independent of the settings page. Every committed
  // credential version invalidates the old account's requests, data and tray.
  const observedCredentials = React.useRef<AppConfig | null>(null);
  const observedBalance =
    React.useRef<ReturnType<typeof getValidatedBalance>>(null);
  React.useEffect(() => {
    const synchronize = () => {
      const next = getCommittedConfig();
      const previous = observedCredentials.current;
      if (!next) {
        if (previous) invalidateAccountFocus();
        observedCredentials.current = null;
        return;
      }
      const receipt = getValidatedBalance();
      // 恢复为可信空配置时，两个 configured 值甚至凭据版本可能未变，
      // 仍须清掉故障并重新计算引导，不能依赖凭据布尔值变化。
      const trustChanged =
        Boolean(previous?.configReadError) !== Boolean(next.configReadError);
      const keyChanged =
        !previous ||
        trustChanged ||
        previous.apiKeyRevision !== next.apiKeyRevision;
      const tokenChanged =
        !previous ||
        trustChanged ||
        previous.usageTokenRevision !== next.usageTokenRevision;
      if (
        keyChanged ||
        tokenChanged ||
        previous?.apiKeyConfigured !== next.apiKeyConfigured ||
        previous?.usageTokenConfigured !== next.usageTokenConfigured ||
        previous?.usageCleanupUnconfirmed !== next.usageCleanupUnconfirmed
      ) {
        invalidateAccountFocus();
      }
      const balanceReceived =
        receipt !== null && receipt !== observedBalance.current;
      observedCredentials.current = next;
      observedBalance.current = receipt;
      setRefreshIntervalSeconds(next.refreshIntervalSeconds || 60);
      setAutoRefreshEnabled(!next.configReadError && next.autoRefreshEnabled);
      setConfigSnapshot({
        apiKeyConfigured: next.apiKeyConfigured,
        usageTokenConfigured: next.usageTokenConfigured,
        configReadError: next.configReadError || null,
      });
      if (next.configReadError) {
        // 必须先撤销两个通道及托盘，再显示根因。拒绝迟到的成功与失败，
        // 不把读取失败解释成首次安装，也不恢复任何旧账户快照。
        balanceRequestId.current += 1;
        balanceGate.current.invalidate();
        usageRequestId.current += 1;
        invalidateUsageRequests();
        availableSnapshot.current = { balance: false, usage: false };
        usageSnapshot.current = null;
        setBalance(null);
        setBalanceUpdatedAt(null);
        setBalanceCredentialValid(false);
        setUsage(null);
        setUsageUpdatedAt(null);
        trayPublisher.current?.update({
          total: null,
          currency: null,
          stale: false,
        });
        for (const channel of ["balance", "usage"] as const) {
          applyChannel(
            channel,
            onCredentialChanged(
              channels.current[channel],
              false,
              refreshIntervalRef.current,
            ),
          );
        }
        setBalanceError(next.configReadError);
        setBalanceErrorCode("config_read_error");
        setBalanceState("error");
        setUsageError(next.configReadError);
        setUsageErrorCode("config_read_error");
        setUsageState("error");
        return;
      }
      if (keyChanged || balanceReceived) {
        if (keyChanged) {
          balanceRequestId.current += 1;
          balanceGate.current.invalidate();
          availableSnapshot.current.balance = false;
          setBalance(null);
          setBalanceUpdatedAt(null);
          setBalanceCredentialValid(false);
          // Revoke synchronously, not after another render/effect. A late
          // verification receipt for this same Key must NOT cancel its newer
          // in-flight fetch; that fetch may subsequently reject the credential.
          trayPublisher.current?.update({
            total: null,
            currency: null,
            stale: false,
          });
        }
        applyChannel(
          "balance",
          onCredentialChanged(
            channels.current.balance,
            next.apiKeyConfigured,
            refreshIntervalRef.current,
          ),
        );
        setBalanceError("");
        setBalanceErrorCode(undefined);
        if (
          receipt &&
          receipt.revision === next.apiKeyRevision &&
          next.apiKeyConfigured
        ) {
          availableSnapshot.current.balance = true;
          setBalance(receipt.balance);
          setBalanceUpdatedAt(Date.now());
          setBalanceCredentialValid(true);
          setBalanceState("ok");
          applyChannel(
            "balance",
            onChannelSuccess(
              channels.current.balance,
              refreshIntervalRef.current,
            ),
          );
        } else if (next.apiKeyConfigured) {
          setBalanceState("loading");
          void loadBalance();
        } else {
          setBalanceState("nokey");
        }
      }
      if (tokenChanged) {
        usageRequestId.current += 1;
        invalidateUsageRequests();
        availableSnapshot.current.usage = false;
        usageSnapshot.current = null;
        setUsage(null);
        setUsageUpdatedAt(null);
        applyChannel(
          "usage",
          onCredentialChanged(
            channels.current.usage,
            next.usageTokenConfigured,
            refreshIntervalRef.current,
          ),
        );
        setUsageError(next.usageTokenConfigured ? "" : "未配置用量 Token");
        setUsageErrorCode(
          next.usageTokenConfigured ? undefined : "not_configured",
        );
        setUsageState(next.usageTokenConfigured ? "loading" : "nokey");
        if (next.usageTokenConfigured) void loadUsage();
      }
    };
    const unsubscribe = subscribeCommittedConfig(synchronize);
    synchronize();
    return unsubscribe;
  }, [applyChannel, loadBalance, loadUsage, invalidateAccountFocus]);

  // Reads only feed the committed store. Scheduler and onboarding state have
  // one owner above; neither a stale GET nor its failure may reset them.
  const reloadConfig = React.useCallback(() => {
    const startedAt = getCommitRevision();
    const snapshotAtStart = getCommittedConfig();
    return invoke<AppConfig>("get_app_config")
      .then((config) => {
        applyReadConfig(config, startedAt);
        return getCommittedConfig();
      })
      .catch(() =>
        // A late read failure owns neither a newer commit nor another accepted
        // read. In either case the current snapshot remains the result.
        getCommitRevision() !== startedAt ||
        getCommittedConfig() !== snapshotAtStart
          ? getCommittedConfig()
          : null,
      );
  }, []);
  React.useEffect(() => {
    void reloadConfig();
  }, [reloadConfig]);
  const retrySettingsUpdate = React.useCallback(async () => {
    if (getCommittedConfig()?.configReadError) {
      // The unreadable snapshot intentionally blocks account fetches. Reread it
      // first; the store subscriber owns recovery and any credential refreshes,
      // including trusted-empty recovery with unchanged credential revisions.
      if (!(await reloadConfig())) throw new Error("重新读取配置失败，请重试");
      return;
    }
    await refreshAll(true);
  }, [reloadConfig, refreshAll]);

  // 面板是否可见。窗口隐藏不会卸载 WebView，所以自动刷新定时器必须靠这个状态显式暂停，
  // 否则面板整天收在托盘里也会按时打接口。该状态由 Rust 侧在显隐时发的事件驱动
  // （见 lib.rs 的 EVENT_MAIN_WINDOW_SHOWN / EVENT_MAIN_WINDOW_HIDDEN），
  // 这样从托盘唤出、托盘左键切换、程序内点关闭三条路径都覆盖得到。
  const [windowVisible, setWindowVisible] = React.useState(true);
  // 首帧后按实际窗口可见性校正，避免启动时若已在托盘仍多跑一轮刷新
  React.useEffect(() => {
    const startedAt = windowVisibilityRevision.current;
    void invoke<boolean>("is_main_window_visible")
      .then((visible) => {
        // 首次查询的迟到结果不能覆盖更新的显隐事件。
        if (startedAt !== windowVisibilityRevision.current) return;
        visibleForFocus.current = visible;
        if (!visible) cancelViewFocus();
        setWindowVisible(visible);
      })
      .catch(() => undefined);
  }, [cancelViewFocus]);

  React.useEffect(() => {
    const shown = listen("main-window-shown", () => {
      windowVisibilityRevision.current += 1;
      visibleForFocus.current = true;
      setWindowVisible(true);
      // 面板被唤出即拉最新数据，避免托盘唤出后看到的是旧快照。
      // 走静默刷新：唤出瞬间面板上已有上一轮的数据，不该闪一下「查询中…」。
      refreshAll(true);
    });
    const hidden = listen("main-window-hidden", () => {
      windowVisibilityRevision.current += 1;
      visibleForFocus.current = false;
      cancelViewFocus();
      setWindowVisible(false);
    });
    return () => {
      void shown.then((unlisten) => unlisten());
      void hidden.then((unlisten) => unlisten());
    };
  }, [refreshAll, cancelViewFocus]);

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
  const showOnboarding =
    configSnapshot !== null &&
    !configSnapshot.configReadError &&
    shouldShowOnboarding({
      apiKeyConfigured: configSnapshot.apiKeyConfigured,
      usageTokenConfigured: configSnapshot.usageTokenConfigured,
      dismissed: onboardingDismissed,
    });

  // 统一的导航出口：有未保存草稿时先拦下来，用户决定后再执行。
  const navigate = React.useCallback(
    (action: () => void) => {
      // 即使新意图被草稿拦截，旧页面的待执行焦点也不再拥有导航。
      cancelViewFocus();
      if (attemptLeave(leaveBlocker.current, action) === "blocked") {
        // 复评 Q04：新导航意图立即取得所有权 —— 作废在途旧决策，
        // 旧保存的迟到完成不得执行旧导航或清除这个新意图。
        leaveRunner.current?.requestIntent(action);
        setPendingLeave({
          action,
          subject: leaveBlocker.current?.subject ?? "当前设置",
        });
        return;
      }
      // 复评 R14：**干净导航也必须结束旧的离开决策**。
      // 旧实现只在 blocked 分支维护 runner/pending：提示期间用户把草稿改回
      // 原值（dirty 变 false）后再点导航，页面已经换了，旧提示却还挂着，
      // 点它的「保存并离开」还会执行那次早已过期的导航。
      // 现在无论走哪条分支，都先作废旧决策并清掉提示，再执行新动作。
      leaveRunner.current?.cancel();
    },
    [leaveBlocker, cancelViewFocus],
  );

  // 复评 F11：托盘「退出」不再直接结束进程 —— 它先唤出窗口并发出唯一
  // quit intent，这里把它当作一次导航意图交给草稿会话：无草稿直接退出，
  // 有草稿则三选一，保存/放弃成功后才由 confirm_quit 真正退出。
  React.useEffect(() => {
    const confirmQuit = () => {
      void invoke("confirm_quit").catch(() => {
        // 浏览器预览没有 Tauri IPC。
      });
    };
    const unlisten = listen("quit-requested", () =>
      navigate(() => confirmQuit()),
    );
    return () => {
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }, [navigate]);

  const decideLeave = React.useCallback(
    (decision: LeaveDecision) => {
      if (!pendingLeave) return;
      if (decision === "cancel") {
        // 取消使当前令牌失效：保存途中迟到的成功也不得导航。
        leaveRunner.current?.cancel();
        return;
      }
      // 连点只认第一次：运行器在提交中忽略后续 decide。
      leaveRunner.current?.decide(decision);
    },
    [pendingLeave],
  );

  const hideWindow = React.useCallback(() => {
    cancelViewFocus();
    void invoke("hide_main_window").catch(() => {
      // Browser preview has no Tauri IPC. Keep it non-blocking for visual checks.
    });
  }, [cancelViewFocus]);

  // 记账日期驱动（评审 P1：跨月后不能把旧累计称为「本月」）。
  // 独立于刷新路径：即使自动刷新关闭、用户一直开着面板，跨过北京时间月界时
  // 也要立即让旧月累计失效。这里**只失效、不联网**——是否重新请求仍由刷新策略决定，
  // 不在用户不知情时启用自动联网。
  React.useEffect(() => {
    let cancelled = false;
    // 复评 T11：check() 每次都会重新挂账，visibilitychange 反复触发时若不清掉
    // 旧 timer，会积累多条每日链（卸载只清最近一个 ID）。
    // 任意时刻只保留一个待触发的日期 timer。
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, msUntilNextAccountingDate());
    };
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
      arm();
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
    const acceptConfig = (event: { payload: AppConfig }) => {
      setCommittedConfig(event.payload);
    };
    const captured = listen<UsageTokenCaptured>(
      "usage-token-captured",
      ({ payload }) => {
        setCommittedConfig(payload.config);
      },
    );
    const cleared = listen<AppConfig>("usage-token-cleared", acceptConfig);
    const changed = listen<AppConfig>(
      "credential-config-changed",
      acceptConfig,
    );
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
      void changed.then((unlisten) => unlisten()).catch(() => undefined);
      void browsingCleared
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, []);

  React.useEffect(() => {
    applyStoredGlass();
  }, []);

  // 新交互或窗口失焦后，导航的异步焦点请求不再有权接管焦点。
  // 不在重新显示窗口时补执行旧请求；新的显式导航会创建自己的请求。
  React.useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      // 卸载旧面板引起的 body 回退不算主动选择另一个控件。
      if (
        event.target !== document.body &&
        event.target !== document.documentElement
      ) {
        cancelViewFocus();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") cancelViewFocus();
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", cancelViewFocus, true);
    document.addEventListener("pointerdown", cancelViewFocus, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", cancelViewFocus);
    return () => {
      cancelViewFocus();
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", cancelViewFocus, true);
      document.removeEventListener("pointerdown", cancelViewFocus, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", cancelViewFocus);
    };
  }, [cancelViewFocus]);

  // R28：仅详情的明确返回携带入口模型键，重挂载后重新查找原生按钮。
  // 其他导航仍聚焦首标题；定向设置入口继续由 SettingsPanel 独占焦点。
  // 每次提交都重新核对，后台数据更新不得留下读取旧 DOM/账户的 RAF。
  React.useLayoutEffect(() => {
    committedPage.current = page;
    const request = focusRequest.current;
    if (
      !request ||
      request.navigationId !== page.navigationId ||
      request.view !== view
    ) {
      return;
    }
    if (view === "settings" && settingsTarget) {
      cancelViewFocus();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (focusFrame.current === frame) focusFrame.current = null;
      if (
        focusRequest.current !== request ||
        navigationId.current !== request.navigationId ||
        committedPage.current !== page
      ) {
        return;
      }
      // 凭据事件可能早于其 React 提交；等最新提交重新挂帧，不读旧账户 DOM。
      if (accountFocusEpoch.current !== committedAccountFocusEpoch) return;
      if (
        !visibleForFocus.current ||
        document.visibilityState !== "visible" ||
        document.hasFocus?.() === false
      ) {
        cancelViewFocus();
        return;
      }
      const active = document.activeElement;
      if (
        active !== request.activeElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        cancelViewFocus();
        return;
      }
      const stage = stageRef.current;
      if (!stage || stage.isConnected === false) {
        cancelViewFocus();
        return;
      }
      const origin = request.origin;
      const account = getCommittedConfig();
      const button =
        view === "dashboard" &&
        origin?.accountEpoch === accountFocusEpoch.current &&
        account &&
        !account.configReadError
          ? stage.querySelector<HTMLButtonElement>(
              `.dashboard-panel button[data-usage-model="${origin.model}"]`,
            )
          : null;
      // 先消费请求：下面的 focusin 属于本次导航，不生成第二次恢复。
      focusRequest.current = null;
      if (
        button?.isConnected &&
        !button.disabled &&
        !button.closest("[inert], [hidden]") &&
        button.getClientRects().length > 0
      ) {
        button.focus();
        if (document.activeElement === button) return;
      }
      // “其他”行已消失、账户/凭据改变或按钮不可用时只回退当前页标题。
      const heading = stage.querySelector<HTMLElement>(
        "h1, [role='heading'], .panel h2",
      );
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    });
    focusFrame.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusFrame.current === frame) focusFrame.current = null;
    };
  });

  // 复评 T05/T08：与局部出口共用同一提示组件 —— 对话框命名、初始焦点、
  // 焦点归还与提交中禁用都在组件内实现，两个出口行为一致。
  const leavePrompt = pendingLeave ? (
    <LeavePromptDialog
      subject={leaveBlocker.current?.subject || pendingLeave.subject}
      submitting={leaveSubmitting}
      onDecide={decideLeave}
    />
  ) : null;

  return (
    <div
      ref={stageRef}
      data-panel-mode={mode}
      className={`stage mode-${mode} ${["dashboard", "history"].includes(view) ? "with-navigation" : ""}`}
    >
      {view === "dashboard" && (
        <>
          <DashboardPanel
            onboarding={
              configSnapshot?.configReadError ? (
                <section className="config-read-error" role="alert">
                  <strong>配置读取失败</strong>
                  <p>{configSnapshot.configReadError}</p>
                  <p className="muted">
                    暂时无法确认已保存的账户配置，旧账户数据已停止显示。修复配置后可重新读取。
                  </p>
                  <div className="disclosure-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setSettingsTarget(null);
                        setView("settings");
                      }}
                    >
                      打开设置
                    </button>
                    <button
                      className="primary"
                      onClick={() => void reloadConfig()}
                    >
                      重新读取配置
                    </button>
                  </div>
                </section>
              ) : showOnboarding ? (
                <OnboardingPanel
                  tasks={onboardingTasks({
                    apiKeyConfigured: configSnapshot?.apiKeyConfigured ?? false,
                    usageTokenConfigured:
                      configSnapshot?.usageTokenConfigured ?? false,
                    dismissed: onboardingDismissed,
                  })}
                  onChoose={(task) => {
                    setOnboardingDismissed(true);
                    setSettingsTarget(
                      task === "platform" ? "usageToken" : null,
                    );
                    setView("settings");
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
              setSettingsTarget(null);
              setView("settings");
            }}
            onDataStatus={() => {
              setSettingsTarget("dataNotices");
              setView("settings");
            }}
            onDetail={(nextModel, trigger) => {
              // 只记实际进入的原生入口，不记卸载后失效的 DOM 引用。
              const fromDashboard =
                committedPage.current.view === "dashboard" &&
                committedPage.current.navigationId === navigationId.current &&
                committedAccountFocusEpoch === accountFocusEpoch.current &&
                trigger?.isConnected &&
                trigger.tagName === "BUTTON" &&
                trigger.dataset.usageModel === nextModel &&
                stageRef.current?.contains(trigger);
              setModel(nextModel);
              const detailNavigationId = setView("detail");
              if (fromDashboard) {
                detailFocusOrigin.current = {
                  model: nextModel,
                  navigationId: detailNavigationId,
                  accountEpoch: accountFocusEpoch.current,
                };
              }
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
          onRetry={retrySettingsUpdate}
          balanceUpdatedAt={balanceUpdatedAt}
          usageUpdatedAt={usageUpdatedAt}
          balanceError={balanceError}
          usageError={usageError}
          targetSection={settingsTarget}
          usage={usage}
          // 第五轮复评 N04：提醒设置草稿注册进同一个 App 级离开拦截；
          // 关闭设置页也走 navigate，脏草稿不再被静默丢弃。
          onRegisterLeaveBlocker={registerLeaveBlocker}
          onBack={() =>
            navigate(() => {
              setSettingsTarget(null);
              setView("dashboard");
            })
          }
        />
      )}
      {view === "detail" && (
        <ModelDetailPanel
          onDataStatus={() => {
            setSettingsTarget("dataNotices");
            setView("settings");
          }}
          updatedAt={usageUpdatedAt}
          onSettings={() => {
            setSettingsTarget(null);
            setView("settings");
          }}
          model={model}
          usage={usage}
          usageState={usageState}
          usageError={usageError}
          onBack={() => {
            const origin = detailFocusOrigin.current;
            const returningFromDetail =
              committedPage.current.view === "detail" &&
              committedPage.current.navigationId === navigationId.current &&
              origin?.navigationId === page.navigationId &&
              origin.model === model;
            setView("dashboard", returningFromDetail ? origin : null);
          }}
        />
      )}
      {view === "history" && (
        <HistoryPanel
          windowVisible={windowVisible}
          onBack={() => navigate(() => setView("dashboard"))}
          usageTokenConfigured={configSnapshot?.usageTokenConfigured ?? false}
          onConfigureUsage={() => {
            // 复评 F10/R16：直接进入设置页并滚动聚焦到用量 Token 区块。
            setSettingsTarget("usageToken");
            setView("settings");
          }}
        />
      )}
      {leavePrompt}
      {["dashboard", "history"].includes(view) && (
        <nav className="primary-navigation" aria-label="主导航">
          {(
            [
              ["dashboard", "账户"],
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
