// Browser-only regression entry, served by the existing Vite dev server.
// Deliberately not part of the synthetic react-test-renderer runner.
// Actual focus and disabled behavior are observed, never mocked or repaired.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { LeavePromptDialog } from "../src/components/LeavePromptDialog";
import { RefreshIntervalChoices } from "../src/components/SettingsPanel";
import { WindowVisibilityGate } from "../src/window-visibility-gate";

const output = document.getElementById("results")!;
const fixture = document.getElementById("fixture")!;
const runButton = document.getElementById("run") as HTMLButtonElement;
const report = (message: string) => {
  output.textContent += `${message}\n`;
};
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const press = (button: HTMLButtonElement, key: string) =>
  button.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );

async function promptScenario(mode: "owned" | "outside" | "revisited") {
  const outside = mode === "outside";
  const trigger = document.createElement("button");
  trigger.textContent = "原触发器";
  const host = document.createElement("div");
  const other = document.createElement("button");
  other.textContent = "外部控件";
  fixture.append(trigger, host, other);
  const root = createRoot(host);
  const gate = new WindowVisibilityGate();
  gate.setVisible(true);
  let submitting = false;
  let closed = false;
  let saves = 0;
  const render = (): void =>
    flushSync(() =>
      root.render(
        <React.StrictMode>
          {closed ? null : (
            <LeavePromptDialog
              subject="合成凭据草稿"
              submitting={submitting}
              windowVisibilityGate={gate}
              onDecide={(decision) => {
                if (decision === "save") {
                  saves += 1;
                  submitting = true;
                } else closed = true;
                render();
              }}
            />
          )}
        </React.StrictMode>,
      ),
    );
  try {
    trigger.focus();
    render();
    await frame();
    const [save, discard, cancel] = Array.from(host.querySelectorAll("button"));
    check(document.activeElement === save, "初始 RAF 应真实聚焦 Save");
    if (mode !== "owned") other.focus();
    if (mode === "revisited") save.focus();
    save.click();
    await frame();
    check(
      save.disabled && discard.disabled && !cancel.disabled,
      "保存中原生禁用 Save/Discard，Cancel 保持可用",
    );
    check(
      document.activeElement === (outside ? other : cancel),
      "提交不得丢焦点或抢走外部焦点",
    );
    save.click();
    discard.click();
    check(saves === 1, "保存中不能重复提交");
    // Failure reenables the same controls; it must not reset keyboard focus.
    submitting = false;
    render();
    await frame();
    check(!save.disabled && !discard.disabled, "保存失败后允许重试");
    check(
      document.activeElement === (outside ? other : cancel),
      "失败不得移动当前焦点",
    );
    cancel.click();
    check(
      document.activeElement ===
        (outside ? other : mode === "revisited" ? document.body : trigger),
      "本次 Save 的同步交接不能复活旧触发器的归还资格",
    );
  } finally {
    flushSync(() => root.unmount());
    trigger.remove();
    host.remove();
    other.remove();
  }
}

async function radioScenario(failed: boolean) {
  const host = document.createElement("div");
  fixture.append(host);
  const root = createRoot(host);
  let value = 60;
  let busy = false;
  const writes: number[] = [];
  const render = (): void =>
    flushSync(() =>
      root.render(
        <React.StrictMode>
          <RefreshIntervalChoices
            value={value}
            busy={busy}
            onChange={(seconds) => {
              check(!busy, "busy 时不应触发保存回调");
              writes.push(seconds);
              value = seconds;
              busy = true;
              render();
            }}
          />
        </React.StrictMode>,
      ),
    );
  try {
    render();
    const radios = Array.from(
      host.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    );
    radios[0].focus();
    press(radios[0], "ArrowRight");
    await frame();
    check(writes.length === 1 && writes[0] === 300, "方向键应保存下一间隔");
    check(document.activeElement === radios[1], "保存中真实焦点应留在新 radio");
    check(
      radios.every(
        (button) =>
          !button.disabled && button.getAttribute("aria-disabled") === "true",
      ),
      "busy 使用 aria-disabled，不能原生禁用焦点",
    );
    press(radios[1], "ArrowRight");
    radios[2].click();
    radios[1].click();
    check(writes.length === 1, "busy 的方向键/原生 click 不得重复保存");
    check(document.activeElement === radios[1], "busy 的方向键不得跳焦点");
    value = failed ? 60 : 300;
    busy = false;
    render();
    await frame();
    check(document.activeElement === radios[1], "完成或回滚必须保持真实焦点");
    check(
      radios[failed ? 0 : 1].getAttribute("aria-checked") === "true",
      "完成或失败应发布正确选中值",
    );
    press(radios[1], "ArrowRight");
    check(
      writes.length === 2 && writes[1] === 1800,
      "回滚后的方向键从实际焦点而非旧选中值出发",
    );
    check(document.activeElement === radios[2], "下一次操作真实聚焦 30 分钟");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  output.textContent = "";
  try {
    check(
      document.visibilityState === "visible" && document.hasFocus(),
      "请先激活测试窗口",
    );
    const probe = document.createElement("button");
    probe.textContent = "平台焦点探针";
    fixture.append(probe);
    probe.focus();
    probe.disabled = true;
    report(
      `平台观察：原生禁用已聚焦按钮后，焦点${document.activeElement === probe ? "仍在原按钮" : "离开原按钮"}。`,
    );
    probe.remove();
    const scenarios: Array<[string, () => Promise<void>]> = [
      ["提示首焦点→保存中→失败→取消归还", () => promptScenario("owned")],
      ["提示已失去焦点所有权时不抢外部焦点", () => promptScenario("outside")],
      [
        "返回提示再次保存可交接，但不复活旧归还",
        () => promptScenario("revisited"),
      ],
      ["刷新间隔慢成功、阻止重复与连续方向键", () => radioScenario(false)],
      ["刷新间隔失败回滚后仍从实际焦点导航", () => radioScenario(true)],
    ];
    for (const [name, scenario] of scenarios) {
      await scenario();
      report(`PASS: ${name}`);
    }
    report(
      "真实 DOM 检查完成。真实键盘默认行为、读屏和 Windows/WebView2 仍需另行验收。",
    );
  } catch (error) {
    report(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    runButton.disabled = false;
    runButton.focus();
  }
});
