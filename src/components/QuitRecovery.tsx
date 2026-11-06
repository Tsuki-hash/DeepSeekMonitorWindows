import React from "react";
import type { QuitRequestState } from "../quit-request";

export function quitRecoveryVisible(state: QuitRequestState) {
  return (
    state.listener === "failed" ||
    (state.recovery && state.listener === "registering") ||
    state.command !== "idle"
  );
}

export function QuitRecovery({
  state,
  onRetryListener,
  onQuit,
}: {
  state: QuitRequestState;
  onRetryListener: () => void;
  onQuit: () => void;
}) {
  if (!quitRecoveryVisible(state)) return null;
  const busy = state.command === "pending" || state.command === "confirmed";
  const listenerRecovery =
    state.listener === "failed" ||
    (state.recovery && state.listener === "registering");
  return (
    <section
      className="config-read-error quit-error"
      role={busy ? "status" : "alert"}
      aria-label="退出状态"
    >
      {listenerRecovery && (
        <>
          <strong>
            {state.listener === "failed"
              ? "托盘退出暂不可用"
              : "正在恢复退出监听…"}
          </strong>
          <p>
            退出监听注册失败。恢复后请再次选择托盘退出，或使用下方安全退出。
          </p>
          <button
            type="button"
            className="secondary"
            disabled={state.listener === "registering"}
            onClick={onRetryListener}
          >
            {state.listener === "registering" ? "正在重试…" : "重试退出监听"}
          </button>
        </>
      )}
      {state.command === "failed" && (
        <>
          <strong>退出失败，应用仍保持打开</strong>
          <p>可以重试退出；重试会重新检查当前未保存的修改。</p>
        </>
      )}
      {busy ? (
        <p>
          {state.command === "confirmed"
            ? "退出请求已提交，正在关闭…"
            : "正在请求退出…"}
        </p>
      ) : (
        <p>安全退出仍会先询问如何处理未保存的修改。</p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={onQuit}
      >
        {state.command === "failed" ? "重试退出" : "安全退出"}
      </button>
    </section>
  );
}
