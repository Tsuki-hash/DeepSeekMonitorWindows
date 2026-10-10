import React from "react";
import { localEvidence, qualitySummary } from "../local-quality";
import type { LocalRow } from "../local-usage";
export function LocalRowQuality({ row }: { row: LocalRow }) {
  const evidence = localEvidence(row);
  const fields = {
    complete: "字段齐全",
    partial: "字段缺失",
    missing: "字段未取得",
    unverified: "字段待核对",
  };
  const timing = {
    matched: "耗时匹配",
    partial: "部分耗时",
    unavailable: "无可用耗时",
    unverified: "耗时未核对",
  };
  return (
    <p className="local-row-quality">
      {fields[evidence.tokenFields]} · 计数未标定 ·{" "}
      {timing[evidence.timingCoverage]}
    </p>
  );
}
export function LocalDataQuality({
  rows,
  partial,
  stale,
}: {
  rows: LocalRow[];
  partial: boolean;
  stale: boolean;
}) {
  const quality = qualitySummary(rows);
  return (
    <details className="history-details local-quality">
      <summary>{stale ? "上次数据质量" : "数据质量"}</summary>
      <p>
        当前视图 · {quality.rows}条会话/模型汇总{partial ? " · 来源不完整" : ""}
      </p>
      <div className="local-quality-counts">
        <div>
          <span>Token字段齐全</span>
          <strong>{quality.fields.complete}</strong>
        </div>
        <div>
          <span>字段缺失 / 待核对</span>
          <strong>
            {quality.fields.partial + quality.fields.missing} /{" "}
            {quality.fields.unverified}
          </strong>
        </div>
        <div>
          <span>耗时与汇总计数匹配</span>
          <strong>{quality.timing.matched}</strong>
        </div>
        <div>
          <span>耗时仅部分覆盖</span>
          <strong>{quality.timing.partial}</strong>
        </div>
        <div>
          <span>耗时未取得 / 未核对</span>
          <strong>
            {quality.timing.unavailable} / {quality.timing.unverified}
          </strong>
        </div>
      </div>
      <p className="local-quality-note">
        计数来源未标定：当前引擎不区分逐条实测与估算。字段齐全不代表实际计量；部分旧格式可能估算Token，不能当账单。
      </p>
      <p>
        耗时状态只核对汇总字段，不证明逐请求测速或工具版本覆盖。缺字段保持未知；未匹配耗时不计算速度。原工具日志、平台账单与实际调用可用于后续核对。
      </p>
    </details>
  );
}
