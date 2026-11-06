import React from "react";
import { useQuitInteractionGate } from "../quit-interaction-context";
import {
  alphaFromTransparency,
  clampGlass,
  DEFAULT_GLASS,
  resolveTransparency,
  transparencyFromAlpha,
} from "../glass-preference";

export const GLASS_KEY = "ui-glass-transparency";
export { DEFAULT_GLASS };

/**
 * 读取当前**生效**的透明度（百分比）。
 *
 * 复评 F21：存储被清空时（「退出并忘记账户」会清 WebView 数据），
 * 旧实现直接回退默认值 5，用户自定义的透明度因此丢失。
 * 这里先从 CSS 变量反推当前生效值，再从 DOM 属性兜底，
 * 只有在完全没有痕迹时才使用默认值。
 */
export function readEffectiveGlass(): number {
  const root = document.documentElement;
  const fromAlpha = transparencyFromAlpha(
    root.style.getPropertyValue("--glass-alpha"),
  );
  if (fromAlpha != null) return fromAlpha;
  const dataValue = root.getAttribute("data-glass-transparency");
  if (dataValue != null) {
    const parsed = Number(dataValue);
    if (Number.isFinite(parsed)) return clampGlass(parsed);
  }
  return DEFAULT_GLASS;
}

/**
 * 应用已保存的透明度。
 *
 * 存储被清空时用**当前生效值**恢复并写回，而不是静默重置为默认值；
 * 同时把生效值写进 `data-glass-transparency`，供清理后再次读取。
 */
export function applyStoredGlass() {
  const raw = localStorage.getItem(GLASS_KEY);
  const effective = readEffectiveGlass();
  const transparency = resolveTransparency(raw, effective);
  if (raw == null || !Number.isFinite(Number(raw))) {
    // 写回，避免清理后偏好被反复重置。
    localStorage.setItem(GLASS_KEY, String(transparency));
  }
  document.documentElement.style.setProperty(
    "--glass-alpha",
    String(alphaFromTransparency(transparency)),
  );
  document.documentElement.setAttribute(
    "data-glass-transparency",
    String(transparency),
  );
  return transparency;
}
export function GlassSettings() {
  const interactionGate = useQuitInteractionGate();
  const [value, setValue] = React.useState(applyStoredGlass);
  const update = (next: number) => {
    if (!interactionGate.allowed()) return;
    localStorage.setItem(GLASS_KEY, String(next));
    applyStoredGlass();
    setValue(next);
  };
  return (
    <div className="glass-settings">
      <label htmlFor="glass-transparency">
        背景透明度 <strong>{value}%</strong>
      </label>
      <input
        id="glass-transparency"
        type="range"
        min="0"
        max="70"
        step="1"
        value={value}
        onChange={(event) => update(Number(event.target.value))}
      />
      <div>
        <span>清晰</span>
        <button onClick={() => update(5)}>恢复默认</button>
        <span>通透</span>
      </div>
    </div>
  );
}
