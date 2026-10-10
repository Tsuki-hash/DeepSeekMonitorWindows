import React from "react";
export const GLASS_KEY = "ui-glass-transparency";
export function applyStoredGlass() {
  const raw = localStorage.getItem(GLASS_KEY);
  const value = raw == null ? 5 : Number(raw);
  const transparency = Number.isFinite(value)
    ? Math.max(0, Math.min(70, value))
    : 5;
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
