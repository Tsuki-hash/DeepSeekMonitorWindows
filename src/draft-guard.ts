// 未保存草稿的离开保护。
//
// 凭据与提醒设置有 dirty 状态和显式保存，但 App 切页会直接卸载组件，
// 未保存的草稿被丢弃，用户容易误以为「刚才改好了」。
//
// 这里提供两个纯函数：
// - `draftGuardText` 生成统一的提示文案；
// - `shouldBlockLeave` 决定是否需要在离开前询问。
// 组件负责渲染保存/放弃/取消三个动作，不把 Token 之类敏感草稿写进浏览器存储。

export type DraftGuardDecision = "save" | "discard" | "cancel";

/** 统一的离开提示：明确说清「改了但没保存」。 */
export function draftGuardText(subject: string): string {
  return `${subject}有尚未保存的修改。离开将丢弃这些修改。`;
}

/**
 * 是否需要拦截离开。
 *
 * `dirty` 为 false 时不拦截；即使有错误提示也不拦截 —— 用户可能只是想离开
 * 去看错误原因，强制留在原地反而更难恢复。
 */
export function shouldBlockLeave(dirty: boolean): boolean {
  return dirty === true;
}

/** 三个动作的标签：与提示文案保持一致，避免各页面各写一套。 */
export const draftGuardActions: Record<DraftGuardDecision, string> = {
  save: "保存并离开",
  discard: "放弃修改并离开",
  cancel: "留在此页",
};
