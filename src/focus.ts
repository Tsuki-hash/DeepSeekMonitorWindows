// 视图切换时的焦点管理。
//
// 评审 P2：模型详情、历史、设置切换后没有把焦点移到新页面标题，返回时也没有
// 把焦点还给触发控件，纯键盘用户会「丢失」当前位置。
//
// 这里是一个极小的 hook：进入视图时聚焦标题容器，返回时恢复之前记录的触发控件。

import React from "react";

/** 记录触发控件，并在卸载时把焦点还回去。 */
export function useReturnFocus<T extends HTMLElement = HTMLElement>() {
  const previous = React.useRef<T | null>(null);
  const capture = React.useCallback((node: T | null) => {
    if (node) previous.current = node;
  }, []);
  const restore = React.useCallback(() => {
    const node = previous.current;
    previous.current = null;
    // 控件可能已被卸载：`isConnected` 为 false 时静默跳过，不抛错。
    if (node && node.isConnected) node.focus();
  }, []);
  return { capture, restore };
}

/**
 * 视图标题容器：切换后把焦点移到这里。
 *
 * 用 `tabIndex={-1}` 而不是 `0`：它能被程序聚焦，但不会进入 Tab 序列，
 * 避免用户按 Tab 时先落在标题上。
 */
export function focusHeading(node: HTMLElement | null) {
  node?.focus();
}
