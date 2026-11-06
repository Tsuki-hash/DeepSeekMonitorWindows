import React from "react";
import { Brain, Shapes, Zap } from "lucide-react";
import { fmtInt, fmtMoney, fmtMoneyDisplay, fmtTokensShort } from "../format";
import { sumUsageCounts } from "../usage-counts";
import type { LoadState, ModelName, UsageModel } from "../types";

function UsageRow({
  modelKey,
  data,
  maxTokens,
  state,
  onClick,
}: {
  modelKey: ModelName;
  data: UsageModel | null;
  maxTokens: number;
  state: LoadState;
  onClick: () => void;
}) {
  const isFlash = modelKey === "flash";
  const isOther = modelKey === "other";
  const tint = isFlash ? "flash" : isOther ? "other" : "pro";
  // 显示名优先取后端 model_slot 的 name，避免前后端双源漂移
  const name =
    data?.name ?? (isFlash ? "V4.1 Flash" : isOther ? "其他" : "V4 Pro");
  // 这一行只有约 115px 给 token 数，千万级以上再写精确千分位会溢出成省略号，
  // 因此大数用紧凑写法，精确值仍可通过图表按钮的无障碍标签与明细标题查看。
  // totalTokens 为 null 表示平台没给或无法解析 —— 不能写成 0 Tokens。
  const totalTokens = data?.totalTokens ?? null;
  const tokensText =
    totalTokens == null
      ? data
        ? "Tokens 未知"
        : state === "loading"
          ? "查询中…"
          : state === "nokey"
            ? "未配置 Token"
            : state === "error"
              ? "用量不可用"
              : "—"
      : `${
          totalTokens < 1_000_000
            ? fmtInt(totalTokens)
            : fmtTokensShort(totalTokens)
        } Tokens`;
  const cost = data?.cost != null ? fmtMoneyDisplay(data.cost) : "—";
  const ratio =
    data?.cost != null && totalTokens != null && data.cost > 0
      ? `${fmtTokensShort(totalTokens / data.cost)} T/¥`
      : "—";
  const width =
    totalTokens == null
      ? "0%"
      : `${Math.max(2, (totalTokens / maxTokens) * 100)}%`;
  // 两个分量及其和都必须安全且已知；零分母没有可定义的命中率。
  const hit = data?.cacheHitTokens ?? null;
  const miss = data?.cacheMissTokens ?? null;
  const cacheInput = sumUsageCounts([hit, miss]).total;
  const hitRate = cacheInput != null && cacheInput > 0 ? cacheInput : null;

  return (
    <button className="card usage-row" onClick={onClick}>
      <div className={`model-badge ${tint}`}>
        {isFlash ? (
          <Zap size={27} fill="currentColor" />
        ) : isOther ? (
          <Shapes size={25} />
        ) : (
          <Brain size={25} />
        )}
      </div>
      <div className="usage-main">
        <h2>
          <span className="model-name" title={name}>
            {name}
          </span>
          <small className="model-period">本月</small>
        </h2>
        <div className="token-line">
          <span
            title={
              totalTokens != null ? `${fmtInt(totalTokens)} Tokens` : "未取得"
            }
          >
            {tokensText}
          </span>
          <div className="progress-track">
            <i
              className={
                isFlash ? "flash-fill" : isOther ? "other-fill" : "pro-fill"
              }
              style={{ width }}
            />
          </div>
        </div>
        {hitRate != null && (
          <span
            className={`cache-hit-rate ${tint}`}
            title="缓存命中输入 /（缓存命中输入 + 未命中输入），不含输出与未知输入"
          >
            缓存命中 {((hit! / hitRate) * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="usage-price">
        <strong title={data?.cost != null ? fmtMoney(data.cost) : undefined}>
          {cost}
        </strong>
        <span title="本月 Token 总数 / 本月人民币费用">{ratio}</span>
      </div>
    </button>
  );
}
export { UsageRow };
