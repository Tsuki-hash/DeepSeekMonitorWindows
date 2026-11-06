import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "./ui";
import { errorMessage } from "../error-state";
import { updateTime } from "../data-display";
import { alertDraftAmounts, alertStateLabel } from "../alert-options";
import type { LeaveBlocker } from "../leave-guard";
import type { AlertOptions, AlertStatus } from "../alert-options";

export function AlertSettings({
  onRegisterLeaveBlocker,
}: {
  /** 第五轮复评 N04：把未保存草稿登记为 App 级离开拦截，退出前协商。 */
  onRegisterLeaveBlocker?: (
    blocker: LeaveBlocker | null,
  ) => void | (() => void);
} = {}) {
  const [status, setStatus] = React.useState<AlertStatus | null>(null);
  const [draft, setDraft] = React.useState<AlertOptions | null>(null);
  const [low, setLow] = React.useState("");
  const [budget, setBudget] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  // 复评 F07：**读取代际与写操作所有权分开**。
  // 旧实现把 save 与 reload 共用一个 sequence，且 save 失败时在 catch 里
  // 启动 reload —— reload 在第一个 await 前就递增 sequence，于是 save 的
  // finally 发现序号已变、不再 `setBusy(false)`；reload 自己也不负责清 busy，
  // 结果整个提醒表单永久停在「处理中…」。
  // 现在：`readSequence` 只保护读取回填，`writeSequence` 只保护写入的
  // busy/成功/错误；reload 永不触碰 busy，save 的 finally 只按自己的写令牌
  // 释放 busy。
  const control = React.useRef({
    active: true,
    readSequence: 0,
    writeSequence: 0,
  });
  const live = React.useRef({
    status: null as AlertStatus | null,
    draft: null as AlertOptions | null,
    low: "",
    budget: "",
    revision: 0,
    committedRevision: 0,
  });
  const dirtyNow = React.useCallback(() => {
    const value = live.current;
    return Boolean(
      value.draft &&
      value.status &&
      (value.revision !== value.committedRevision ||
        JSON.stringify(value.draft) !== JSON.stringify(value.status.options) ||
        value.low !== String(value.status.options.lowBalanceCny) ||
        value.budget !== String(value.status.options.monthlyBudgetCny)),
    );
  }, []);
  const accept = React.useCallback((value: AlertStatus, reset: boolean) => {
    live.current.status = value;
    setStatus(value);
    if (reset) {
      live.current.draft = value.options;
      live.current.low = String(value.options.lowBalanceCny);
      live.current.budget = String(value.options.monthlyBudgetCny);
      live.current.revision += 1;
      live.current.committedRevision = live.current.revision;
      setError("");
      setDraft(value.options);
      setLow(String(value.options.lowBalanceCny));
      setBudget(String(value.options.monthlyBudgetCny));
    }
  }, []);
  const reload = React.useCallback(
    async (reset = false) => {
      const sequence = ++control.current.readSequence;
      // 复评 R13：读取发起时捕获**写代际** —— 若期间有保存成功（基线已被
      // 写响应更新），这次读取就是过期的，不得覆盖基线或把表单重新标脏。
      const writeAtStart = control.current.writeSequence;
      try {
        const value = await invoke<AlertStatus>("get_alert_status");
        if (
          control.current.active &&
          sequence === control.current.readSequence &&
          writeAtStart === control.current.writeSequence
        )
          accept(value, reset);
      } catch (failure) {
        if (
          control.current.active &&
          sequence === control.current.readSequence &&
          writeAtStart === control.current.writeSequence
        )
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
      current.readSequence++;
      current.writeSequence++;
    };
  }, [reload]);
  const ready = status !== null;
  React.useEffect(() => {
    if (!open || busy || !ready) return;
    const timer = window.setInterval(() => void reload(), 10000);
    return () => window.clearInterval(timer);
  }, [open, busy, ready, reload]);
  const dirty = dirtyNow();
  const pendingSaves = React.useRef(new Map<number, Promise<boolean>>());
  const saveSnapshot = async (
    submitted: typeof live.current,
  ): Promise<boolean> => {
    const { draft, status, low, budget, revision } = submitted;
    if (!control.current.active || !draft || !status) return false;
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
      return false;
    }
    setBusy(true);
    // 复评 R13：写开始即作废在途读取（它们反映的是旧基线），
    // 并递增写代际让任何已发起的读取结果失效。
    control.current.readSequence++;
    const sequence = ++control.current.writeSequence;
    try {
      const value = await invoke<AlertStatus>("save_alert_options", {
        options,
      });
      if (
        control.current.active &&
        sequence === control.current.writeSequence
      ) {
        // A later edit, including ABA, is a new draft even if text is equal.
        accept(value, live.current.revision === revision);
        setMessage("提醒设置已保存");
        return !dirtyNow();
      }
      // 组件已卸载或更新操作已取代当前保存：不算当前设置实例的成功。
      return false;
    } catch (failure) {
      if (
        control.current.active &&
        sequence === control.current.writeSequence
      ) {
        setError(errorMessage(failure));
        // 复评 F07：回读**不得**影响写操作的 busy —— 它有自己的读取代际。
        void reload();
      }
      return false;
    } finally {
      // 复评 F07：只按**写令牌**释放自己的 busy。旧实现用共享序号，
      // catch 里的 reload 一递增就永远进不来，表单卡在「处理中…」。
      if (control.current.active && sequence === control.current.writeSequence)
        setBusy(false);
    }
  };
  const save = (submitted = { ...live.current }): Promise<boolean> => {
    const pending = pendingSaves.current.get(submitted.revision);
    if (pending) return pending;
    const saving = saveSnapshot(submitted).finally(() => {
      pendingSaves.current.delete(submitted.revision);
    });
    pendingSaves.current.set(submitted.revision, saving);
    return saving;
  };
  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useLayoutEffect(() => {
    const prepareSave = () => {
      const submitted = { ...live.current };
      return () => saveRef.current(submitted);
    };
    const dispose = onRegisterLeaveBlocker?.({
      get dirty() {
        return dirtyNow();
      },
      subject: "提醒设置",
      canLeave: () => !dirtyNow(),
      prepareSave,
      save: () => prepareSave()(),
      discard: () => {
        if (live.current.status) accept(live.current.status, true);
        setMessage("");
      },
    });
    return () => {
      if (typeof dispose === "function") dispose();
      else onRegisterLeaveBlocker?.(null);
    };
  }, [onRegisterLeaveBlocker, dirtyNow, accept]);

  const test = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    // 复评 F07：测试通知也是写操作，用写令牌保护自己的 busy。
    // 复评 R13：写操作作废在途读取。
    control.current.readSequence++;
    const sequence = ++control.current.writeSequence;
    try {
      await invoke("test_alert_notification");
      if (
        control.current.active &&
        sequence === control.current.writeSequence
      ) {
        setMessage("已提交 Windows，请查看通知中心");
        void reload();
      }
    } catch (failure) {
      if (control.current.active && sequence === control.current.writeSequence)
        setError(errorMessage(failure));
    } finally {
      if (control.current.active && sequence === control.current.writeSequence)
        setBusy(false);
    }
  };
  const change = (value: Partial<AlertOptions>) => {
    if (live.current.draft) {
      live.current.revision += 1;
      live.current.draft = { ...live.current.draft, ...value };
      setDraft(live.current.draft);
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
                  onChange={(event) => {
                    live.current.revision += 1;
                    live.current.low = event.target.value;
                    setLow(event.target.value);
                  }}
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
                  onChange={(event) => {
                    live.current.revision += 1;
                    live.current.budget = event.target.value;
                    setBudget(event.target.value);
                  }}
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
          只用成功且有效的最新查询触发提醒；失败时逐步退避至30分钟，凭据失效暂停该项。预算按 DeepSeek 平台东八区自然月费用判断，提醒不会阻止消费。
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
