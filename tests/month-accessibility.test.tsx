import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UsageRow } from "../src/components/UsageRow";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { StackedBarChart } from "../src/components/StackedBarChart";
import { historyCache } from "../src/history-cache";
import type {
  LoadState,
  ModelName,
  RawModelUsage,
  UsageModel,
  UsageResult,
} from "../src/types";

// Synthetic component/ARIA/source contracts only. Calling onClick below does
// not test native Enter/Space, DOM focus, layout, WebView2, NVDA or Narrator.
// No application launch, platform request or real credential is used.
const g = globalThis as any;
const NativeDate = Date;
const NOW = NativeDate.parse("2026-11-10T04:00:00Z");
g.Date = class extends NativeDate {
  constructor(value?: any) {
    super(value === undefined ? NOW : value);
  }
  static now() {
    return NOW;
  }
};
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
g.window = {
  setTimeout: () => 1,
  clearTimeout: noop,
  setInterval: () => 1,
  clearInterval: noop,
};
g.document = {
  visibilityState: "visible",
  addEventListener: noop,
  removeEventListener: noop,
};
g.__settingsListeners = new Map();
let calls = 0;
let load: () => Promise<UsageResult> = async () => {
  throw new Error("Unexpected IPC outside history fixture");
};
g.__settingsIpc = async (command: string, args: unknown) => {
  assert.equal(command, "fetch_usage");
  assert.deepEqual(args, { month: 11, year: 2026 });
  calls++;
  return load();
};

