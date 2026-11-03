import React from "react";
export const GLASS_KEY = "ui-glass-transparency";
/**
 * 应用已保存的透明度。
 *
 * 存储被清空时（例如「退出并忘记账户」清理了 WebView 数据）回退到默认值，
 * 并**立即写回**，避免清理后偏好被静默重置、用户以为设置丢了。
 */
export function applyStoredGlass() {
  const raw = localStorage.getItem(GLASS_KEY);
  const parsed = raw == null ? NaN : Number(raw);
  const transparency = Number.isFinite(parsed)
    ? Math.max(0, Math.min(70, parsed))
    : 5;
  if (raw == null || !Number.isFinite(parsed)) {
    localStorage.setItem(GLASS_KEY, String(transparency));
  }
  document.documentElement.style.setProperty(
    "--glass-alpha",
    String(1 - transparency / 100),
  );
  return transparency;
}
export function GlassSettings() {
  const [value, setValue] = React.useState(applyStoredGlass);
  const update = (next: number) => {
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
