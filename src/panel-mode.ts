// 面板尺寸模式（紧凑 / 展开）。
//
// 固定 356×600 适合托盘速览，历史明细需要更宽的阅读区。
// 这里只保存用户的显式选择；默认紧凑，不会自行放大。
//
// 注意：模式是**进程内**状态，不写 localStorage —— 它只影响当前会话的窗口尺寸，
// 重启后回到紧凑（与「打开就看一眼」的默认行为一致）。

export type PanelMode = "compact" | "expanded";

export const panelModeLabel = (mode: PanelMode) =>
  mode === "expanded" ? "收起为紧凑面板" : "展开为阅读模式";

/** 历史明细默认建议展开阅读模式。 */
export const expandedViews = new Set(["history"]);

/** 给定当前视图，建议的模式；用户已手动选择时不覆盖。 */
export function suggestedMode(
  view: string,
  manual: PanelMode | null,
): PanelMode {
  if (manual) return manual;
  return expandedViews.has(view) ? "expanded" : "compact";
}
