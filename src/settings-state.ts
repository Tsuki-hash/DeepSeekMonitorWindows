// 设置页的状态与动作（评审 F-09：从 SettingsPanel 拆出，组件只留视图）。
// invoke / listen / 剪贴板调用、保存回滚与用户反馈集中在这里。

import React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { currencySymbol } from "./format";
import type {
  AppConfig,
  SavedApiKey,
  UsageSyncStatus,
  UsageSyncStarted,
  UsageTokenCaptured,
} from "./types";
import {
  newUsageSyncRequest,
  UsageSyncOwner,
  UsageSyncRequests,
} from "./usage-sync-owner";
import { errorMessage } from "./error-state";
import type { LeaveBlocker } from "./leave-guard";
import { CredentialDraft } from "./credential-draft";
import type { CredentialSnapshot } from "./credential-draft";
import { ApiKeyFeedback } from "./api-key-feedback";
import { UsageTokenFeedback } from "./usage-token-feedback";
import type {
  UsageSessionCleanupOwner,
  UsageTokenFeedbackOwner,
} from "./usage-token-feedback";
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
  newApiKeyRequest,
  ApiKeyRequests,
  beginUsageTokenOperation,
  isCurrentUsageTokenOperation,
} from "./api-key-operation";
import {
  applyReadConfig,
  getCommitRevision,
  getCommittedConfig,
  isCurrentCredential,
  setCommittedConfig,
  subscribeCommittedConfig,
} from "./config-store";

// App-lifetime ownership: changing pages must not hide queued login IPC from Clear.
const usageSyncRequests = new UsageSyncRequests();
const apiKeyRequests = new ApiKeyRequests();

function useCredentialDraft(
  lifecycle: React.MutableRefObject<{ active: boolean; generation: number }>,
) {
  const draft = React.useRef(new CredentialDraft());
  const [value, setValue] = React.useState("");
  const edit = React.useCallback(
    (next: string) => {
      if (!lifecycle.current.active) return;
      draft.current.edit(next);
      setValue(next);
    },
    [lifecycle],
  );
  const clear = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    draft.current.clear();
    setValue("");
  }, [lifecycle]);
  const commit = React.useCallback(
    (revision: number) => {
      if (lifecycle.current.active && draft.current.commit(revision))
        setValue("");
    },
    [lifecycle],
  );
  return { draft, value, edit, clear, commit };
}

export type SettingsState = {
  config: AppConfig | null;
  configPath: string;
  status: string;
  busy: boolean;
  appVersion: string;
  apiKey: string;
  setApiKey: (value: string) => void;
  usageToken: string;
  setUsageToken: (value: string) => void;
  // 复评 N12：`null` 表示**尚未取得可信配置**（控件应禁用，不猜默认值）。
  refresh: number | null;
  autoRefresh: boolean | null;
  autostart: boolean | null;
  usageStatus: string;
  settingErrors: Partial<
    Record<"refresh" | "autoRefresh" | "autostart", string>
  >;
  usageSyncing: boolean;
  showManualPaste: boolean;
  setShowManualPaste: React.Dispatch<React.SetStateAction<boolean>>;
  saveApiKey: () => Promise<boolean>;
  clearApiKey: () => void;
  pasteApiKey: () => void;
  saveUsageToken: () => Promise<boolean>;
  clearUsageToken: () => void;
  forgetUsageSession: () => void;
  pasteUsageToken: () => void;
  startUsageSync: () => void;
  cancelUsageSync: () => void;
  saveRefreshInterval: (seconds: number) => void;
  saveAutoRefreshEnabled: (enabled: boolean) => void;
  saveAutostart: (enabled: boolean) => void;
  /**
   * 复评 T12：凭据草稿（API Key / 用量 Token）的离开拦截登记。
   * 与 AlertSettings 的 blocker 由 SettingsPanel 组合成**一个** blocker，
   * 避免子组件互相覆盖导致某一类草稿失去保护。
   */
  registerCredentialBlocker: (
    register: (blocker: LeaveBlocker | null) => void,
  ) => void;
};

