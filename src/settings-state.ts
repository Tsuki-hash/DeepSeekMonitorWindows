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
import {
  beginApiKeyOperation,
  isCurrentApiKeyOperation,
} from "./api-key-operation";

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
  refresh: number;
  autoRefresh: boolean;
  autostart: boolean;
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
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [status, setStatus] = React.useState("正在读取本地配置");
  const [busy, setBusy] = React.useState(false);
  const preferenceBusy = React.useRef(false);
  const [settingErrors, setSettingErrors] = React.useState<
    SettingsState["settingErrors"]
  >({});
  const [refresh, setRefresh] = React.useState(60);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [autostart, setAutostart] = React.useState(false);
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
    void invoke<AppConfig>("get_app_config")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setRefresh(nextConfig.refreshIntervalSeconds || 60);
        setAutoRefresh(nextConfig.autoRefreshEnabled);
        setAutostart(nextConfig.autostart);
        setStatus(
          nextConfig.apiKeyConfigured
            ? nextConfig.apiKeyPreview
              ? `已配置 ${nextConfig.apiKeyPreview}`
              : "API Key 已配置"
            : "未配置 API Key",
        );
        setUsageStatus(
          nextConfig.usageTokenConfigured
            ? "用量 Token 已配置"
            : "未配置用量 Token",
        );
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
        setConfig(event.payload);
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

  const saveApiKey = React.useCallback(() => {
    const operation = beginApiKeyOperation();
    setBusy(true);
    setStatus("正在验证 API Key…");
    void invoke<SavedApiKey>("save_api_key", { apiKey })
      .then(({ config: nextConfig, balance }) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        setConfig(nextConfig);
        setApiKey("");
        onBalanceLoaded(balance);
        const symbol = currencySymbol(balance.currency);
        const tip = balance.isAvailable ? "" : "（余额不足）";
        setStatus(`验证通过，当前余额 ${symbol}${balance.totalBalance}${tip}`);
      })
      .catch((error) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        const message = errorMessage(error);
        setStatus(message);
      })
      .finally(() => setBusy(false));
  }, [apiKey, onBalanceLoaded]);

  const clearApiKey = React.useCallback(() => {
    const operation = beginApiKeyOperation();
    setBusy(true);
    void invoke<AppConfig>("clear_api_key")
      .then((nextConfig) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        setConfig(nextConfig);
        setApiKey("");
        setStatus("已清除 API Key");
        onBalanceCleared();
      })
      .catch((error) => {
        if (!isCurrentApiKeyOperation(operation)) return;
        setStatus(errorMessage(error));
      })
      .finally(() => setBusy(false));
  }, [onBalanceCleared]);

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

  const saveUsageToken = React.useCallback(() => {
    setBusy(true);
    setUsageStatus("正在验证候选 Token…");
    void invoke<AppConfig>("save_usage_token", { usageToken })
      .then((nextConfig) => {
        setConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("验证通过并已保存，正在刷新用量…");
      })
      .catch((error) => {
        // 走到这里说明是「保存」这一步失败（刷新阶段的失败已在 refreshUsageAfterToken
        // 内处理并给出更准确的文案），所以不再笼统地说"保存或验证失败"。
        setUsageStatus(errorMessage(error));
      })
      .finally(() => setBusy(false));
  }, [usageToken]);

  const clearUsageToken = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("clear_usage_token")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("已清除用量 Token");
        setUsageSyncing(false);
        onUsageCleared();
      })
      .catch((error) => {
        setUsageStatus(errorMessage(error));
      })
      .finally(() => setBusy(false));
  }, [onUsageCleared]);

  const forgetUsageSession = React.useCallback(() => {
    setBusy(true);
    setUsageStatus("正在清除应用内的网页登录数据…");
    void invoke<AppConfig>("forget_usage_session")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setUsageToken("");
        setUsageSyncing(false);
        onUsageCleared();
        setUsageStatus(
          "已清除监控 Token 和应用内网页登录数据，下次同步需要重新登录",
        );
      })
      .catch((error) => setUsageStatus(errorMessage(error)))
      .finally(() => setBusy(false));
  }, [onUsageCleared]);

  React.useEffect(() => {
    const cleared = listen<AppConfig>("usage-token-cleared", (event) => {
      setConfig(event.payload);
      setUsageToken("");
      setUsageSyncing(false);
      onUsageCleared();
    });
    return () => {
      void cleared.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [onUsageCleared]);

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
          setConfig(nextConfig);
          setRefresh(nextConfig.refreshIntervalSeconds || 60);
          onRefreshIntervalChanged(nextConfig.refreshIntervalSeconds || 60);
        })
        .catch((error) => {
          setRefresh(previous);
          onRefreshIntervalChanged(previous);
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
          setConfig(nextConfig);
          setAutoRefresh(nextConfig.autoRefreshEnabled);
          onAutoRefreshChanged(nextConfig.autoRefreshEnabled);
        })
        .catch((error) => {
          setAutoRefresh(previous);
          onAutoRefreshChanged(previous);
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
          setConfig(nextConfig);
          setAutostart(nextConfig.autostart);
        })
        .catch((error) => {
          setAutostart(previous);
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
  };
}
