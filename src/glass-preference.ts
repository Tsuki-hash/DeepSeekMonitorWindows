// 背景透明度的偏好换算。
//
// 复评 F21：清登录数据会清掉 localStorage，「忘记账户」不应连带重置外观。
// 这里把纯计算抽出来，便于测试；DOM 读写留在 GlassSettings。

export const DEFAULT_GLASS = 5;
export const MIN_GLASS = 0;
export const MAX_GLASS = 70;

export const clampGlass = (value: number) =>
  Math.max(MIN_GLASS, Math.min(MAX_GLASS, value));

/** 透明度百分比 → CSS `--glass-alpha`。 */
export const alphaFromTransparency = (transparency: number) =>
  1 - clampGlass(transparency) / 100;

/** CSS `--glass-alpha` → 透明度百分比；无效值返回 null。 */
export function transparencyFromAlpha(alpha: string): number | null {
  const text = alpha.trim();
  if (!text) return null;
  const parsed = Number(text);
  // 越界值视为无效：clamp 会把 1.5 当成 1，反而制造出一个「合法」的错值。
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return clampGlass(Math.round((1 - parsed) * 100));
}

/**
 * 决定清理后应该用哪个透明度。
 *
 * 优先级：已存偏好 → 当前生效值 → 默认值。
 * 存储被清空时**不能**直接回落默认值，否则用户的自定义外观会消失。
 */
export function resolveTransparency(
  stored: string | null,
  effective: number | null,
): number {
  if (stored != null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return clampGlass(parsed);
  }
  if (effective != null && Number.isFinite(effective)) {
    return clampGlass(effective);
  }
  return DEFAULT_GLASS;
}