export function useSettingsState(): SettingsState {
  const lifecycle = React.useRef({ active: true, generation: 0 });
  const {
    draft: keyDraft,
    value: apiKey,
    edit: editApiKey,
    clear: clearApiKeyDraft,
    commit: commitApiKey,
  } = useCredentialDraft(lifecycle);
  const {
    draft: tokenDraft,
    value: usageToken,
    edit: editUsageToken,
    clear: clearUsageTokenDraft,
    commit: commitUsageToken,
  } = useCredentialDraft(lifecycle);
  const tokenFeedback = React.useRef(
    new UsageTokenFeedback(getCommittedConfig()),
  );
  React.useLayoutEffect(() => {
    const owner = lifecycle.current;
    const key = keyDraft.current;
    const token = tokenDraft.current;
    const feedback = tokenFeedback.current;
    owner.active = true;
    owner.generation += 1;
    return () => {
      owner.active = false;
      owner.generation += 1;
      // Clear memory synchronously, before child cleanup or stale callbacks.
      key.clear();
      token.clear();
      feedback.edit();
      feedback.invalidateCleanup();
    };
  }, [keyDraft, tokenDraft]);
  const capturePage = React.useCallback(() => {
    const owner = lifecycle.current;
    const generation = owner.generation;
    return () => owner.active && owner.generation === generation;
  }, []);
  const [config, setConfig] = React.useState<AppConfig | null>(
    getCommittedConfig,
  );
  const keyFeedback = React.useRef(new ApiKeyFeedback(getCommittedConfig()));
  const [status, setStatus] = React.useState(() => keyFeedback.current.status);
  const setApiKey = React.useCallback(
    (value: string) => {
      if (!lifecycle.current.active) return;
      editApiKey(value);
      keyFeedback.current.edit();
      setStatus(keyFeedback.current.status);
    },
    [editApiKey],
  );
  const discardApiKey = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    clearApiKeyDraft();
    keyFeedback.current.edit();
    setStatus(keyFeedback.current.status);
  }, [clearApiKeyDraft]);
  const [busy, setBusy] = React.useState(false);
  const preferenceBusy = React.useRef(false);
  const [settingErrors, setSettingErrors] = React.useState<
    SettingsState["settingErrors"]
  >({});
  // 复评 N12：控件初值必须从**已提交快照**派生，而不是写死默认值。
  // 旧实现只让 `config` 从缓存初始化，refresh/autoRefresh/autostart 仍从
  // 60/false/false 起步 —— 重挂载后即使已有已提交的 1800/true/true，
  // 控件也显示默认值且可操作（读失败时更会误导用户以为设置被重置）。
  // 无缓存时用 `null` 表示**未知**，控件据此禁用而不是猜测默认值。
  const initial = getCommittedConfig();
  const [refresh, setRefresh] = React.useState<number | null>(
    initial && !initial.configReadError
      ? initial.refreshIntervalSeconds || 60
      : null,
  );
  const [autoRefresh, setAutoRefresh] = React.useState<boolean | null>(
    initial && !initial.configReadError ? initial.autoRefreshEnabled : null,
  );
  const [autostart, setAutostart] = React.useState<boolean | null>(
    initial && !initial.configReadError ? initial.autostart : null,
  );
  const [usageStatus, setUsageStatus] = React.useState(
    () => tokenFeedback.current.status,
  );
  const setUsageToken = React.useCallback(
    (value: string) => {
      if (!lifecycle.current.active) return;
      editUsageToken(value);
      tokenFeedback.current.edit();
      setUsageStatus(tokenFeedback.current.status);
    },
    [editUsageToken],
  );
  const discardUsageToken = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    clearUsageTokenDraft();
    tokenFeedback.current.edit();
    setUsageStatus(tokenFeedback.current.status);
  }, [clearUsageTokenDraft]);
  const [usageSyncing, setUsageSyncing] = React.useState(false);
  const syncRequestId = React.useRef(0);
  const syncOwner = React.useRef(new UsageSyncOwner());
  const syncFeedbackOwner = React.useRef<{
    requestId: string;
    feedback: UsageTokenFeedbackOwner;
    suppressEndedFeedback?: boolean;
  } | null>(null);
  const [showManualPaste, setShowManualPaste] = React.useState(false);
  // 空串表示「版本未知」。刻意不写死一个兜底版本号：那个数字会随着发版过期，
  // 显示出来反而是错的信息，不如显示「—」。
  const [appVersion, setAppVersion] = React.useState("");
  const configPath =
    config?.configPath ?? "%APPDATA%\\DeepSeekMonitorWindows\\config.json";

  React.useEffect(() => {
    // 复评 F09：订阅时必须把**全部**由配置派生的控件状态一起收敛 ——
    // 旧实现只 setConfig，自动刷新/间隔/自启这些局部 state 仍停留在旧值，
    // 于是后端已开启自动刷新、设置页开关却显示关闭（再点一次还会重复开启）。
    const current = capturePage();
    const syncFromCommitted = (next: AppConfig) => {
      if (!current()) return;
      setConfig(next);
      setRefresh(
        next.configReadError ? null : next.refreshIntervalSeconds || 60,
      );
      setAutoRefresh(next.configReadError ? null : next.autoRefreshEnabled);
      setAutostart(next.configReadError ? null : next.autostart);
      keyFeedback.current.observe(next);
      setStatus(keyFeedback.current.status);
      tokenFeedback.current.observe(next, !syncOwner.current.ended);
      setUsageStatus(tokenFeedback.current.status);
    };
    const unsubscribe = subscribeCommittedConfig(() => {
      const committed = getCommittedConfig();
      if (committed) syncFromCommitted(committed);
    });
    const cached = getCommittedConfig();
    if (cached) syncFromCommitted(cached);
    // 复评 F08：挂载时的读取只是**读取**，不能无条件覆盖已提交配置。
    // 发起时捕获提交代际，返回时若已有新提交（保存/清除/事件）就丢弃，
    // 避免「旧 GET 最后到达」把已保存凭据回滚成未配置。
    const startedAt = getCommitRevision();
    const snapshotAtStart = getCommittedConfig();
    const statusOwner = keyFeedback.current.capture(keyDraft.current.revision);
    const readOwnsKeyStatus = () =>
      keyFeedback.current.owns(statusOwner, keyDraft.current.revision);
    void invoke<AppConfig>("get_app_config")
      .then((nextConfig) => {
        if (!applyReadConfig(nextConfig, startedAt)) {
          // 已有更新的提交：用当前已提交配置收敛，不使用这份过期读取。
          const committed = getCommittedConfig();
          if (committed) syncFromCommitted(committed);
          return;
        }
        const committed = getCommittedConfig();
        if (committed) syncFromCommitted(committed);
      })
      .catch((error) => {
        if (!current()) return;
        // Reads do not increment commitRevision. Also compare the accepted
        // snapshot so a late mount failure cannot overwrite a newer retry read.
        if (
          getCommitRevision() !== startedAt ||
          getCommittedConfig() !== snapshotAtStart ||
          !readOwnsKeyStatus()
        )
          return;
        // 只有"根本没有 Tauri IPC"才是浏览器预览，属预期情况；真机上失败一律是真实错误，
        // 必须原样透出——否则配置文件损坏会被伪装成"浏览器预览模式"，用户完全无从定位。
        if (!isTauri()) {
          keyFeedback.current.readFailed(
            statusOwner,
            keyDraft.current.revision,
            "浏览器预览模式，未连接本地配置",
          );
          setStatus(keyFeedback.current.status);
          return;
        }
        keyFeedback.current.readFailed(
          statusOwner,
          keyDraft.current.revision,
          errorMessage(error),
        );
        setStatus(keyFeedback.current.status);
      });
    return unsubscribe;
  }, [capturePage, keyDraft]);

  React.useEffect(() => {
    const current = capturePage();
    void getVersion()
      .then((version) => {
        if (current()) setAppVersion(version);
      })
      .catch(() => {
        if (current()) setAppVersion("");
      });
  }, [capturePage]);

  React.useEffect(() => {
    const current = capturePage();
    let eventRevision = 0;
    const requests = [
      listen<UsageSyncStatus>("usage-sync-started", ({ payload }) => {
        eventRevision += 1;
        if (!current() || !syncOwner.current.accept(payload)) return;
        setUsageSyncing(payload.active && payload.kind === "web");
      }),
      listen<UsageTokenCaptured>("usage-token-captured", ({ payload }) => {
        eventRevision += 1;
        // Persisted credentials still belong to the app, regardless of page/session.
        setCommittedConfig(payload.config);
        if (!current() || !syncOwner.current.accept(payload)) return;
        syncRequestId.current += 1;
        setUsageSyncing(false);
        const owner = syncFeedbackOwner.current;
        if (owner?.requestId === payload.requestId) {
          owner.suppressEndedFeedback = true;
          tokenFeedback.current.update(
            owner.feedback,
            tokenDraft.current.revision,
            null,
            true,
            "sync",
          );
        }
        setUsageStatus(tokenFeedback.current.status);
      }),
      listen<UsageSyncStatus>("usage-sync-ended", ({ payload }) => {
        eventRevision += 1;
        if (!current() || !syncOwner.current.accept(payload)) return;
        setUsageSyncing(false);
        const owner = syncFeedbackOwner.current;
        // Event delivery may trail the cancel receipt or a successful capture.
        // Duplicate terminal events do not replace feedback or cancel its read.
        if (
          payload.kind === "web" &&
          owner?.requestId === payload.requestId &&
          owner.suppressEndedFeedback
        )
          return;
        syncRequestId.current += 1;
        if (payload.kind === "web") {
          if (owner?.requestId === payload.requestId)
            tokenFeedback.current.update(
              owner.feedback,
              tokenDraft.current.revision,
              "未获取到用量 Token。可再次点击同步，或使用方式二手动粘贴。",
              true,
              "sync",
            );
          setUsageStatus(tokenFeedback.current.status);
          setShowManualPaste(true);
        }
      }),
    ];
    // Subscribe first, then restore backend state on remount. A local action or
    // accepted terminal event supersedes this read, just like config reads.
    const startedAt = syncRequestId.current;
    const feedback = tokenFeedback.current.capture(tokenDraft.current.revision);
    void Promise.all(requests)
      .then(async () => {
        while (current() && startedAt === syncRequestId.current) {
          const eventsAtStart = eventRevision;
          const snapshot = await invoke<UsageSyncStatus>(
            "get_usage_sync_status",
          );
          if (!current() || startedAt !== syncRequestId.current) return;
          // A terminal event can arrive before a remounted page knows its owner.
          // Re-read instead of resurrecting the pre-event active snapshot.
          if (eventsAtStart !== eventRevision) continue;
          syncOwner.current.restore(snapshot);
          setUsageSyncing(snapshot.active && snapshot.kind === "web");
          if (
            snapshot.active &&
            snapshot.kind === "web" &&
            snapshot.requestId
          ) {
            syncFeedbackOwner.current = {
              requestId: snapshot.requestId,
              feedback,
            };
            tokenFeedback.current.update(
              feedback,
              tokenDraft.current.revision,
              "等待网页登录，完成后将自动校验并同步。关闭登录窗口可结束等待。",
              true,
              "sync",
            );
            setUsageStatus(tokenFeedback.current.status);
          }
          return;
        }
      })
      .catch(() => undefined);
    return () => {
      for (const request of requests)
        void request.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [capturePage, tokenDraft]);

  const pasteApiKey = React.useCallback(async () => {
    const current = capturePage();
    if (!current()) return;
    const owner = keyFeedback.current.begin(
      keyDraft.current.revision,
      "正在读取剪贴板…",
    );
    setStatus(keyFeedback.current.status);
    try {
      const text = await navigator.clipboard.readText();
      if (
        !current() ||
        !keyFeedback.current.ownsIntent(owner, keyDraft.current.revision)
      )
        return;
      editApiKey(text.trim());
      keyFeedback.current.begin(keyDraft.current.revision, "已从剪贴板读取");
      setStatus(keyFeedback.current.status);
    } catch {
      if (!current()) return;
      keyFeedback.current.update(
        owner,
        keyDraft.current.revision,
        "剪贴板读取失败",
      );
      setStatus(keyFeedback.current.status);
    }
  }, [editApiKey, keyDraft, capturePage]);

  const keySaves = React.useRef(new Map<number, Promise<boolean>>());
  const saveKeySnapshot = React.useCallback(
    (submitted: CredentialSnapshot): Promise<boolean> => {
      const pending = keySaves.current.get(submitted.revision);
      if (pending) return pending;
      if (!lifecycle.current.active || !submitted.value.trim())
        return Promise.resolve(false);
      const feedbackOwner =
        submitted.revision === keyDraft.current.revision
          ? keyFeedback.current.begin(submitted.revision, "正在验证 API Key…")
          : keyFeedback.current.capture(submitted.revision);
      const generation = lifecycle.current.generation;
      const operation = beginApiKeyOperation();
      const requestId = newApiKeyRequest();
      const current = () =>
        lifecycle.current.active &&
        lifecycle.current.generation === generation &&
        isCurrentApiKeyOperation(operation);
      const saving = (async () => {
        setBusy(true);
        setStatus(keyFeedback.current.status);
        try {
          const { config: nextConfig, balance } = await apiKeyRequests.save(
            requestId,
            (supersededRequestIds) =>
              invoke<SavedApiKey>("save_api_key", {
                apiKey: submitted.value,
                requestId,
                supersededRequestIds,
              }),
          );
          setCommittedConfig(nextConfig, balance);
          if (!current() || !isCurrentCredential(nextConfig, "apiKey"))
            return false;
          const symbol = currencySymbol(balance.currency);
          const tip = balance.isAvailable ? "" : "（余额不足）";
          keyFeedback.current.update(
            feedbackOwner,
            keyDraft.current.revision,
            `验证通过，当前余额 ${symbol}${balance.totalBalance}${tip}`,
            true,
          );
          commitApiKey(submitted.revision);
          setStatus(keyFeedback.current.status);
          return true;
        } catch (error) {
          if (current()) {
            keyFeedback.current.update(
              feedbackOwner,
              keyDraft.current.revision,
              errorMessage(error),
            );
            setStatus(keyFeedback.current.status);
          }
          return false;
        } finally {
          if (current()) setBusy(false);
        }
      })().finally(() => keySaves.current.delete(submitted.revision));
      keySaves.current.set(submitted.revision, saving);
      return saving;
    },
    [commitApiKey, keyDraft],
  );
  const saveApiKey = React.useCallback(
    () => saveKeySnapshot(keyDraft.current.snapshot()),
    [saveKeySnapshot, keyDraft],
  );

  const clearApiKey = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    const operation = beginApiKeyOperation();
    const revision = keyDraft.current.revision;
    const feedbackOwner = keyFeedback.current.begin(
      revision,
      "正在清除 API Key…",
    );
    const generation = lifecycle.current.generation;
    const current = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      isCurrentApiKeyOperation(operation);
    setBusy(true);
    setStatus(keyFeedback.current.status);
    void apiKeyRequests
      .clear((cancelledRequestIds) =>
        invoke<AppConfig>("clear_api_key", { cancelledRequestIds }),
      )
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (!current() || !isCurrentCredential(nextConfig, "apiKey")) return;
        keyFeedback.current.update(
          feedbackOwner,
          keyDraft.current.revision,
          "已清除 API Key",
          true,
        );
        commitApiKey(revision);
        setStatus(keyFeedback.current.status);
      })
      .catch((error) => {
        if (current()) {
          keyFeedback.current.update(
            feedbackOwner,
            keyDraft.current.revision,
            errorMessage(error),
          );
          setStatus(keyFeedback.current.status);
        }
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
  }, [keyDraft, commitApiKey]);

  const pasteUsageToken = React.useCallback(async () => {
    const current = capturePage();
    if (!current()) return;
    const owner = tokenFeedback.current.begin(
      tokenDraft.current.revision,
      "正在读取剪贴板…",
    );
    setUsageStatus(tokenFeedback.current.status);
    try {
      const text = await navigator.clipboard.readText();
      if (
        !current() ||
        !tokenFeedback.current.ownsIntent(owner, tokenDraft.current.revision)
      )
        return;
      editUsageToken(text.trim());
      tokenFeedback.current.begin(
        tokenDraft.current.revision,
        "已从剪贴板读取",
      );
      setUsageStatus(tokenFeedback.current.status);
    } catch {
      if (!current()) return;
      tokenFeedback.current.update(
        owner,
        tokenDraft.current.revision,
        "剪贴板读取失败",
      );
      setUsageStatus(tokenFeedback.current.status);
    }
  }, [editUsageToken, tokenDraft, capturePage]);

  const startUsageSync = React.useCallback(() => {
    const current = capturePage();
    if (!current()) return;
    tokenFeedback.current.supersedeCleanup();
    const requestId = newUsageSyncRequest();
    syncOwner.current.begin(requestId);
    const feedback = tokenFeedback.current.begin(
      tokenDraft.current.revision,
      "正在打开登录窗口…",
      "sync",
    );
    syncFeedbackOwner.current = { requestId, feedback };
    const sequence = ++syncRequestId.current;
    setUsageSyncing(true);
    setUsageStatus(tokenFeedback.current.status);
    void usageSyncRequests
      .start(requestId, (supersededRequestIds) =>
        invoke<UsageSyncStarted>("start_usage_sync", {
          requestId,
          supersededRequestIds,
        }),
      )
      .then(async (result) => {
        if (
          !current() ||
          sequence !== syncRequestId.current ||
          !syncOwner.current.accept(result)
        )
          return;
        setUsageSyncing(result.active && !result.synced);
        if (result.active && !result.synced) {
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            "等待网页登录，完成后将自动校验并同步。关闭登录窗口可结束等待。",
            true,
            "sync",
          );
          setUsageStatus(tokenFeedback.current.status);
        } else if (result.synced) {
          syncOwner.current.finish(requestId);
          if (syncFeedbackOwner.current?.feedback === feedback)
            syncFeedbackOwner.current.suppressEndedFeedback = true;
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            "同步完成，正在读取配置…",
            true,
            "sync",
          );
          setUsageStatus(tokenFeedback.current.status);
          // A cached-session success may arrive without its capture event.
          // Re-read only; never start another login or restore a credential.
          const startedAt = getCommitRevision();
          const latest = await invoke<AppConfig>("get_app_config");
          applyReadConfig(latest, startedAt);
          if (
            !current() ||
            sequence !== syncRequestId.current ||
            !syncOwner.current.owns(requestId)
          )
            return;
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            null,
            true,
            "sync",
          );
          setUsageStatus(tokenFeedback.current.status);
        }
      })
      .catch((error) => {
        if (
          !current() ||
          sequence !== syncRequestId.current ||
          !syncOwner.current.finish(requestId)
        )
          return;
        setUsageSyncing(false);
        tokenFeedback.current.update(
          feedback,
          tokenDraft.current.revision,
          errorMessage(error),
          true,
          "sync",
        );
        setUsageStatus(tokenFeedback.current.status);
      });
  }, [capturePage, tokenDraft]);

  const cancelUsageSync = React.useCallback(() => {
    const current = capturePage();
    const owner = syncOwner.current;
    const requestId = owner.requestId;
    if (!current() || !requestId) return;
    ++syncRequestId.current; // Invalidate the old start response immediately.
    const feedback = tokenFeedback.current.begin(
      tokenDraft.current.revision,
      "正在取消同步…",
      "sync",
    );
    syncFeedbackOwner.current = {
      requestId,
      feedback,
      suppressEndedFeedback: true,
    };
    setUsageStatus(tokenFeedback.current.status);
    void invoke<UsageSyncStatus | null>("cancel_usage_sync", {
      requestId,
      generation: owner.generation,
    })
      .then(async (ended) => {
        if (!current() || !syncOwner.current.owns(requestId)) return;
        if (!ended) {
          // The request may already have captured a Token. A no-op is not a
          // cancellation receipt and cannot promise that the old Token is unchanged.
          const startedAt = getCommitRevision();
          const [snapshot, latestConfig] = await Promise.all([
            invoke<UsageSyncStatus>("get_usage_sync_status"),
            invoke<AppConfig>("get_app_config"),
          ]);
          applyReadConfig(latestConfig, startedAt);
          if (!current() || !syncOwner.current.owns(requestId)) return;
          syncOwner.current.restore(snapshot);
          setUsageSyncing(snapshot.active && snapshot.kind === "web");
          if (snapshot.active && snapshot.kind === "web") {
            if (syncFeedbackOwner.current?.feedback === feedback)
              syncFeedbackOwner.current.suppressEndedFeedback = false;
            tokenFeedback.current.update(
              feedback,
              tokenDraft.current.revision,
              "等待网页登录，完成后将自动校验并同步。关闭登录窗口可结束等待。",
              true,
              "sync",
            );
          } else {
            tokenFeedback.current.update(
              feedback,
              tokenDraft.current.revision,
              null,
              true,
              "sync",
            );
          }
          setUsageStatus(tokenFeedback.current.status);
          return;
        }
        if (!syncOwner.current.accept(ended)) return;
        syncOwner.current.finish(requestId);
        setUsageSyncing(false);
        tokenFeedback.current.update(
          feedback,
          tokenDraft.current.revision,
          "已取消同步，原 Token 未更改",
          true,
          "sync",
        );
        setUsageStatus(tokenFeedback.current.status);
      })
      .catch((error) => {
        if (current() && syncOwner.current.owns(requestId)) {
          if (syncFeedbackOwner.current?.feedback === feedback)
            syncFeedbackOwner.current.suppressEndedFeedback = false;
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            errorMessage(error),
            true,
            "sync",
          );
          setUsageStatus(tokenFeedback.current.status);
        }
      });
  }, [capturePage, tokenDraft]);
  const tokenSaves = React.useRef(
    new Map<
      number,
      {
        promise: Promise<boolean>;
        owner: { feedback: UsageTokenFeedbackOwner };
        current: () => boolean;
        requestId: string;
      }
    >(),
  );
  const saveTokenSnapshot = React.useCallback(
    (submitted: CredentialSnapshot): Promise<boolean> => {
      if (!lifecycle.current.active || !submitted.value.trim())
        return Promise.resolve(false);
      tokenFeedback.current.supersedeCleanup();
      const feedback =
        submitted.revision === tokenDraft.current.revision
          ? tokenFeedback.current.begin(
              submitted.revision,
              "正在验证候选 Token…",
            )
          : tokenFeedback.current.capture(submitted.revision);
      const pending = tokenSaves.current.get(submitted.revision);
      if (pending?.current() && syncOwner.current.owns(pending.requestId)) {
        pending.owner.feedback = feedback;
        setUsageStatus(tokenFeedback.current.status);
        return pending.promise;
      }
      const generation = lifecycle.current.generation;
      const operation = beginUsageTokenOperation();
      const current = () =>
        lifecycle.current.active &&
        lifecycle.current.generation === generation &&
        isCurrentUsageTokenOperation(operation);
      const requestId = newUsageSyncRequest();
      syncOwner.current.begin(requestId);
      syncFeedbackOwner.current = null;
      syncRequestId.current += 1;
      setUsageSyncing(false);
      const owner = { feedback };
      const saving = (async () => {
        setBusy(true);
        setUsageStatus(tokenFeedback.current.status);
        try {
          const nextConfig = await usageSyncRequests.start(
            requestId,
            (supersededRequestIds) =>
              invoke<AppConfig>("save_usage_token", {
                usageToken: submitted.value,
                requestId,
                supersededRequestIds,
              }),
          );
          setCommittedConfig(nextConfig);
          if (!current() || !isCurrentCredential(nextConfig, "usageToken"))
            return false;
          const ownsReceipt =
            syncOwner.current.owns(requestId) &&
            tokenFeedback.current.update(
              owner.feedback,
              tokenDraft.current.revision,
              "验证通过并已保存",
              true,
            );
          if (ownsReceipt) commitUsageToken(submitted.revision);
          setUsageStatus(tokenFeedback.current.status);
          return true;
        } catch (error) {
          if (current() && syncOwner.current.owns(requestId)) {
            tokenFeedback.current.update(
              owner.feedback,
              tokenDraft.current.revision,
              errorMessage(error),
            );
            setUsageStatus(tokenFeedback.current.status);
          }
          return false;
        } finally {
          syncOwner.current.finish(requestId);
          if (current()) setBusy(false);
        }
      })().finally(() => {
        if (tokenSaves.current.get(submitted.revision)?.owner === owner)
          tokenSaves.current.delete(submitted.revision);
      });
      tokenSaves.current.set(submitted.revision, {
        promise: saving,
        owner,
        current,
        requestId,
      });
      return saving;
    },
    [commitUsageToken, tokenDraft],
  );
  const saveUsageToken = React.useCallback(
    () => saveTokenSnapshot(tokenDraft.current.snapshot()),
    [saveTokenSnapshot, tokenDraft],
  );

  const clearUsageToken = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    syncRequestId.current += 1;
    syncOwner.current.invalidate();
    syncFeedbackOwner.current = null;
    setUsageSyncing(false);
    const revision = tokenDraft.current.revision;
    const feedback = tokenFeedback.current.begin(
      revision,
      "正在清除用量 Token…",
    );
    const generation = lifecycle.current.generation;
    const operation = beginUsageTokenOperation();
    const current = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      isCurrentUsageTokenOperation(operation);
    setBusy(true);
    setUsageStatus(tokenFeedback.current.status);
    void usageSyncRequests
      .clear((cancelledRequestIds) =>
        invoke<AppConfig>("clear_usage_token", { cancelledRequestIds }),
      )
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (!current() || !isCurrentCredential(nextConfig, "usageToken"))
          return;
        const ownsReceipt =
          syncOwner.current.requestId === null &&
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            "已清除用量 Token",
            true,
          );
        if (ownsReceipt) commitUsageToken(revision);
        setUsageStatus(tokenFeedback.current.status);
      })
      .catch((error) => {
        if (current()) {
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            errorMessage(error),
          );
          setUsageStatus(tokenFeedback.current.status);
        }
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
  }, [tokenDraft, commitUsageToken]);

  // Versioned events update saved state only. Only this operation's response
  // may consume its draft revision; backend versions are not draft ownership.
  // This also makes old/duplicate events harmless after unmount or a new forget.
  const forgetOwner = React.useRef<{
    operation: number;
    consumed: boolean;
    cleanup: UsageSessionCleanupOwner;
  } | null>(null);
  const forgetUsageSession = React.useCallback(() => {
    if (!lifecycle.current.active || forgetOwner.current) return;
    syncRequestId.current += 1;
    syncOwner.current.invalidate();
    syncFeedbackOwner.current = null;
    setUsageSyncing(false);
    const revision = tokenDraft.current.revision;
    const feedback = tokenFeedback.current.begin(revision, null);
    const generation = lifecycle.current.generation;
    const owner = {
      operation: beginUsageTokenOperation(),
      consumed: false,
      cleanup: tokenFeedback.current.beginCleanup(),
    };
    forgetOwner.current = owner;
    const currentPage = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      forgetOwner.current === owner;
    const current = () =>
      currentPage() && isCurrentUsageTokenOperation(owner.operation);
    setBusy(true);
    setUsageStatus(tokenFeedback.current.status);
    void usageSyncRequests
      .clear((cancelledRequestIds) =>
        invoke<AppConfig>("forget_usage_session", { cancelledRequestIds }),
      )
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (!currentPage() || owner.consumed) return;
        owner.consumed = true;
        tokenFeedback.current.finishCleanup(owner.cleanup, null);
        const ownsReceipt =
          current() &&
          isCurrentCredential(nextConfig, "usageToken") &&
          syncOwner.current.requestId === null &&
          tokenFeedback.current.update(
            feedback,
            tokenDraft.current.revision,
            null,
            true,
          );
        if (ownsReceipt) commitUsageToken(revision);
        setUsageStatus(tokenFeedback.current.status);
      })
      .catch((error) => {
        if (currentPage()) {
          // Privacy failure belongs to the cleanup operation, not to the draft.
          // New login/save labels it as a previous cleanup; editing B/ABA does not.
          tokenFeedback.current.finishCleanup(
            owner.cleanup,
            errorMessage(error),
          );
          setUsageStatus(tokenFeedback.current.status);
        }
      })
      .finally(() => {
        if (forgetOwner.current !== owner) return;
        forgetOwner.current = null;
        if (currentAfterForget()) setBusy(false);
      });
    function currentAfterForget() {
      return (
        lifecycle.current.active &&
        lifecycle.current.generation === generation &&
        isCurrentUsageTokenOperation(owner.operation)
      );
    }
  }, [tokenDraft, commitUsageToken]);

  React.useEffect(() => {
    const cleared = listen<AppConfig>("usage-token-cleared", (event) => {
      setCommittedConfig(event.payload);
    });
    return () => {
      void cleared.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [capturePage]);

  // The owner registers once. Getters and actions read synchronous memory, never
  // render-time strings or effect-delayed state. Capture both credentials before
  // awaiting either, so a newly typed candidate is never submitted implicitly.
  const saveKeyRef = React.useRef(saveKeySnapshot);
  saveKeyRef.current = saveKeySnapshot;
  const saveTokenRef = React.useRef(saveTokenSnapshot);
  saveTokenRef.current = saveTokenSnapshot;
  const registerCredentialBlocker = React.useCallback(
    (register: (blocker: LeaveBlocker | null) => void) => {
      const dirty = () =>
        lifecycle.current.active &&
        (keyDraft.current.dirty || tokenDraft.current.dirty);
      const prepareSave = () => {
        const key = keyDraft.current.snapshot();
        const token = tokenDraft.current.snapshot();
        const generation = lifecycle.current.generation;
        return async () => {
          if (
            !lifecycle.current.active ||
            lifecycle.current.generation !== generation
          )
            return false;
          const results: boolean[] = [];
          if (key.value.trim()) results.push(await saveKeyRef.current(key));
          if (
            !lifecycle.current.active ||
            lifecycle.current.generation !== generation
          )
            return false;
          if (token.value.trim())
            results.push(await saveTokenRef.current(token));
          return results.every(Boolean) && !dirty();
        };
      };
      register({
        get dirty() {
          return dirty();
        },
        subject: "凭据草稿",
        canLeave: () => !dirty(),
        prepareSave,
        save: () => prepareSave()(),
        discard: () => {
          if (!lifecycle.current.active) return;
          discardApiKey();
          discardUsageToken();
        },
      });
    },
    [keyDraft, discardApiKey, tokenDraft, discardUsageToken],
  );

  const saveRefreshInterval = React.useCallback(
    (seconds: number) => {
      const current = capturePage();
      if (!current() || preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, refresh: "" }));
      setRefresh(seconds);
      void invoke<AppConfig>("save_refresh_interval", {
        refreshIntervalSeconds: seconds,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (!current()) return;
          const committed = getCommittedConfig();
          setRefresh(
            committed && !committed.configReadError
              ? committed.refreshIntervalSeconds || 60
              : null,
          );
        })
        .catch((error) => {
          if (!current()) return;
          const committed = getCommittedConfig();
          setRefresh(
            committed && !committed.configReadError
              ? committed.refreshIntervalSeconds || 60
              : null,
          );
          setSettingErrors((previous) => ({
            ...previous,
            refresh: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          if (current()) setBusy(false);
        });
    },
    [capturePage],
  );

  const saveAutoRefreshEnabled = React.useCallback(
    (enabled: boolean) => {
      const current = capturePage();
      if (!current() || preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autoRefresh: "" }));
      setAutoRefresh(enabled);
      void invoke<AppConfig>("save_auto_refresh_enabled", {
        autoRefreshEnabled: enabled,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (!current()) return;
          const committed = getCommittedConfig();
          setAutoRefresh(
            committed && !committed.configReadError
              ? committed.autoRefreshEnabled
              : null,
          );
        })
        .catch((error) => {
          if (!current()) return;
          const committed = getCommittedConfig();
          setAutoRefresh(
            committed && !committed.configReadError
              ? committed.autoRefreshEnabled
              : null,
          );
          setSettingErrors((previous) => ({
            ...previous,
            autoRefresh: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          if (current()) setBusy(false);
        });
    },
    [capturePage],
  );

  const saveAutostart = React.useCallback(
    (enabled: boolean) => {
      const current = capturePage();
      if (!current() || preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autostart: "" }));
      setAutostart(enabled);
      void invoke<AppConfig>("save_autostart", { autostart: enabled })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (!current()) return;
          const committed = getCommittedConfig();
          setAutostart(
            committed && !committed.configReadError
              ? committed.autostart
              : null,
          );
        })
        .catch((error) => {
          if (!current()) return;
          const committed = getCommittedConfig();
          setAutostart(
            committed && !committed.configReadError
              ? committed.autostart
              : null,
          );
          setSettingErrors((previous) => ({
            ...previous,
            autostart: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          if (current()) setBusy(false);
        });
    },
    [capturePage],
  );

  return {
    config,
    configPath,
    status,
    busy,
    appVersion,
    apiKey,
    setApiKey,
    usageToken,
    setUsageToken,
    refresh,
    autoRefresh,
    autostart,
    usageStatus,
    settingErrors,
    usageSyncing,
    showManualPaste,
    setShowManualPaste,
    saveApiKey,
    clearApiKey,
    pasteApiKey,
    saveUsageToken,
    clearUsageToken,
    forgetUsageSession,
    pasteUsageToken,
    startUsageSync,
    cancelUsageSync,
    saveRefreshInterval,
    saveAutoRefreshEnabled,
    saveAutostart,
    registerCredentialBlocker,
  };
}
