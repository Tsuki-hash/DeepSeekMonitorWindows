import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui";
import { errorMessage } from "../error-state";
import { updateTime } from "../data-display";
import { alertDraftAmounts, alertStateLabel } from "../alert-options";
import type { AlertOptions, AlertStatus } from "../alert-options";

export function AlertSettings() {
  const [status, setStatus] = React.useState<AlertStatus | null>(null);
  const [draft, setDraft] = React.useState<AlertOptions | null>(null);
  const [low, setLow] = React.useState("");
  const [budget, setBudget] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const control = React.useRef({ active: true, sequence: 0 });
  const accept = React.useCallback((value: AlertStatus, reset: boolean) => {
    setStatus(value);
    if (reset) {
      setError("");
      setDraft(value.options);
      setLow(String(value.options.lowBalanceCny));
      setBudget(String(value.options.monthlyBudgetCny));
    }
  }, []);
  const reload = React.useCallback(
    async (reset = false) => {
      const sequence = ++control.current.sequence;
      try {
        const value = await invoke<AlertStatus>("get_alert_status");
        if (control.current.active && sequence === control.current.sequence)
          accept(value, reset);
      } catch (failure) {
        if (control.current.active && sequence === control.current.sequence)
          setError(errorMessage(failure));
      }
    },
    [accept],
  );
  React.useEffect(() => {
    const current = control.current;
    current.active = true;
    void reload(true);
    return () => {
      current.active = false;
      current.sequence++;
    };
  }, [reload]);
  const ready = status !== null;
  React.useEffect(() => {
    if (!open || busy || !ready) return;
    const timer = window.setInterval(() => void reload(), 10000);
    return () => window.clearInterval(timer);
  }, [open, busy, ready, reload]);
  const dirty =
    draft &&
    status &&
    (JSON.stringify(draft) !== JSON.stringify(status.options) ||
      low !== String(status.options.lowBalanceCny) ||
      budget !== String(status.options.monthlyBudgetCny));
  const save = async () => {
    if (!draft || !status) return;
    setError("");
    setMessage("");
    let options: AlertOptions;
    try {
      options = {
        ...draft,
        ...alertDraftAmounts(draft, status.options, low, budget),
      };
      if (
        options.enabled &&
        !options.lowBalanceEnabled &&
        !options.monthlyBudgetEnabled
      )
        throw new Error("请至少开启一种提醒");
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    setBusy(true);
    const sequence = ++control.current.sequence;
    try {
      const value = await invoke<AlertStatus>("save_alert_options", {
        options,
      });
      if (control.current.active && sequence === control.current.sequence) {
        accept(value, true);
        setMessage("提醒设置已保存");
      }
    } catch (failure) {
      if (control.current.active && sequence === control.current.sequence) {
        setError(errorMessage(failure));
        void reload();
      }
    } finally {
      if (control.current.active) setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    ++control.current.sequence;
    try {
      await invoke("test_alert_notification");
      if (control.current.active) {
        setMessage("已提交 Windows，请查看通知中心");
        void reload();
      }
    } catch (failure) {
      if (control.current.active) setError(errorMessage(failure));
    } finally {
      if (control.current.active) setBusy(false);
    }
  };
  const change = (value: Partial<AlertOptions>) => {
    if (draft) {
      setDraft({ ...draft, ...value });
      setMessage("");
    }
  };
  return (
    <details
      className="settings-disclosure alert-settings"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>余额与预算提醒</summary>
      <Toggle
        label="启用提醒"
        checked={draft?.enabled || false}
        disabled={busy || !draft}
        onChange={(enabled) => change({ enabled })}
      />
      <p className="muted">开启后，收起面板也会每5分钟检查；退出应用后停止。</p>
      {draft?.enabled && (
        <>
          <div className="alert-rule">
            <Toggle
              label="低余额提醒"
              checked={draft.lowBalanceEnabled}
              disabled={busy}
              onChange={(lowBalanceEnabled) => change({ lowBalanceEnabled })}
            />
            <label className="alert-amount">
              <span>人民币提醒线</span>
              <span className="alert-input">
                <span aria-hidden="true">¥</span>
                <input
                  aria-label="余额提醒线"
                  type="number"
                  min="0"
                  max="1000000000"
                  step="0.01"
                  value={low}
                  disabled={busy || !draft.lowBalanceEnabled}
                  onChange={(event) => setLow(event.target.value)}
                />
              </span>
            </label>
          </div>
          <div className="alert-rule">
            <Toggle
              label="月预算提醒"
              checked={draft.monthlyBudgetEnabled}
              disabled={busy}
              onChange={(monthlyBudgetEnabled) =>
                change({ monthlyBudgetEnabled })
              }
            />
            <label className="alert-amount">
              <span>平台本月预算</span>
              <span className="alert-input">
                <span aria-hidden="true">¥</span>
                <input
                  aria-label="月预算金额"
                  type="number"
                  min="0.01"
                  max="1000000000"
                  step="0.01"
                  value={budget}
                  disabled={busy || !draft.monthlyBudgetEnabled}
                  onChange={(event) => setBudget(event.target.value)}
                />
              </span>
            </label>
          </div>
          <Toggle
            label="夜间免打扰"
            checked={draft.quietHours}
            disabled={busy}
            onChange={(quietHours) => change({ quietHours })}
          />
          <p className="muted">
            本机22:00–08:00不发自动提醒，时段结束后重新核对。低余额24小时冷却；预算按凭据和提醒线每月一次。
          </p>
        </>
      )}
      <div className="disclosure-actions">
        <button
          className="primary"
          disabled={busy || !draft || !dirty}
          onClick={() => void save()}
        >
          {busy ? "处理中…" : "保存提醒设置"}
        </button>
        <button
          className="secondary"
          disabled={busy || !status?.options.enabled || Boolean(dirty)}
          onClick={() => void test()}
        >
          发送测试通知
        </button>
      </div>
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
      {!draft && error && (
        <button className="secondary" onClick={() => void reload(true)}>
          重新读取设置
        </button>
      )}
      {dirty && <p className="muted">修改尚未保存</p>}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {status?.error && (
        <p className="data-error" role="alert">
          {status.error}
        </p>
      )}
      {status?.options.enabled && (
        <div className="alert-health">
          {(["balance", "budget"] as const).map((source) => (
            <div key={source}>
              <strong>{source === "balance" ? "余额检查" : "预算检查"}</strong>
              <span>
                {alertStateLabel(
                  source === "balance"
                    ? status.balanceState
                    : status.budgetState,
                  source,
                )}
              </span>
              {(source === "balance"
                ? status.balanceCheckedAt
                : status.budgetCheckedAt) && (
                <small>
                  {updateTime(
                    (source === "balance"
                      ? status.balanceCheckedAt
                      : status.budgetCheckedAt)!,
                  )}
                </small>
              )}
            </div>
          ))}
          {status.quietNow && <p className="muted">当前处于夜间免打扰</p>}
        </div>
      )}
      <details className="alert-explanation">
        <summary>提醒说明</summary>
        <p className="muted">
          只用成功且有效的最新查询触发提醒；失败时逐步退避至30分钟，凭据失效暂停该项。预算按平台东八区自然月费用，不计本地Agent用量，也不会阻止消费。
        </p>
        <p className="muted">
          余额Key与用量Token的账户尚未自动匹配，两项独立判断。Windows通知显示由系统设置控制；测试通知不受本应用夜间时段限制，至少间隔60秒。
        </p>
        <p className="muted">
          通知不含金额或凭据。提醒线、开关与去重摘要保存在本机；更换凭据或提醒线会按新规则去重。
        </p>
      </details>
    </details>
  );
}
