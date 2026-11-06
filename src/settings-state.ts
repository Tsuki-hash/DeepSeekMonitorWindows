// 设置页的状态与动作（评审 F-09：从 SettingsPanel 拆出，组件只留视图）。
// invoke / listen / 剪贴板调用、保存回滚与用户反馈集中在这里。

import React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { currencySymbol } from "./format";
import type { AppConfig, SavedApiKey } from "./types";
import { errorMessage } from "./error-state";
import type { LeaveBlocker } from "./leave-guard";
import { CredentialDraft } from "./credential-draft";
import type { CredentialSnapshot } from "./credential-draft";
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
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
    edit: setApiKey,
    clear: discardApiKey,
    commit: commitApiKey,
  } = useCredentialDraft(lifecycle);
  const {
    draft: tokenDraft,
    value: usageToken,
    edit: setUsageToken,
    clear: discardUsageToken,
    commit: commitUsageToken,
  } = useCredentialDraft(lifecycle);
  React.useLayoutEffect(() => {
    const owner = lifecycle.current;
    const key = keyDraft.current;
    const token = tokenDraft.current;
    owner.active = true;
    owner.generation += 1;
    return () => {
      owner.active = false;
      owner.generation += 1;
      // Clear memory synchronously, before child cleanup or stale callbacks.
      key.clear();
      token.clear();
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
  const [status, setStatus] = React.useState("正在读取本地配置");
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
    initial ? initial.refreshIntervalSeconds || 60 : null,
  );
  const [autoRefresh, setAutoRefresh] = React.useState<boolean | null>(
    initial ? initial.autoRefreshEnabled : null,
  );
  const [autostart, setAutostart] = React.useState<boolean | null>(
    initial ? initial.autostart : null,
  );
  const [usageStatus, setUsageStatus] = React.useState("");
  const [usageSyncing, setUsageSyncing] = React.useState(false);
  const syncRequestId = React.useRef(0);
  const syncCredentialRevision = React.useRef(
    getCommittedConfig()?.usageTokenRevision ?? -1,
  );
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
      setRefresh(next.refreshIntervalSeconds || 60);
      setAutoRefresh(next.autoRefreshEnabled);
      setAutostart(next.autostart);
      setStatus(
        next.apiKeyConfigured
          ? next.apiKeyPreview
            ? `已配置 ${next.apiKeyPreview}`
            : "API Key 已配置"
          : "未配置 API Key",
      );
      setUsageStatus(
        next.usageTokenConfigured ? "用量 Token 已配置" : "未配置用量 Token",
      );
    };
    const unsubscribe = subscribeCommittedConfig(() => {
      const committed = getCommittedConfig();
      if (committed) syncFromCommitted(committed);
    });
    // 复评 F08：挂载时的读取只是**读取**，不能无条件覆盖已提交配置。
    // 发起时捕获提交代际，返回时若已有新提交（保存/清除/事件）就丢弃，
    // 避免「旧 GET 最后到达」把已保存凭据回滚成未配置。
    const startedAt = getCommitRevision();
    void invoke<AppConfig>("get_app_config")
      .then((nextConfig) => {
        if (!applyReadConfig(nextConfig, startedAt)) {
          // 已有更新的提交：用当前已提交配置收敛，不使用这份过期读取。
          const committed = getCommittedConfig();
          if (committed) syncFromCommitted(committed);
          return;
        }
        syncFromCommitted(nextConfig);
      })
      .catch((error) => {
        if (!current()) return;
        // 只有"根本没有 Tauri IPC"才是浏览器预览，属预期情况；真机上失败一律是真实错误，
        // 必须原样透出——否则配置文件损坏会被伪装成"浏览器预览模式"，用户完全无从定位。
        if (!isTauri()) {
          setStatus("浏览器预览模式，未连接本地配置");
          return;
        }
        setStatus(errorMessage(error));
      });
    return unsubscribe;
  }, [capturePage]);

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
    const unlistenPromise = listen<AppConfig>(
      "usage-token-captured",
      (event) => {
        // Persisted state belongs to the application, even if this page just left.
        setCommittedConfig(event.payload);
        if (
          !current() ||
          !isCurrentCredential(event.payload, "usageToken") ||
          event.payload.usageTokenRevision <= syncCredentialRevision.current
        )
          return;
        syncCredentialRevision.current = event.payload.usageTokenRevision;
        syncRequestId.current += 1;
        setUsageSyncing(false);
      },
    );
    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [capturePage]);

  React.useEffect(() => {
    const current = capturePage();
    const unlistenPromise = listen("usage-sync-ended", () => {
      if (!current()) return;
      syncRequestId.current += 1;
      setUsageSyncing(false);
      setUsageStatus(
        "未获取到用量 Token。可再次点击同步，或使用方式二手动粘贴。",
      );
      setShowManualPaste(true);
    });
    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [capturePage]);

  const pasteApiKey = React.useCallback(async () => {
    const current = capturePage();
    if (!current()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!current()) return;
      setApiKey(text.trim());
      setStatus("已从剪贴板读取");
    } catch {
      if (current()) setStatus("剪贴板读取失败");
    }
  }, [setApiKey, capturePage]);

  const keySaves = React.useRef(new Map<number, Promise<boolean>>());
  const saveKeySnapshot = React.useCallback(
    (submitted: CredentialSnapshot): Promise<boolean> => {
      const pending = keySaves.current.get(submitted.revision);
      if (pending) return pending;
      if (!lifecycle.current.active || !submitted.value.trim())
        return Promise.resolve(false);
      const generation = lifecycle.current.generation;
      const operation = beginApiKeyOperation();
      const current = () =>
        lifecycle.current.active &&
        lifecycle.current.generation === generation &&
        isCurrentApiKeyOperation(operation);
      const saving = (async () => {
        setBusy(true);
        setStatus("正在验证 API Key…");
        try {
          const { config: nextConfig, balance } = await invoke<SavedApiKey>(
            "save_api_key",
            { apiKey: submitted.value },
          );
          setCommittedConfig(nextConfig, balance);
          if (!current() || !isCurrentCredential(nextConfig, "apiKey"))
            return false;
          commitApiKey(submitted.revision);
          const symbol = currencySymbol(balance.currency);
          const tip = balance.isAvailable ? "" : "（余额不足）";
          setStatus(
            `验证通过，当前余额 ${symbol}${balance.totalBalance}${tip}`,
          );
          return true;
        } catch (error) {
          if (current()) setStatus(errorMessage(error));
          return false;
        } finally {
          if (current()) setBusy(false);
        }
      })().finally(() => keySaves.current.delete(submitted.revision));
      keySaves.current.set(submitted.revision, saving);
      return saving;
    },
    [commitApiKey],
  );
  const saveApiKey = React.useCallback(
    () => saveKeySnapshot(keyDraft.current.snapshot()),
    [saveKeySnapshot, keyDraft],
  );

  const clearApiKey = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    const operation = beginApiKeyOperation();
    const revision = keyDraft.current.revision;
    const generation = lifecycle.current.generation;
    const current = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      isCurrentApiKeyOperation(operation);
    setBusy(true);
    void invoke<AppConfig>("clear_api_key")
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (!current() || !isCurrentCredential(nextConfig, "apiKey")) return;
        commitApiKey(revision);
        setStatus("已清除 API Key");
      })
      .catch((error) => {
        if (current()) setStatus(errorMessage(error));
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
  }, [keyDraft, commitApiKey]);

  const pasteUsageToken = React.useCallback(async () => {
    const current = capturePage();
    if (!current()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!current()) return;
      setUsageToken(text.trim());
      setUsageStatus("已从剪贴板读取");
    } catch {
      if (current()) setUsageStatus("剪贴板读取失败");
    }
  }, [setUsageToken, capturePage]);

  const startUsageSync = React.useCallback(() => {
    const current = capturePage();
    if (!current()) return;
    syncCredentialRevision.current =
      getCommittedConfig()?.usageTokenRevision ?? -1;
    const requestId = ++syncRequestId.current;
    setUsageSyncing(true);
    setUsageStatus("正在打开登录窗口…");
    void invoke<boolean>("start_usage_sync")
      .then((synced) => {
        if (!current() || requestId !== syncRequestId.current) return;
        if (!synced) {
          setUsageStatus(
            "等待网页登录，完成后将自动校验并同步。关闭登录窗口可结束等待。",
          );
        } else {
          setUsageSyncing(false);
        }
        // synced=true 时由 usage-token-captured 事件刷新数据并更新状态
      })
      .catch((error) => {
        if (!current() || requestId !== syncRequestId.current) return;
        setUsageSyncing(false);
        setUsageStatus(errorMessage(error));
      });
  }, [capturePage]);

  const cancelUsageSync = React.useCallback(() => {
    const current = capturePage();
    if (!current()) return;
    syncRequestId.current += 1;
    void invoke("cancel_usage_sync")
      .then(() => {
        if (!current()) return;
        setUsageSyncing(false);
        setUsageStatus("已取消同步，原 Token 未更改");
      })
      .catch((error) => {
        if (current()) setUsageStatus(errorMessage(error));
      });
  }, [capturePage]);
  const tokenSaves = React.useRef(new Map<number, Promise<boolean>>());
  const saveTokenSnapshot = React.useCallback(
    (submitted: CredentialSnapshot): Promise<boolean> => {
      const pending = tokenSaves.current.get(submitted.revision);
      if (pending) return pending;
      if (!lifecycle.current.active || !submitted.value.trim())
        return Promise.resolve(false);
      const generation = lifecycle.current.generation;
      const operation = beginUsageTokenOperation();
      const current = () =>
        lifecycle.current.active &&
        lifecycle.current.generation === generation &&
        isCurrentUsageTokenOperation(operation);
      const saving = (async () => {
        setBusy(true);
        setUsageStatus("正在验证候选 Token…");
        try {
          const nextConfig = await invoke<AppConfig>("save_usage_token", {
            usageToken: submitted.value,
          });
          setCommittedConfig(nextConfig);
          if (!current() || !isCurrentCredential(nextConfig, "usageToken"))
            return false;
          commitUsageToken(submitted.revision);
          setUsageStatus("验证通过并已保存");
          return true;
        } catch (error) {
          if (current()) setUsageStatus(errorMessage(error));
          return false;
        } finally {
          if (current()) setBusy(false);
        }
      })().finally(() => tokenSaves.current.delete(submitted.revision));
      tokenSaves.current.set(submitted.revision, saving);
      return saving;
    },
    [commitUsageToken],
  );
  const saveUsageToken = React.useCallback(
    () => saveTokenSnapshot(tokenDraft.current.snapshot()),
    [saveTokenSnapshot, tokenDraft],
  );

  const clearUsageToken = React.useCallback(() => {
    if (!lifecycle.current.active) return;
    const revision = tokenDraft.current.revision;
    const generation = lifecycle.current.generation;
    const operation = beginUsageTokenOperation();
    const current = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      isCurrentUsageTokenOperation(operation);
    setBusy(true);
    void invoke<AppConfig>("clear_usage_token")
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (!current() || !isCurrentCredential(nextConfig, "usageToken"))
          return;
        commitUsageToken(revision);
        setUsageStatus("已清除用量 Token");
        setUsageSyncing(false);
      })
      .catch((error) => {
        if (current()) setUsageStatus(errorMessage(error));
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
  } | null>(null);
  const forgetUsageSession = React.useCallback(() => {
    if (!lifecycle.current.active || forgetOwner.current) return;
    const revision = tokenDraft.current.revision;
    const generation = lifecycle.current.generation;
    const owner = { operation: beginUsageTokenOperation(), consumed: false };
    forgetOwner.current = owner;
    const current = () =>
      lifecycle.current.active &&
      lifecycle.current.generation === generation &&
      forgetOwner.current === owner &&
      isCurrentUsageTokenOperation(owner.operation);
    setBusy(true);
    setUsageStatus("正在清除应用内的网页登录数据…");
    void invoke<AppConfig>("forget_usage_session")
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        if (
          !current() ||
          owner.consumed ||
          !isCurrentCredential(nextConfig, "usageToken")
        )
          return;
        owner.consumed = true;
        commitUsageToken(revision);
        setUsageSyncing(false);
        setUsageStatus(
          "已清除监控 Token 和应用内网页登录数据，下次同步需要重新登录",
        );
      })
      .catch((error) => {
        if (current()) setUsageStatus(errorMessage(error));
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
    const current = capturePage();
    const cleared = listen<AppConfig>("usage-token-cleared", (event) => {
      setCommittedConfig(event.payload);
      if (
        current() &&
        isCurrentCredential(event.payload, "usageToken") &&
        event.payload.usageTokenRevision > syncCredentialRevision.current
      ) {
        syncCredentialRevision.current = event.payload.usageTokenRevision;
        setUsageSyncing(false);
      }
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
      const previous = refresh;
      setRefresh(seconds);
      void invoke<AppConfig>("save_refresh_interval", {
        refreshIntervalSeconds: seconds,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (!current()) return;
          const committed = getCommittedConfig()!;
          setRefresh(committed.refreshIntervalSeconds || 60);
        })
        .catch((error) => {
          if (!current()) return;
          // 复评 N12：只有可信旧值才回滚（配置未知时控件已禁用）。
          if (previous !== null) {
            setRefresh(
              getCommittedConfig()?.refreshIntervalSeconds ?? previous,
            );
          }
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
    [refresh, capturePage],
  );

  const saveAutoRefreshEnabled = React.useCallback(
    (enabled: boolean) => {
      const current = capturePage();
      if (!current() || preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autoRefresh: "" }));
      const previous = autoRefresh;
      setAutoRefresh(enabled);
      void invoke<AppConfig>("save_auto_refresh_enabled", {
        autoRefreshEnabled: enabled,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (!current()) return;
          const committed = getCommittedConfig()!;
          setAutoRefresh(committed.autoRefreshEnabled);
        })
        .catch((error) => {
          if (!current()) return;
          // 复评 N12：配置未知时控件已禁用、不会走到这里；回滚只在有
          // 可信旧值时进行，不用 null 覆盖真实值。
          if (previous !== null) {
            setAutoRefresh(
              getCommittedConfig()?.autoRefreshEnabled ?? previous,
            );
          }
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
    [autoRefresh, capturePage],
  );

  const saveAutostart = React.useCallback(
    (enabled: boolean) => {
      const current = capturePage();
      if (!current() || preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autostart: "" }));
      const previous = autostart;
      setAutostart(enabled);
      void invoke<AppConfig>("save_autostart", { autostart: enabled })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          if (current()) setAutostart(getCommittedConfig()!.autostart);
        })
        .catch((error) => {
          if (!current()) return;
          // 复评 N12：只有可信旧值才回滚。
          if (previous !== null)
            setAutostart(getCommittedConfig()?.autostart ?? previous);
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
    [autostart, capturePage],
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
