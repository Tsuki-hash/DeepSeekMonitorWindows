import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { BalanceCard } from "../src/components/BalanceCard";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { UsageRow } from "../src/components/UsageRow";
import { UsageChart } from "../src/components/UsageChart";
import type { RawModelUsage, UsageModel, UsageResult } from "../src/types";
import type { UsageDay } from "../src/format";

// Synthetic rendering only. No platform requests, stored credentials, app launch,
// native layout assertions, or Windows notification delivery are performed here.
const g = globalThis as any;
const NativeDate = Date;
const NOW = NativeDate.parse("2026-11-09T16:00:00Z");
let fixtureNow = NOW;
g.Date = class extends NativeDate {
  constructor(value?: any) {
    super(value === undefined ? fixtureNow : value);
  }
  static now() {
    return fixtureNow;
  }
};
g.IS_REACT_ACT_ENVIRONMENT = true;
g.__settingsListeners = new Map();
g.__settingsIpc = async (command: string) => {
  throw new Error(`Unexpected IPC in usage rendering fixture: ${command}`);
};
const noop = () => {};
const storage = new Map<string, string>();
g.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
g.document = {
  documentElement: { setAttribute: noop },
  addEventListener: noop,
  removeEventListener: noop,
  visibilityState: "visible",
};
g.window = {
  setTimeout: () => 1,
  clearTimeout: noop,
  setInterval: () => 1,
  clearInterval: noop,
  addEventListener: noop,
  removeEventListener: noop,
};

const model = (over: Partial<UsageModel> = {}): UsageModel => ({
  key: "flash",
  name: "V4.1 Flash",
  requestCount: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: 0,
  otherTokens: 0,
  cost: 0,
  ...over,
});
const raw = (over: Partial<RawModelUsage> = {}): RawModelUsage => ({
  model: "deepseek-flash",
  groupKey: "flash",
  requestCount: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: 0,
  otherTokens: 0,
  cost: 0,
  ...over,
});
const day = (date: string, over: Partial<UsageDay> = {}): UsageDay => ({
  date,
  rawModels: [raw()],
  flashTokens: 0,
  flashCacheHit: 0,
  flashCacheMiss: 0,
  flashResponse: 0,
  proTokens: 0,
  proCacheHit: 0,
  proCacheMiss: 0,
  proResponse: 0,
  flashOtherTokens: 0,
  proOtherTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  ...over,
});
const usage = (over: Partial<UsageResult> = {}): UsageResult => ({
  accountingDate: "2026-11-10",
  warnings: [],
  unavailableDates: [],
  models: [model()],
  rawModels: [raw()],
  monthCost: 120,
  days: Array.from({ length: 10 }, (_, i) =>
    day(`2026-11-${String(i + 1).padStart(2, "0")}`),
  ),
  ...over,
});
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
const chartBar = (view: any, date: string) =>
  view.root
    .findAllByType("button")
    .find((node: any) => node.props["aria-label"]?.startsWith(`${date}：`));
async function render(
  element: React.ReactElement,
  inspect: (view: any) => void | Promise<void>,
) {
  let view: any;
  await act(async () => {
    view = Renderer.create(element);
  });
  try {
    await inspect(view);
  } finally {
    await act(async () => view.unmount());
  }
}
const dashboard = (data: UsageResult, onDetail = noop) => (
  <DashboardPanel
    usage={data}
    usageState="ok"
    usageError=""
    balance={{
      isAvailable: true,
      currency: "USD",
      totalBalance: "20",
      grantedBalance: "0",
      toppedUpBalance: "20",
    }}
    balanceState="ok"
    balanceError=""
    onRefresh={noop}
    onClose={noop}
    onSettings={noop}
    onDetail={onDetail}
    onHistory={noop}
  />
);
const detail = (
  data: UsageResult,
  key: "flash" | "pro" | "other" = "flash",
) => (
  <ModelDetailPanel
    model={key}
    usage={data}
    usageState="ok"
    usageError=""
    onBack={noop}
  />
);

