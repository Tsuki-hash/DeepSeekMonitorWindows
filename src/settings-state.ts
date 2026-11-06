// 设置页的状态与动作（评审 F-09：从 SettingsPanel 拆出，组件只留视图）。
// invoke / listen / 剪贴板调用、保存回滚与用户反馈集中在这里。

import React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { currencySymbol, fmtMoney } from "./format";
import type { AppConfig, BalanceData, SavedApiKey, UsageResult } from "./types";
import { fetchCurrentUsage } from "./usage-api";
import { errorMessage } from "./error-state";
import type { LeaveBlocker } from "./leave-guard";
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
} from "./api-key-operation";
import {
  applyReadConfig,
  getCommitRevision,
  getCommittedConfig,
  setCommittedConfig,
  subscribeCommittedConfig,
} from "./config-store";

function useSettingsActions(handlers: {
  onUsageLoaded: (usage: UsageResult) => void;
  setUsageStatus: (status: string) => void;
  setShowManualPaste: (show: boolean) => void;
}) {
  const { onUsageLoaded, setUsageStatus, setShowManualPaste } = handlers;
  return React.useCallback(
    (prefix: string) => {
      setUsageStatus(`${prefix}，正在刷新用量数据…`);
      return fetchCurrentUsage()
        .then((usage) => {
          onUsageLoaded(usage);
          // 费用缺失时明确说「未取得」，不能显示成 ¥0.00。
          setUsageStatus(
            `${prefix}，本月消费 ${
              usage.monthCost != null ? fmtMoney(usage.monthCost) : "未取得"
            }`,
          );
          return usage;
        })
        .catch((error) => {
          const message = errorMessage(error);
          setUsageStatus(`${prefix}，但用量刷新失败：${message}`);
          setShowManualPaste(true);
          return null;
        });
    },
    [onUsageLoaded, setUsageStatus, setShowManualPaste],
  );
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
  saveApiKey: () => void;
  clearApiKey: () => void;
  pasteApiKey: () => void;
  saveUsageToken: () => void;
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

export function useSettingsState(handlers: {
  onBalanceLoaded: (balance: BalanceData) => void;
  onBalanceCleared: () => void;
  onUsageLoaded: (usage: UsageResult) => void;
  onUsageCleared: () => void;
  onRefreshIntervalChanged: (seconds: number) => void;
  onAutoRefreshChanged: (enabled: boolean) => void;
}): SettingsState {
  const {
    onBalanceLoaded,
    onBalanceCleared,
    onUsageLoaded,
    onUsageCleared,
    onRefreshIntervalChanged,
    onAutoRefreshChanged,
  } = handlers;

  const [apiKey, setApiKey] = React.useState("");
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
  const [usageToken, setUsageToken] = React.useState("");
  const [usageStatus, setUsageStatus] = React.useState("");
  const [usageSyncing, setUsageSyncing] = React.useState(false);
  const syncRequestId = React.useRef(0);
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
    const syncFromCommitted = (next: AppConfig) => {
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
        // 只有"根本没有 Tauri IPC"才是浏览器预览，属预期情况；真机上失败一律是真实错误，
        // 必须原样透出——否则配置文件损坏会被伪装成"浏览器预览模式"，用户完全无从定位。
        if (!isTauri()) {
          setStatus("浏览器预览模式，未连接本地配置");
          return;
        }
        setStatus(errorMessage(error));
      });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  // 保存 Token 之后刷新用量。这里刻意不向外抛出（见 useSettingsActions）。
  const refreshUsageAfterToken = useSettingsActions({
    onUsageLoaded,
    setUsageStatus,
    setShowManualPaste,
  });

  React.useEffect(() => {
    const unlistenPromise = listen<AppConfig>(
      "usage-token-captured",
      (event) => {
        syncRequestId.current += 1;
        setCommittedConfig(event.payload);
        setUsageSyncing(false);
        void refreshUsageAfterToken("已通过网页登录自动同步用量 Token");
      },
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refreshUsageAfterToken]);

  React.useEffect(() => {
    const unlistenPromise = listen("usage-sync-ended", () => {
      syncRequestId.current += 1;
      setUsageSyncing(false);
      setUsageStatus(
        "未获取到用量 Token。可再次点击同步，或使用方式二手动粘贴。",
      );
      setShowManualPaste(true);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const pasteApiKey = React.useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setApiKey(text.trim());
      setStatus("已从剪贴板读取");
    } catch {
      setStatus("剪贴板读取失败");
    }
  }, []);

  // 复评 T12：保存改为返回 `Promise<boolean>` —— 「保存并离开」需要等待
  // 真实结果，失败时不得导航。
  const saveApiKey = React.useCallback(async (): Promise<boolean> => {
    const operation = beginApiKeyOperation();
    // 复评 R16：记录**本次提交的草稿值**。保存期间用户可能继续输入
    //（旧实现只禁用按钮、不禁输入），成功回调若无条件 `setApiKey("")`
    // 就会把刚输入的新值清掉，用户以为没输入过。
    const submitted = apiKey;
    setBusy(true);
    setStatus("正在验证 API Key…");
    try {
      const { config: nextConfig, balance } = await invoke<SavedApiKey>(
        "save_api_key",
        { apiKey },
      );
      if (!isCurrentApiKeyOperation(operation)) return false;
      setCommittedConfig(nextConfig);
      // 只有输入仍是本次提交值时才清空；否则保留新草稿并提示未保存。
      setApiKey((current) => (current === submitted ? "" : current));
      onBalanceLoaded(balance);
      const symbol = currencySymbol(balance.currency);
      const tip = balance.isAvailable ? "" : "（余额不足）";
      setStatus(`验证通过，当前余额 ${symbol}${balance.totalBalance}${tip}`);
      return true;
    } catch (error) {
      if (!isCurrentApiKeyOperation(operation)) return false;
      setStatus(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [apiKey, onBalanceLoaded]);

  const clearApiKey = React.useCallback(() => {
    const operation = beginApiKeyOperation();
    // 复评 N11：记录清除开始时的草稿值 —— 清除成功返回时若无条件 `setApiKey("")`
    // 会把用户在清除期间新输入的值抹掉（实跑已复现）。只在草稿未变时清空，
    // 否则保留新输入并提示尚未保存。
    const draftAtStart = apiKey;
    setBusy(true);
    void invoke<AppConfig>("clear_api_key")
      .then((nextConfig) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        setCommittedConfig(nextConfig);
        setApiKey((current) => (current === draftAtStart ? "" : current));
        setStatus("已清除 API Key");
        onBalanceCleared();
      })
      .catch((error) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        setStatus(errorMessage(error));
      })
      .finally(() => setBusy(false));
  }, [onBalanceCleared, apiKey]);

  const pasteUsageToken = React.useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUsageToken(text.trim());
      setUsageStatus("已从剪贴板读取");
    } catch {
      setUsageStatus("剪贴板读取失败");
    }
  }, []);

  const startUsageSync = React.useCallback(() => {
    const requestId = ++syncRequestId.current;
    setUsageSyncing(true);
    setUsageStatus("正在打开登录窗口…");
    void invoke<boolean>("start_usage_sync")
      .then((synced) => {
        if (requestId !== syncRequestId.current) return;
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
        if (requestId !== syncRequestId.current) return;
        setUsageSyncing(false);
        setUsageStatus(errorMessage(error));
      });
  }, []);

  const cancelUsageSync = React.useCallback(() => {
    syncRequestId.current += 1;
    void invoke("cancel_usage_sync")
      .then(() => {
        setUsageSyncing(false);
        setUsageStatus("已取消同步，原 Token 未更改");
      })
      .catch((error) => setUsageStatus(errorMessage(error)));
  }, []);

  // 复评 T12：与 API Key 一样返回布尔结果，供「保存并离开」等待。
  const saveUsageToken = React.useCallback(async (): Promise<boolean> => {
    // 复评 R16：与 API Key 同一规则 —— 只清空**本次提交**的草稿值。
    const submitted = usageToken;
    setBusy(true);
    setUsageStatus("正在验证候选 Token…");
    try {
      const nextConfig = await invoke<AppConfig>("save_usage_token", {
        usageToken,
      });
      setCommittedConfig(nextConfig);
      setUsageToken((current) => (current === submitted ? "" : current));
      setUsageStatus("验证通过并已保存，正在刷新用量…");
      return true;
    } catch (error) {
      // 走到这里说明是「保存」这一步失败（刷新阶段的失败已在 refreshUsageAfterToken
      // 内处理并给出更准确的文案），所以不再笼统地说"保存或验证失败"。
      setUsageStatus(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [usageToken]);

  const clearUsageToken = React.useCallback(() => {
    // 复评 N11：与 clearApiKey 同一规则（保留清除期间的新输入）。
    const draftAtStart = usageToken;
    setBusy(true);
    void invoke<AppConfig>("clear_usage_token")
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        setUsageToken((current) => (current === draftAtStart ? "" : current));
        setUsageStatus("已清除用量 Token");
        setUsageSyncing(false);
        onUsageCleared();
      })
      .catch((error) => {
        setUsageStatus(errorMessage(error));
      })
      .finally(() => setBusy(false));
  }, [onUsageCleared, usageToken]);

  // 复评 T13：凭据清除类操作（忘记账户 / `usage-token-cleared` 事件）必须按
  // **草稿代际**清空，而不是无条件 `setUsageToken("")`。
  //
  // 旧实现在 forget 开始后、事件到达后都无条件清空 —— 用户在这两步之间
  // 输入的新 Token 会被直接抹掉。这里记录操作开始时的草稿值：只有草稿
  // **仍是该值**（说明用户没再输入）时才清空；否则保留新草稿。
  // 重复事件/响应幂等：清空后草稿已是空串，再次到来不会误清。
  const forgetDraftRef = React.useRef<string | null>(null);
  const clearIfUnchanged = (submitted: string | null) => {
    setUsageToken((current) =>
      submitted === null || current === submitted ? "" : current,
    );
  };
  const forgetUsageSession = React.useCallback(() => {
    // 记录本次清除所属的草稿版本。
    forgetDraftRef.current = usageToken;
    setBusy(true);
    setUsageStatus("正在清除应用内的网页登录数据…");
    void invoke<AppConfig>("forget_usage_session")
      .then((nextConfig) => {
        setCommittedConfig(nextConfig);
        clearIfUnchanged(forgetDraftRef.current);
        setUsageSyncing(false);
        onUsageCleared();
        setUsageStatus(
          "已清除监控 Token 和应用内网页登录数据，下次同步需要重新登录",
        );
      })
      .catch((error) => setUsageStatus(errorMessage(error)))
      .finally(() => setBusy(false));
  }, [onUsageCleared, usageToken]);

  React.useEffect(() => {
    const cleared = listen<AppConfig>("usage-token-cleared", (event) => {
      setCommittedConfig(event.payload);
      // 复评 T13：事件只清理**操作开始时**的草稿版本；用户在此之后输入
      // 的新候选不会被事件擦掉。
      clearIfUnchanged(forgetDraftRef.current);
      setUsageSyncing(false);
      onUsageCleared();
    });
    return () => {
      void cleared.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [onUsageCleared]);

  // 复评 T12：把凭据草稿登记为离开拦截。设置页聚合「API Key + 用量 Token」
  // 两类草稿（AlertSettings 的提醒草稿由 SettingsPanel 合并），因此这里只
  // 报告凭据这一路；调用方负责组合成单个 blocker。
  //
  // 草稿只存在内存 state，不写 localStorage/sessionStorage/日志；
  // 「保存并离开」等待真实保存结果，失败不导航。
  const apiKeyRef = React.useRef(apiKey);
  apiKeyRef.current = apiKey;
  const usageTokenRef = React.useRef(usageToken);
  usageTokenRef.current = usageToken;
  // 保存函数每次渲染都是新函数，用 ref 转发避免 blocker 闭包过期。
  const saveApiKeyRef = React.useRef(saveApiKey);
  saveApiKeyRef.current = saveApiKey;
  const saveUsageTokenRef = React.useRef(saveUsageToken);
  saveUsageTokenRef.current = saveUsageToken;
  const registerCredentialBlocker = React.useCallback(
    (register: (blocker: LeaveBlocker | null) => void) => {
      const hasDraft =
        apiKeyRef.current.trim().length > 0 ||
        usageTokenRef.current.trim().length > 0;
      register(
        hasDraft
          ? {
              dirty: true,
              subject: "凭据草稿",
              // 保存并离开：两项都尝试保存；任一失败则保留在页。
              save: async () => {
                const results: boolean[] = [];
                if (apiKeyRef.current.trim()) {
                  results.push(await saveApiKeyRef.current());
                }
                if (usageTokenRef.current.trim()) {
                  results.push(await saveUsageTokenRef.current());
                }
                return results.every(Boolean);
              },
              discard: () => {
                // 放弃：只清内存草稿（不触碰已保存凭据）。
                setApiKey("");
                setUsageToken("");
              },
            }
          : null,
      );
    },
    [],
  );

  const saveRefreshInterval = React.useCallback(
    (seconds: number) => {
      if (preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, refresh: "" }));
      const previous = refresh;
      setRefresh(seconds);
      onRefreshIntervalChanged(seconds);
      void invoke<AppConfig>("save_refresh_interval", {
        refreshIntervalSeconds: seconds,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          setRefresh(nextConfig.refreshIntervalSeconds || 60);
          onRefreshIntervalChanged(nextConfig.refreshIntervalSeconds || 60);
        })
        .catch((error) => {
          // 复评 N12：只有可信旧值才回滚（配置未知时控件已禁用）。
          if (previous !== null) {
            setRefresh(previous);
            onRefreshIntervalChanged(previous);
          }
          setSettingErrors((previous) => ({
            ...previous,
            refresh: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          setBusy(false);
        });
    },
    [onRefreshIntervalChanged, refresh],
  );

  const saveAutoRefreshEnabled = React.useCallback(
    (enabled: boolean) => {
      if (preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autoRefresh: "" }));
      const previous = autoRefresh;
      setAutoRefresh(enabled);
      onAutoRefreshChanged(enabled);
      void invoke<AppConfig>("save_auto_refresh_enabled", {
        autoRefreshEnabled: enabled,
      })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          setAutoRefresh(nextConfig.autoRefreshEnabled);
          onAutoRefreshChanged(nextConfig.autoRefreshEnabled);
        })
        .catch((error) => {
          // 复评 N12：配置未知时控件已禁用、不会走到这里；回滚只在有
          // 可信旧值时进行，不用 null 覆盖真实值。
          if (previous !== null) {
            setAutoRefresh(previous);
            onAutoRefreshChanged(previous);
          }
          setSettingErrors((previous) => ({
            ...previous,
            autoRefresh: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          setBusy(false);
        });
    },
    [autoRefresh, onAutoRefreshChanged],
  );

  const saveAutostart = React.useCallback(
    (enabled: boolean) => {
      if (preferenceBusy.current) return;
      preferenceBusy.current = true;
      setBusy(true);
      setSettingErrors((previous) => ({ ...previous, autostart: "" }));
      const previous = autostart;
      setAutostart(enabled);
      void invoke<AppConfig>("save_autostart", { autostart: enabled })
        .then((nextConfig) => {
          setCommittedConfig(nextConfig);
          setAutostart(nextConfig.autostart);
        })
        .catch((error) => {
          // 复评 N12：只有可信旧值才回滚。
          if (previous !== null) setAutostart(previous);
          setSettingErrors((previous) => ({
            ...previous,
            autostart: errorMessage(error),
          }));
        })
        .finally(() => {
          preferenceBusy.current = false;
          setBusy(false);
        });
    },
    [autostart],
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
