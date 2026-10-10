import React from "react";
import { GlassSettings } from "./GlassSettings";
import {
  BarChart3,
  CheckCircle2,
  Info,
  KeyRound,
  Power,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { refreshOptions } from "../usage-api";
import { useTheme } from "../theme";
import { useSettingsState } from "../settings-state";
import type { BalanceData, UsageResult, LoadState } from "../types";
import { updateTime, snapshotAge, snapshotHealth } from "../data-display";
import { usageNotices } from "../usage-notices";
import { SupportSettings } from "./SupportSettings";
import { DesktopSettings } from "./DesktopSettings";
import { AlertSettings } from "./AlertSettings";
import { BrandIcon } from "./BrandIcon";
import { SettingsSection, Toggle } from "./ui";

// 状态与动作在 useSettingsState（评审 F-09 拆分），本组件只负责视图与文案。
function SettingsPanel({
  balanceUpdatedAt,
  usageUpdatedAt,
  balanceError = "",
  usageError = "",
  balanceState = "loading",
  usageState = "loading",
  balanceErrorCode,
  usageErrorCode,
  usage,
  showDataNotices = false,
  onRetry,
  onBack,
  onBalanceLoaded,
  onBalanceCleared,
  onUsageLoaded,
  onUsageCleared,
  onRefreshIntervalChanged,
  onAutoRefreshChanged,
}: {
  balanceUpdatedAt?: number | null;
  usageUpdatedAt?: number | null;
  balanceError?: string;
  usageError?: string;
  balanceState?: LoadState;
  usageState?: LoadState;
  balanceErrorCode?: string;
  usageErrorCode?: string;
  usage?: UsageResult | null;
  showDataNotices?: boolean;
  onRetry?: () => Promise<unknown>;
  onBack: () => void;
  onBalanceLoaded: (balance: BalanceData) => void;
  onBalanceCleared: () => void;
  onUsageLoaded: (usage: UsageResult) => void;
  onUsageCleared: () => void;
  onRefreshIntervalChanged: (seconds: number) => void;
  onAutoRefreshChanged: (enabled: boolean) => void;
}) {
  const {
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
  } = useSettingsState({
    onBalanceLoaded,
    onBalanceCleared,
    onUsageLoaded,
    onUsageCleared,
    onRefreshIntervalChanged,
    onAutoRefreshChanged,
  });
  const { theme, toggleTheme } = useTheme();
  const [retrying, setRetrying] = React.useState(false);
  const [confirmForget, setConfirmForget] = React.useState(false);
  const notices = usageNotices(usage ?? null);
  const [healthClock, setHealthClock] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setHealthClock(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const noticesRef = React.useRef<HTMLDetailsElement>(null);
  React.useEffect(() => {
    if (showDataNotices) noticesRef.current?.scrollIntoView({ block: "start" });
  }, [showDataNotices]);

  return (
    <section className="settings-panel" data-testid="settings-panel">
      <button
        className="floating-close settings-close"
        onClick={onBack}
        aria-label="返回主面板"
      >
        <X size={20} />
      </button>
      <div className="settings-inner">
        <header className="settings-header" data-tauri-drag-region>
          <BrandIcon size={42} />
          <div>
            <h1>DeepSeek Monitor</h1>
            <p>设置</p>
          </div>
        </header>

        <SettingsSection icon={<KeyRound size={15} />} title="API Key">
          <p>
            仅用于查询账户余额（用量需网页登录
            Token，见下一节）。会保存在应用本地设置中。
          </p>
          <p className="muted">API Key 只在当前这台 Windows 电脑本地保留。</p>
          <details className="settings-disclosure">
            <summary>本地存储位置</summary>
            <p className="muted config-path">{configPath}</p>
          </details>
          <div className="key-row">
            <input
              aria-label="API Key"
              type="password"
              value={apiKey}
              placeholder={
                config?.apiKeyConfigured
                  ? "•••••••••••••••••••••••••••••••••••••••••••••••••••"
                  : "sk-..."
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="settings-actions">
            <button
              className="primary"
              onClick={saveApiKey}
              disabled={busy || !apiKey.trim()}
            >
              验证并保存
            </button>
            <button className="secondary" onClick={pasteApiKey} disabled={busy}>
              粘贴
            </button>
            <span
              className={
                config?.apiKeyConfigured
                  ? balanceError
                    ? "configured warning"
                    : "configured"
                  : "configured missing"
              }
            >
              {config?.apiKeyConfigured && !balanceError ? (
                <CheckCircle2 size={17} />
              ) : (
                <XCircle size={17} />
              )}
              {config?.apiKeyConfigured
                ? balanceError
                  ? "查询异常"
                  : "已配置"
                : "未配置"}
            </span>
            <button
              className="secondary"
              onClick={clearApiKey}
              disabled={busy || !config?.apiKeyConfigured}
            >
              清除 Key
            </button>
          </div>
          <p className="muted" role="status">
            {status}
          </p>
          {config?.configWarnings?.map((warning) => (
            <p className="muted" role="alert" key={warning}>
              {warning}
            </p>
          ))}
        </SettingsSection>

        <SettingsSection icon={<BarChart3 size={15} />} title="用量同步 Token">
          <p>
            用于同步 Token 用量、消费和趋势图。DeepSeek 无官方用量
            API，需网页登录 token（与上面的 API Key 不同）。
          </p>
          <p className="muted">方式一网页登录自动同步</p>
          <div className="settings-actions usage-sync-actions">
            <button
              className="primary"
              onClick={usageSyncing ? cancelUsageSync : startUsageSync}
              disabled={busy}
            >
              {usageSyncing ? "取消同步" : "网页登录自动同步"}
            </button>
            <span
              className={
                config?.usageTokenConfigured
                  ? usageError
                    ? "configured warning"
                    : "configured"
                  : "configured missing"
              }
            >
              {config?.usageTokenConfigured && !usageError ? (
                <CheckCircle2 size={17} />
              ) : (
                <XCircle size={17} />
              )}
              {config?.usageTokenConfigured
                ? usageError
                  ? "查询异常"
                  : "已配置"
                : "未配置"}
            </span>
            <button
              className="secondary"
              onClick={clearUsageToken}
              disabled={busy || !config?.usageTokenConfigured}
            >
              清除 Token
            </button>
          </div>
          <p className="muted" role="status">
            {usageStatus}
          </p>
          <details
            className="settings-disclosure"
            onToggle={(event) => {
              if (!event.currentTarget.open) setConfirmForget(false);
            }}
          >
            <summary>账户隐私</summary>
            <p className="muted">
              “清除 Token”保留网页登录会话；“退出并忘记账户”同时清除本应用的
              Token 与网页登录数据。API Key 和其他设置保留。
            </p>
            {confirmForget ? (
              <>
                <p>清除后需要重新登录，确定继续？</p>
                <div className="disclosure-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setConfirmForget(false);
                      forgetUsageSession();
                    }}
                  >
                    确认清除
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirmForget(false)}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <div className="disclosure-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirmForget(true)}
                >
                  退出并忘记账户
                </button>
              </div>
            )}
          </details>
          <button
            className="link-button"
            onClick={() => setShowManualPaste((value) => !value)}
          >
            {showManualPaste ? "收起手动粘贴" : "方式二：手动粘贴 token"}
          </button>
          {showManualPaste && (
            <>
              <p className="muted">
                获取：浏览器登录 platform.deepseek.com，按 F12 打开开发者工具，
                切到「控制台 / Console」标签，在 ❯ 提示符后输入
                JSON.parse(localStorage.userToken).value
                回车，右键复制返回的字符串。
              </p>
              <p className="muted">
                若返回 undefined（平台可能调整了存储键名），改输入{" "}
                {
                  "Object.entries(localStorage).filter(([k]) => /token/i.test(k))"
                }
                ，从结果里找形如 token 的长字符串复制。
              </p>
              <p className="muted">
                token 会过期，用量查询失败时重新获取一次即可。
              </p>
              <div className="key-row">
                <input
                  aria-label="用量 Token"
                  type="password"
                  value={usageToken}
                  placeholder={
                    config?.usageTokenConfigured
                      ? "•••••••••••••••••••••••••••••••••••••••••••••••••••"
                      : ""
                  }
                  onChange={(event) => setUsageToken(event.target.value)}
                />
              </div>
              <div className="settings-actions">
                <button
                  className="primary"
                  onClick={saveUsageToken}
                  disabled={busy || !usageToken.trim()}
                >
                  保存 Token
                </button>
                <button
                  className="secondary"
                  onClick={pasteUsageToken}
                  disabled={busy}
                >
                  粘贴
                </button>
              </div>
            </>
          )}
        </SettingsSection>

        <SettingsSection icon={<Info size={15} />} title="数据状态与口径">
          <details
            className="settings-disclosure"
            ref={noticesRef}
            open={showDataNotices || undefined}
          >
            <summary>
              {balanceError || usageError || notices.length
                ? "查看更新状态与数据提示"
                : "更新时间与统计说明"}
            </summary>
            <p className="muted">
              余额来自官方余额
              API；用量来自平台网页登录接口。两种凭据分别配置，尚未核对是否属于同一账户。
            </p>
            <p className="muted">
              {usage
                ? "当前用量来自最近成功快照"
                : "当前没有可用的本月用量快照"}
              ；旧数据按最近成功时间判断新鲜程度，凭据失效时重新同步，未取得的日期不代表零用量。
            </p>
            <div className="update-status-row">
              <span>余额更新</span>
              <span>{updateTime(balanceUpdatedAt, true)}</span>
            </div>
            <div className="update-status-row">
              <span>
                {snapshotHealth(
                  balanceState,
                  balanceState === "ok" && balanceUpdatedAt != null,
                  balanceError,
                  balanceErrorCode,
                )}
              </span>
              <span>{snapshotAge(balanceUpdatedAt, healthClock)}</span>
            </div>
            {balanceError && (
              <p className="data-error" role="alert">
                余额：{balanceError}
              </p>
            )}
            <div className="update-status-row">
              <span>用量更新</span>
              <span>{updateTime(usageUpdatedAt, true)}</span>
            </div>
            <div className="update-status-row">
              <span>
                {snapshotHealth(
                  usageState,
                  usage != null,
                  usageError,
                  usageErrorCode,
                  notices.length > 0,
                )}
              </span>
              <span>{snapshotAge(usageUpdatedAt, healthClock)}</span>
            </div>
            {usageError && (
              <p className="data-error" role="alert">
                用量：{usageError}
              </p>
            )}
            {(balanceError || usageError) && (
              <p className="muted">
                网络更新失败时，保留上次数据与更新时间；凭据失效时需重新配置。
              </p>
            )}
            {(balanceError || usageError) && onRetry && (
              <div className="disclosure-actions">
                <button
                  className="secondary"
                  disabled={retrying || busy}
                  onClick={() => {
                    setRetrying(true);
                    void onRetry().finally(() => setRetrying(false));
                  }}
                >
                  {retrying ? "更新中…" : "重试更新"}
                </button>
                <button
                  className="secondary"
                  disabled={busy || usageSyncing}
                  onClick={startUsageSync}
                >
                  重新同步用量
                </button>
              </div>
            )}
            {notices.map((notice) => (
              <p className="muted" key={notice}>
                {notice}
              </p>
            ))}
            <p className="muted">
              更新时间按本机时区显示。用量按平台东八区记账：本月为自然月，图表为近7日（含今天）。
            </p>
            <p className="muted">
              缓存命中率 = 命中输入 ÷（命中输入 +
              未命中输入），不含输出与未知输入；输入明细不足时不计算。
            </p>
            <p className="muted">
              T/¥ 表示本月 Token 总数 ÷ 本月人民币费用。费用为零时显示
              —；它是用量比率，不是模型单价。
            </p>
          </details>
        </SettingsSection>

        <SettingsSection icon={<Power size={15} />} title="开机自启">
          <p>开启后，每次登录 Windows 时自动启动 DeepSeek Monitor。</p>
          <Toggle
            label="登录时自动启动"
            checked={autostart}
            onChange={saveAutostart}
            disabled={busy}
          />
          {settingErrors.autostart && (
            <p className="muted" role="alert">
              {settingErrors.autostart}
            </p>
          )}
        </SettingsSection>

        <SettingsSection icon={<RefreshCw size={15} />} title="自动刷新">
          <p>开启后，按设定周期自动从 DeepSeek API 拉取最新数据。</p>
          <Toggle
            label="启用自动刷新"
            checked={autoRefresh}
            onChange={saveAutoRefreshEnabled}
            disabled={busy}
          />
          {settingErrors.autoRefresh && (
            <p className="muted" role="alert">
              {settingErrors.autoRefresh}
            </p>
          )}
          {autoRefresh && (
            <div className="segmented">
              {refreshOptions.map((option) => (
                <button
                  key={option.value}
                  className={refresh === option.value ? "selected" : ""}
                  onClick={() => saveRefreshInterval(option.value)}
                  disabled={busy}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {settingErrors.refresh && (
            <p className="muted" role="alert">
              {settingErrors.refresh}
            </p>
          )}
          <AlertSettings />
        </SettingsSection>

        <SettingsSection icon={<Info size={15} />} title="外观">
          <GlassSettings />
          <DesktopSettings />
          <Toggle
            label={
              theme === "dark"
                ? "深色皮肤（点击切换浅色）"
                : "浅色皮肤（点击切换深色）"
            }
            checked={theme === "light"}
            onChange={toggleTheme}
          />
        </SettingsSection>

        <SettingsSection icon={<Info size={15} />} title="关于">
          <div className="version-row">
            <span>当前版本</span>
            <strong>{appVersion ? `v${appVersion}` : "—"}</strong>
          </div>
          <SupportSettings />
        </SettingsSection>
      </div>
    </section>
  );
}
export { SettingsPanel };