test("R14-06: 同时缺今天或昨日时首页和详情不显示实测零及完整七日总量", async () => {
  for (const missing of ["2026-11-10", "2026-11-09"]) {
    const data = usage();
    data.days = data.days.filter((item) => item.date !== missing);
    for (const element of [dashboard(data), detail(data)]) {
      await render(element, async (view) => {
        const bar = view.root
          .findAllByType("button")
          .find((node: any) =>
            node.props["aria-label"]?.startsWith(`${missing}：`),
          );
        assert.ok(bar);
        assert.match(bar.props["aria-label"], /数据暂未取得，不代表用量为零/);
        assert.doesNotMatch(bar.props["aria-label"], /合计 0 tokens/);
        await act(async () => bar.props.onClick());
        assert.ok(text(view.toJSON()).includes("尚未取得数据，不代表用量为零"));
        const totals = view.root.findAllByProps({ className: "chart-total" });
        if (totals.length) assert.equal(text(totals[0]), "数据待核对 ›");
      });
    }
    await render(dashboard(data), (view) => {
      assert.ok(
        text(view.root.findByProps({ className: "source-trust" })).includes(
          "部分",
        ),
      );
      const balance = view.root.findByType(BalanceCard);
      assert.equal(
        balance.props.todayCost,
        missing === "2026-11-10" ? null : 0,
      );
      assert.equal(balance.props.monthCost, 120, "有效月费用不被缺日清掉");
      assert.equal(balance.props.balance.currency, "USD", "余额币种口径不变");
    });
  }
});

test("R14-06: 明确零日可为零，空data与快照未来零不能升格为已取得", async () => {
  await render(dashboard(usage()), (view) => {
    const bar = view.root
      .findAllByType("button")
      .find((node: any) =>
        node.props["aria-label"]?.startsWith("2026-11-10："),
      );
    assert.match(bar.props["aria-label"], /合计 0 tokens/);
    assert.equal(view.root.findByType(BalanceCard).props.todayCost, 0);
    assert.ok(
      text(view.root.findByProps({ className: "source-trust" })).includes(
        "完整",
      ),
    );
    assert.ok(
      text(view.root.findByProps({ className: "chart-total" })).startsWith(
        "0 ·",
      ),
    );
  });
  for (const data of [
    usage({ days: [day("2026-11-10", { rawModels: [] })] }),
    usage({ accountingDate: "2026-11-09" }),
  ]) {
    await render(dashboard(data), (view) => {
      assert.equal(view.root.findByType(BalanceCard).props.todayCost, null);
      const bar = view.root
        .findAllByType("button")
        .find((node: any) =>
          node.props["aria-label"]?.startsWith("2026-11-10："),
        );
      assert.match(bar.props["aria-label"], /数据暂未取得/);
    });
  }
});

test("R14-08: 请求缺失、显式0、2在详情中分别显示未知与真实值", async () => {
  for (const [requestCount, expected] of [
    [null, "—"],
    [0, "0"],
    [2, "2"],
  ] as const) {
    await render(
      detail(
        usage({
          models: [
            model({ requestCount, responseTokens: 100, totalTokens: 100 }),
          ],
        }),
      ),
      (view) => {
        const metric = view.root
          .findAllByType("article")
          .find(
            (node: any) =>
              node.props.className === "card metric-card" &&
              text(node).startsWith("本月请求次数"),
          );
        assert.ok(metric);
        assert.equal(text(metric.findByType("strong")), expected);
      },
    );
  }
});

test("R14-08: HIT已知而MISS缺失不推导100%命中率，MISS明确0才允许", async () => {
  for (const cacheMissTokens of [null, 0]) {
    await render(
      <UsageRow
        modelKey="flash"
        data={model({ cacheHitTokens: 100, cacheMissTokens, totalTokens: 100 })}
        maxTokens={100}
        state="ok"
        onClick={noop}
      />,
      (view) => {
        const rates = view.root.findAll(
          (node: any) =>
            typeof node.props.className === "string" &&
            node.props.className.startsWith("cache-hit-rate"),
        );
        assert.equal(rates.length, cacheMissTokens == null ? 0 : 1);
        if (rates.length) assert.equal(text(rates[0]), "缓存命中 100%");
      },
    );
  }
  const data = usage();
  data.days = data.days.map((item) =>
    day(item.date, {
      flashTokens: 100,
      flashCacheHit: 100,
      flashCacheMiss: null,
      totalTokens: 100,
      rawModels: [
        raw({ totalTokens: 100, cacheHitTokens: 100, cacheMissTokens: null }),
      ],
    }),
  );
  await render(<UsageChart usage={data} state="ok" error="" />, (view) => {
    assert.ok(view.root.findByProps({ title: "输入缓存命中率未取得" }));
    assert.equal(
      text(view.root.findByProps({ className: "chart-total" })),
      "数据待核对 ›",
    );
  });
});