const names = { flash: "V4.1 Flash", pro: "V4 Pro", other: "其他" };
const model = (key: ModelName, totalTokens: number | null): UsageModel => ({
  key,
  name: names[key],
  totalTokens,
  requestCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: totalTokens,
  otherTokens: 0,
  cost: 1.25,
});
const raw = (name: string, totalTokens: number | null): RawModelUsage => ({
  model: name,
  groupKey: "flash",
  totalTokens,
  requestCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: totalTokens,
  otherTokens: 0,
  cost: 1.25,
});
const usage = (key: ModelName, totalTokens: number | null): UsageResult => ({
  schemaVersion: 2,
  accountingDate: "2026-11-10",
  models: [model(key, totalTokens)],
  rawModels: [raw("platform-model", totalTokens)],
  monthCost: 1.25,
  warnings: [],
  unavailableDates: [],
  // Seven small, known days deliberately disagree with the monthly source.
  days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-11-${String(i + 4).padStart(2, "0")}`,
    rawModels: [raw("platform-model", 10)],
    flashTokens: 10,
    flashCacheHit: 0,
    flashCacheMiss: 0,
    flashResponse: 10,
    flashOtherTokens: 0,
    proTokens: 0,
    proCacheHit: 0,
    proCacheMiss: 0,
    proResponse: 0,
    proOtherTokens: 0,
    totalTokens: 10,
    totalCost: 1.25,
  })),
});
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
const visibleText = (node: any): string =>
  typeof node === "string"
    ? node
    : node?.props?.hidden
      ? ""
      : (node?.children?.map(visibleText).join("") ?? "");
const description = (view: any, node: any): string =>
  node.props["aria-describedby"]
    .split(" ")
    .map((id: string) => text(view.root.findByProps({ id })))
    .join(" ");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
async function render(
  element: React.ReactElement,
  concurrent: boolean,
  inspect: (view: any) => void | Promise<void>,
) {
  let view: any;
  await act(async () => {
    view = Renderer.create(<React.StrictMode>{element}</React.StrictMode>, {
      unstable_isConcurrent: concurrent,
    } as any);
    await flush();
  });
  try {
    await inspect(view);
  } finally {
    await act(async () => view.unmount());
  }
}

function MonthRoute({
  data,
  modelKey,
}: {
  data: UsageResult;
  modelKey: ModelName;
}) {
  const [open, setOpen] = React.useState(false);
  return open ? (
    <ModelDetailPanel
      model={modelKey}
      usage={data}
      usageState="ok"
      usageError=""
      onBack={() => setOpen(false)}
    />
  ) : (
    <UsageRow
      modelKey={modelKey}
      data={data.models[0]}
      maxTokens={Number.MAX_SAFE_INTEGER}
      state="ok"
      onClick={() => setOpen(true)}
    />
  );
}

for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  test(`R27 month (${mode}): native row opens same-source exact month value for every slot`, async () => {
    for (const key of ["flash", "pro", "other"] as const) {
      for (const value of [0, 123_456_789, Number.MAX_SAFE_INTEGER]) {
        const data = usage(key, value);
        const before = JSON.stringify(data);
        const exact = value.toLocaleString("en-US");
        await render(
          <MonthRoute data={data} modelKey={key} />,
          concurrent,
          async (view) => {
            const row = view.root.findByType("button");
            assert.equal(row.props.type, "button");
            assert.notEqual(row.props.disabled, true);
            assert.notEqual(row.props.tabIndex, -1);
            assert.equal(
              row.props.onKeyDown,
              undefined,
              "native activation is not replaced",
            );
            assert.equal(
              row.findAllByType("button").length,
              1,
              "no nested button",
            );
            assert.ok(
              description(view, row).includes(`平台本月 Tokens：${exact}`),
            );
            assert.ok(description(view, row).includes("打开详情查看完整月值"));
            assert.ok(description(view, row).includes("不是近 7 日合计"));
            assert.ok(
              visibleText(row).includes("¥1.25"),
              "monthly cost is unchanged",
            );

            await act(async () => row.props.onClick());
            const metric = view.root.findByProps({
              "data-testid": "month-token-metric",
            });
            assert.equal(metric.props.role, "group");
            assert.equal(metric.props.tabIndex, 0);
            assert.equal(
              metric.props["aria-label"],
              `${names[key]}，平台本月 Tokens 完整数值`,
            );
            const valueNode = metric.findByType("strong");
            assert.equal(visibleText(valueNode), exact);
            assert.equal(
              valueNode.props.title,
              undefined,
              "exact value is visible, not a tooltip",
            );
            assert.ok(description(view, metric).startsWith(exact));
            assert.ok(description(view, metric).includes("非近 7 日合计"));
            const points = view.root.findByType(StackedBarChart).props.points;
            assert.equal(points.length, 7);
            assert.ok(
              points.every(
                (point: any) => point.total === (key === "flash" ? 10 : 0),
              ),
            );

            await act(async () =>
              view.root
                .findByProps({ "aria-label": "返回主面板" })
                .props.onClick(),
            );
            assert.ok(
              description(view, view.root.findByType("button")).includes(exact),
            );
            assert.equal(
              JSON.stringify(data),
              before,
              "rendering cannot rewrite source counts",
            );
          },
        );
      }
    }
  });

  test(`R27 month (${mode}): missing and unsafe source totals stay unknown, never daily sums`, async () => {
    for (const value of [
      null,
      undefined,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
    ]) {
      const data = usage("flash", value as number | null);
      await render(
        <MonthRoute data={data} modelKey="flash" />,
        concurrent,
        async (view) => {
          const row = view.root.findByType("button");
          assert.ok(visibleText(row).includes("Tokens 未知"));
          assert.ok(description(view, row).includes("平台本月 Tokens：未知"));
          assert.doesNotMatch(description(view, row), /NaN|Infinity|：0[。 ]/);
          await act(async () => row.props.onClick());
          const metric = view.root.findByProps({
            "data-testid": "month-token-metric",
          });
          assert.equal(visibleText(metric.findByType("strong")), "未知");
          assert.ok(description(view, metric).startsWith("未知"));
          assert.ok(
            text(
              view.root.findByProps({ className: "card detail-hero" }),
            ).includes("¥1.25"),
          );
          assert.equal(data.models[0].totalTokens, value);
        },
      );
    }
  });

  test(`R27 month (${mode}): refresh updates descriptions without replacing keyboard targets`, async () => {
    const element = (value: number | null) => (
      <UsageRow
        modelKey="flash"
        data={model("flash", value)}
        maxTokens={1e9}
        state="ok"
        onClick={noop}
      />
    );
    await render(element(123_456_789), concurrent, async (view) => {
      const row = view.root.findByType("button");
      const id = row.props["aria-describedby"];
      for (const value of [234_567_890, null, 0]) {
        await act(async () =>
          view.update(<React.StrictMode>{element(value)}</React.StrictMode>),
        );
        assert.equal(view.root.findByType("button"), row);
        assert.equal(row.props["aria-describedby"], id);
        const expected = value == null ? "未知" : value.toLocaleString("en-US");
        assert.ok(
          description(view, row).includes(`平台本月 Tokens：${expected}`),
        );
      }
    });
    const detail = (value: number | null) => (
      <ModelDetailPanel
        model="flash"
        usage={usage("flash", value)}
        usageState="ok"
        usageError=""
        onBack={noop}
      />
    );
    await render(detail(123_456_789), concurrent, async (view) => {
      const metric = view.root.findByProps({
        "data-testid": "month-token-metric",
      });
      const ids = metric.props["aria-describedby"];
      for (const value of [234_567_890, null, 0]) {
        await act(async () =>
          view.update(<React.StrictMode>{detail(value)}</React.StrictMode>),
        );
        assert.equal(
          view.root.findByProps({ "data-testid": "month-token-metric" }),
          metric,
        );
        assert.equal(metric.props["aria-describedby"], ids);
        const expected = value == null ? "未知" : value.toLocaleString("en-US");
        assert.equal(visibleText(metric.findByType("strong")), expected);
        assert.ok(description(view, metric).startsWith(expected));
      }
    });
  });

  test(`R27 month (${mode}): source-month table preserves full counts and independent daily totals`, async () => {
    const values = [
      123_456_789,
      Number.MAX_SAFE_INTEGER,
      0,
      null,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      0.5,
      NaN,
      Infinity,
    ];
    const data = usage("flash", 123_456_789);
    data.rawModels = values.map((value, index) =>
      raw(`source-${index}`, value),
    );
    data.days = [
      {
        ...data.days[0],
        date: "2026-11-10",
        rawModels: [raw("source-0", 7)],
      },
    ];
    calls = 0;
    load = async () => data;
    historyCache.invalidate();
    await render(<HistoryPanel onBack={noop} />, concurrent, async (view) => {
      assert.equal(calls, 1);
      const source = view.root.findByProps({
        className: "history-details history-source-months",
      });
      assert.equal(source.type, "details");
      const summary = source.findByType("summary");
      assert.equal(text(summary), "平台原始月汇总 · 独立来源口径");
      assert.equal(
        summary.props.onKeyDown,
        undefined,
        "native disclosure keeps keyboard behavior",
      );
      assert.equal(
        source.props.open,
        undefined,
        "source details remain collapsed by default",
      );
      assert.equal(
        source.props.onToggle,
        undefined,
        "opening exact values cannot trigger a request",
      );
      const table = source.findByType("table");
      assert.equal(
        text(table.findByType("caption")),
        "平台原始月汇总 · Tokens 为完整数值",
      );
      assert.ok(
        table
          .findAllByType("th")
          .every((node: any) => node.props.scope === "col"),
      );
      const rows = table.findByType("tbody").findAllByType("tr");
      assert.equal(rows.length, values.length);
      rows.forEach((row: any, index: number) => {
        const cell = row.findByProps({ className: "month-token-exact" });
        const value = values[index];
        const expected =
          value != null && Number.isSafeInteger(value) && value >= 0
            ? value.toLocaleString("en-US")
            : "未知";
        assert.equal(visibleText(cell), expected);
        assert.equal(
          cell.props["aria-label"],
          `2026-11，source-${index}，平台原始月 Tokens：${expected}`,
        );
        assert.equal(cell.props.title, undefined);
        assert.equal(text(row.findAllByType("td")[2]), "¥1.25");
      });
      const daily = view.root
        .findByProps({ className: "history-metrics" })
        .findAllByType("strong");
      assert.equal(
        text(daily[0]),
        "7",
        "source month is never substituted for returned daily records",
      );

      await act(async () =>
        view.root.findByProps({ "aria-label": "历史模型" }).props.onChange({
          target: { value: "source-4" },
        }),
      );
      assert.equal(source.findByType("tbody").findAllByType("tr").length, 1);
      assert.equal(
        visibleText(source.findByProps({ className: "month-token-exact" })),
        "未知",
      );
      assert.equal(
        calls,
        1,
        "reading or filtering source values makes no extra IPC calls",
      );
    });
    historyCache.invalidate();
  });
}

test("R27 month: initial load states retain their visible messages and unknown descriptions", async () => {
  for (const [state, expected] of [
    ["loading", "查询中…"],
    ["nokey", "未配置 Token"],
    ["error", "用量不可用"],
  ] as [LoadState, string][]) {
    await render(
      <UsageRow
        modelKey="flash"
        data={null}
        maxTokens={1}
        state={state}
        onClick={noop}
      />,
      false,
      (view) => {
        const row = view.root.findByType("button");
        assert.ok(visibleText(row).includes(expected));
        assert.ok(description(view, row).includes("平台本月 Tokens：未知"));
      },
    );
  }
});

test("R27 month: exact-value CSS wraps rather than ellipsizes and preserves visible focus", () => {
  const css = readFileSync("src/styles.css", "utf8");
  assert.match(
    css,
    /\.history-source-months \.month-token-exact\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    css,
    /\.detail-scroll \.metric-card strong\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    css,
    /\.detail-metrics \[role="group"\]:focus-visible\s*\{[^}]*outline-offset:\s*-2px;/s,
  );
});
