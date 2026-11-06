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
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const isFlash = modelKey === "flash";
  const isOther = modelKey === "other";
  const tint = isFlash ? "flash" : isOther ? "other" : "pro";
  // 显示名优先取后端 model_slot 的 name，避免前后端双源漂移
  const name =
    data?.name ?? (isFlash ? "V4.1 Flash" : isOther ? "其他" : "V4 Pro");
  const monthDescriptionId = React.useId();
  // 这一行只有约 115px 给 token 数，千万级以上再写精确千分位会溢出成省略号，
  // 因此大数用紧凑写法。整行原生按钮可用 Enter/Space 打开常显完整月值的详情；
  // 同源月值也作为按钮描述提供给读屏，不借用近 7 日图表的合计。
  // 缺项或不安全计数都是未知，不能把溢出/小数格式化成貌似精确的整数。
  const totalTokens = sumUsageCounts([data?.totalTokens]).total;
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
    <button
      type="button"
      className="card usage-row"
      data-usage-model={modelKey}
      onClick={onClick}
      aria-describedby={monthDescriptionId}
    >
      <span id={monthDescriptionId} hidden>
        {`${name}，平台本月 Tokens：${totalTokens == null ? "未知" : fmtInt(totalTokens)}。打开详情查看完整月值；此数值不是近 7 日合计。`}
      </span>
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
          <small className="model-period">本月 ›</small>
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