test("R14-09: other的非零请求、未知字段和全零样本均保留可点击详情入口", async () => {
  for (const fields of [
    { requestCount: 2, totalTokens: 0, cost: 0 },
    { requestCount: 2, totalTokens: null, cost: 0 },
    { requestCount: null, totalTokens: null, cost: null },
    { requestCount: 0, totalTokens: 0, cost: 0 },
  ]) {
    const other = model({ key: "other", name: "其他", ...fields });
    const data = usage({
      models: [other],
      rawModels: [raw({ model: "future-model", groupKey: null, ...fields })],
    });
    let opened: string | null = null;
    await render(
      dashboard(data, (key: string) => {
        opened = key;
      }),
      async (view) => {
        const row = view.root
          .findAllByType(UsageRow)
          .find((node: any) => node.props.modelKey === "other");
        assert.ok(row, "平台返回的未知模型不能丢掉入口");
        await act(async () => row.findByType("button").props.onClick());
        assert.equal(opened, "other");
      },
    );
    await render(detail(data, "other"), (view) => {
      const metric = view.root
        .findAllByType("article")
        .find(
          (node: any) =>
            node.props.className === "card metric-card" &&
            text(node).startsWith("本月请求次数"),
        );
      assert.equal(
        text(metric.findByType("strong")),
        fields.requestCount == null ? "—" : String(fields.requestCount),
      );
    });
    assert.equal(
      data.rawModels![0].model,
      "future-model",
      "原始模型名不可丢失",
    );
  }
});

test("R25: 月初两月各自安全但七日和超界，首页保留单日与0，不显示确定总量或完整", async () => {
  fixtureNow = NativeDate.parse("2026-11-02T02:00:00Z");
  try {
    for (const currentCount of [2 ** 52 - 1, 2 ** 52 + 1]) {
      const safe = currentCount === 2 ** 52 - 1;
      const countDay = (date: string, tokens: number) =>
        day(date, {
          flashTokens: tokens,
          flashCacheHit: tokens,
          totalTokens: tokens,
          rawModels: [raw({ totalTokens: tokens, cacheHitTokens: tokens })],
        });
      const data = usage({
        accountingDate: "2026-11-02",
        monthCost: 0,
        models: [
          model({ totalTokens: currentCount, cacheHitTokens: currentCount }),
        ],
        rawModels: [
          raw({ totalTokens: currentCount, cacheHitTokens: currentCount }),
        ],
        days: [
          ...[27, 28, 29, 30].map((date) => countDay(`2026-10-${date}`, 0)),
          countDay("2026-10-31", 2 ** 52),
          countDay("2026-11-01", currentCount),
          countDay("2026-11-02", 0),
        ],
      });
      const before = JSON.stringify(data);
      await render(dashboard(data), async (view) => {
        const header = text(
          view.root.findByProps({ className: "chart-total" }),
        );
        const trust = text(
          view.root.findByProps({ className: "source-trust" }),
        );
        assert.ok(trust.includes(safe ? "完整" : "部分"));
        if (safe) assert.notEqual(header, "数据待核对 ›");
        else {
          assert.equal(header, "数据待核对 ›");
          assert.ok(
            text(view.toJSON()).includes(
              "近7日 Token 计数或合计超出安全整数范围",
            ),
          );
          assert.ok(view.root.findByProps({ title: "输入缓存命中率未取得" }));
          assert.doesNotMatch(trust, /完整/);
        }
        for (const [date, tokens] of [
          ["2026-10-31", 2 ** 52],
          ["2026-11-01", currentCount],
          ["2026-11-02", 0],
        ] as const) {
          const bar = chartBar(view, date);
          assert.ok(
            bar.props["aria-label"].includes(
              `合计 ${tokens.toLocaleString("en-US")} tokens`,
            ),
          );
          assert.doesNotMatch(bar.props["aria-label"], /数据暂未取得/);
          await act(async () => bar.props.onClick());
          assert.equal(bar.props["aria-pressed"], true);
          assert.equal(
            view.root.findByProps({ className: "chart-inspector" }).props[
              "aria-live"
            ],
            "polite",
          );
        }
      });
      assert.equal(JSON.stringify(data), before);
    }
  } finally {
    fixtureNow = NOW;
  }
});

