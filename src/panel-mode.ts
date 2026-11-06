// 面板尺寸模式（紧凑 / 展开）。
//
// 固定 356×600 适合托盘速览，历史明细需要更宽的阅读区。
// 模式完全由当前视图推导，没有手动切换状态。
//
// 注意：模式是**进程内**状态，不写 localStorage —— 它只影响当前会话的窗口尺寸，
// 重启后回到紧凑（与「打开就看一眼」的默认行为一致）。

export type PanelMode = "compact" | "expanded";

/** 历史明细默认建议展开阅读模式。 */
export const expandedViews = new Set(["history"]);

/** 给定当前视图，建议的模式。 */
export function suggestedMode(view: string): PanelMode {
  return expandedViews.has(view) ? "expanded" : "compact";
}
