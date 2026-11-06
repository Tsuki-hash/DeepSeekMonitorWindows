import React from "react";

/**
 * 数字旁边的「来源 · 期间 · 最后成功 · 完整性」四维摘要。
 *
 * 评审 P2：当前来源与可信状态散落在各处说明里，离用户最常看的数字太远。
 * 这里把它收敛成一个紧凑的、可读屏的行，放在数字正上方。
 */
export type SourceTrust = {
  /** 数据来源，例如「DeepSeek 平台用量」。 */
  source: string;
  /** 统计期间，例如「2026-11 · 北京时间」。 */
  period: string;
  /** 最后成功时间；null 表示尚未取得。 */
  lastSuccess: string | null;
  /** 完整性：完整 / 部分 / 未知。 */
  completeness: "complete" | "partial" | "unknown";
  /** 可选：账户是否已核对。 */
  accountVerified?: boolean;
  /** 可选：数据是否已失效（跨月、凭据撤销等）。 */
  stale?: boolean;
};

const completenessText = (value: SourceTrust["completeness"]) =>
  value === "complete" ? "完整" : value === "partial" ? "部分" : "未知";

export function SourceTrustLine({ trust }: { trust: SourceTrust }) {
  const parts = [
    trust.source,
    trust.period,
    `最后成功 ${trust.lastSuccess ?? "尚未取得"}`,
    completenessText(trust.completeness),
    ...(trust.accountVerified === false ? ["账户未核对"] : []),
    ...(trust.stale ? ["已失效，需刷新"] : []),
  ];
  return (
    <p className="source-trust" aria-label={parts.join(" · ")}>
      {parts.map((part, index) => (
        <React.Fragment key={part}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <span
            className={
              part === "账户未核对" || part === "已失效，需刷新"
                ? "source-trust-warn"
                : undefined
            }
          >
            {part}
          </span>
        </React.Fragment>
      ))}
    </p>
  );
}