test("R25: 两个Flash别名的分段和超界，首页/详情显示原因与已知分段，Pro仍有效", async () => {
  const hit = 2 ** 52;
  const miss = 2 ** 52 + 1;
  const data = usage({
    models: [
      model({ totalTokens: null, cacheHitTokens: hit, cacheMissTokens: miss }),
      model({ key: "pro", name: "V4 Pro", totalTokens: 7, responseTokens: 7 }),
    ],
  });
  data.days[9] = day("2026-11-10", {
    flashTokens: null,
    flashCacheHit: hit,
    flashCacheMiss: miss,
    proTokens: 7,
    proResponse: 7,
    totalTokens: null,
    rawModels: [
      raw({
        model: "deepseek-v4-flash",
        totalTokens: hit,
        cacheHitTokens: hit,
      }),
      raw({
        model: "deepseek-flash",
        totalTokens: miss,
        cacheMissTokens: miss,
      }),
      raw({
        model: "deepseek-pro",
        groupKey: "pro",
        totalTokens: 7,
        responseTokens: 7,
      }),
    ],
  });
  data.rawModels = data.days[9].rawModels;
  const before = JSON.stringify(data);
  for (const element of [dashboard(data), detail(data)]) {
    await render(element, async (view) => {
      const bar = chartBar(view, "2026-11-10");
      assert.match(bar.props["aria-label"], /超出安全整数范围，合计未知/);
      assert.doesNotMatch(
        bar.props["aria-label"],
        /数据暂未取得|合计 9,007,199,254,740,992/,
      );
      assert.ok(
        bar.props["aria-label"].includes(`命中 ${hit.toLocaleString("en-US")}`),
      );
      assert.ok(
        bar.props["aria-label"].includes(
          `未命中 ${miss.toLocaleString("en-US")}`,
        ),
      );
      await act(async () => bar.props.onClick());
      const inspector = view.root.findByProps({ className: "chart-inspector" });
      assert.equal(inspector.props["data-count-issue"], true);
      assert.ok(text(inspector).includes("合计未知"));
      assert.ok(text(inspector).includes("已知分段保留"));
      assert.ok(
        inspector.findByProps({
          title: `命中：${hit.toLocaleString("en-US")} Tokens`,
        }),
      );
      assert.ok(
        inspector.findByProps({
          title: `未命中：${miss.toLocaleString("en-US")} Tokens`,
        }),
      );
      assert.doesNotMatch(text(inspector), /尚未取得数据，不代表用量为零/);
      assert.equal(inspector.props["aria-live"], "polite");
    });
  }
  await render(detail(data, "pro"), (view) => {
    const bar = chartBar(view, "2026-11-10");
    assert.match(bar.props["aria-label"], /合计 7 tokens/);
    assert.doesNotMatch(bar.props["aria-label"], /未知|超出安全整数/);
  });
  assert.equal(JSON.stringify(data), before, "前端状态不改写原始别名和计数");
});

test("R25: 已返回但其他分段未知，详情保留其他—而不是省略该字段", async () => {
  const data = usage();
  data.days[9] = day("2026-11-10", {
    totalTokens: null,
    rawModels: [
      raw({ model: "future-model", groupKey: null, totalTokens: null }),
    ],
  });
  await render(detail(data, "other"), async (view) => {
    const bar = chartBar(view, "2026-11-10");
    assert.match(bar.props["aria-label"], /其他 未知/);
    await act(async () => bar.props.onClick());
    const unknown = view.root.findByProps({ title: "其他：未知" });
    assert.equal(text(unknown), "其他 —");
  });
});
