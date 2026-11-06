import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { HistoryTrend } from "../src/components/HistoryTrend";
import { historyCache } from "../src/history-cache";
import type { RawModelUsage, UsageResult } from "../src/types";

// Synthetic component fixtures only. These tests do not launch the application,
// make platform requests or validate Windows tray/WebView delivery.
const g = globalThis as any;
const NativeDate = Date;
let now = NativeDate.parse("2026-10-31T15:59:00Z");
g.Date = class extends NativeDate {
  constructor(value?: any) {
    super(value === undefined ? now : value);
  }
  static now() {
    return now;
  }
};
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const intervals = new Map<number, () => void>();
const events = new Map<string, Set<() => void>>();
let nextTimer = 1;
g.window = {
  setInterval: (run: () => void) => {
    const id = nextTimer++;
    intervals.set(id, run);
    return id;
  },
  clearInterval: (id: number) => intervals.delete(id),
  setTimeout: () => nextTimer++,
  clearTimeout: noop,
};
g.document = {
  visibilityState: "visible",
  addEventListener: (name: string, run: () => void) => {
    const group = events.get(name) ?? new Set();
    group.add(run);
    events.set(name, group);
  },
  removeEventListener: (name: string, run: () => void) =>
    events.get(name)?.delete(run),
  createElement: () => ({ click: noop, remove: noop }),
  body: { appendChild: noop },
};
const blobs: Blob[] = [];
g.URL.createObjectURL = (blob: Blob) => {
  blobs.push(blob);
  return "blob:synthetic-history-export";
};
g.URL.revokeObjectURL = noop;
g.__settingsListeners = new Map();
let calls: string[] = [];
const raw = (
  model: string,
  tokens: number,
  cost: number | null,
): RawModelUsage => ({
  model,
  groupKey: null,
  totalTokens: tokens,
  cost,
  requestCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: tokens,
  otherTokens: 0,
});
const usage = (month: string, account = "A"): UsageResult => ({
  schemaVersion: 2,
  models: [],
  rawModels: [
    raw(`${account}-one`, 900, 90),
    raw(`${account}-two`, 800, 80),
    raw(`${account}-source-only`, 700, 70),
  ],
  days: [
    {
      date: `${month}-${month === "2026-10" ? "31" : "01"}`,
      rawModels: [raw(`${account}-one`, 10, 1), raw(`${account}-two`, 20, 2)],
    },
  ] as UsageResult["days"],
  monthCost: 240,
});
let load: (month: string) => Promise<UsageResult>;
g.__settingsIpc = async (
  command: string,
  args: { month: number; year: number },
) => {
  assert.equal(command, "fetch_usage");
  const month = `${args.year}-${String(args.month).padStart(2, "0")}`;
  calls.push(month);
  return load(month);
};
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
let view: any;
const button = (label: string) =>
  view.root
    .findAllByType("button")
    .find(
      (item: any) => text(item) === label || item.props["aria-label"] === label,
    );
const select = () => view.root.findByProps({ "aria-label": "历史模型" });
const trend = () =>
  view.root.findByType(HistoryTrend).props.days as {
    date: string;
    value: number | null;
  }[];
const metrics = () =>
  view.root
    .findByProps({ className: "history-metrics" })
    .findAllByType("strong")
    .map(text);
const flush = async () => {
  // Finite local promise chains for sequential synthetic month responses.
  for (let i = 0; i < 240; i++) await Promise.resolve();
};
const click = async (label: string) => {
  const target = button(label);
  assert.ok(target, `missing button: ${label}`);
  await act(async () => {
    target.props.onClick();
    await flush();
  });
  await act(flush);
};
const visibility = async (visible: boolean) => {
  await act(async () => {
    view.update(<HistoryPanel onBack={noop} windowVisible={visible} />);
    await flush();
  });
};
const tick = async (instant: string) => {
  now = NativeDate.parse(instant);
  await act(async () => {
    for (const run of intervals.values()) run();
    for (const run of events.get("visibilitychange") ?? []) run();
    await flush();
  });
};
const exportJson = async () => {
  await click("JSON");
  return JSON.parse(await blobs[blobs.length - 1].text());
};
async function fixture(concurrent: boolean, inspect: () => Promise<void>) {
  now = NativeDate.parse("2026-10-31T15:59:00Z");
  calls = [];
  blobs.length = 0;
  load = async (month) => usage(month);
  historyCache.invalidate();
  await act(async () => {
    view = Renderer.create(<HistoryPanel onBack={noop} windowVisible />, {
      unstable_isConcurrent: concurrent,
    } as any);
    await flush();
  });
  await act(flush);
  try {
    await inspect();
  } finally {
    await act(async () => {
      view.unmount();
      await flush();
    });
    assert.equal(intervals.size, 0);
    assert.equal(events.get("visibilitychange")?.size ?? 0, 0);
  }
}
for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  test(`R17 history (${mode}): hidden midnight preserves all loaded batches and model selection`, async () => {
    await fixture(concurrent, async () => {
      await click("全部");
      await click("继续加载更早月份 ›");
      await act(async () =>
        select().props.onChange({ target: { value: "A-one" } }),
      );
      const loaded = trend().filter((item) => item.value !== null);
      assert.equal(loaded.length, 24);
      const oldest = loaded[0].date;
      const previousCalls = calls.length;
      await visibility(false);
      await tick("2026-10-31T16:01:00Z");
      assert.equal(
        calls.length,
        previousCalls,
        "hidden clocks never call native IPC",
      );
      assert.deepEqual(
        trend().filter((item) => item.value !== null),
        loaded,
      );
      assert.equal(select().props.value, "A-one");
      assert.ok(text(view.toJSON()).includes("记账日期已变化"));
      await visibility(true);
      assert.deepEqual(
        calls.slice(previousCalls),
        ["2026-11", "2026-10"],
        "show catches up only the new and former open months",
      );
      assert.equal(select().props.value, "A-one");
      const refreshed = trend().filter((item) => item.value !== null);
      assert.equal(refreshed.length, 25);
      assert.equal(refreshed[0].date, oldest);
      assert.equal((await exportJson()).to, "2026-11-01");
      await click("重新查询历史");
      assert.equal(select().props.value, "A-one");
      assert.equal(trend().filter((item) => item.value !== null).length, 25);
      assert.ok(
        calls.slice(-25).includes(oldest.slice(0, 7)),
        "manual refresh includes older loaded months",
      );
    });
  });

  test(`R17 history (${mode}): an open panel date tick only marks the old window until explicit refresh`, async () => {
    await fixture(concurrent, async () => {
      const before = calls.length;
      await tick("2026-10-31T16:01:00Z");
      assert.equal(
        calls.length,
        before,
        "no implicit automatic polling, including auto-refresh off",
      );
      const old = await exportJson();
      assert.equal(old.to, "2026-10-31");
      assert.equal(old.stale, true);
      assert.deepEqual(metrics(), ["30", "¥3.00"]);
      await click("重新查询历史");
      const current = await exportJson();
      assert.equal(current.from, "2026-11-01");
      assert.equal(current.to, "2026-11-01");
      assert.equal(current.stale, false);
    });
  });

  test(`R17 history (${mode}): fixed historical months do not refetch or clear on date and visibility changes`, async () => {
    await fixture(concurrent, async () => {
      await click("历史月份");
      await act(async () => {
        view.root
          .findByProps({ type: "month" })
          .props.onChange({ target: { value: "2024-02" } });
        await flush();
      });
      await act(flush);
      await act(async () =>
        select().props.onChange({ target: { value: "A-one" } }),
      );
      const before = calls.length;
      await visibility(false);
      await tick("2026-11-01T16:01:00Z");
      await visibility(true);
      assert.equal(calls.length, before);
      assert.equal(select().props.value, "A-one");
      assert.equal(text(view.toJSON()).includes("记账日期已变化"), false);
      const json = await exportJson();
      assert.equal(json.from, "2024-02-01");
      assert.equal(json.to, "2024-02-29");
    });
  });

  test(`R17 history (${mode}): all range totals, month bars and exports use returned days, with raw source totals separate`, async () => {
    await fixture(concurrent, async () => {
      for (const label of ["本月", "上月", "近30天", "历史月份", "全部"]) {
        await click(label);
        const json = await exportJson();
        const tokens = json.daily.reduce(
          (total: number, row: RawModelUsage) => total + row.totalTokens!,
          0,
        );
        const costs = json.daily.reduce(
          (total: number, row: RawModelUsage) => total + row.cost!,
          0,
        );
        assert.deepEqual(metrics(), [String(tokens), `¥${costs.toFixed(2)}`]);
        assert.equal(
          json.monthly
            .flatMap((month: any) => month.models)
            .reduce(
              (total: number, model: RawModelUsage) =>
                total + model.totalTokens!,
              0,
            ),
          tokens,
        );
        assert.equal(
          trend().reduce((total, item) => total + (item.value ?? 0), 0),
          tokens,
        );
        assert.ok(
          json.sourceMonthlySnapshots.every(
            (month: any) => month.models[0].totalTokens === 900,
          ),
        );
        assert.ok(
          text(view.toJSON()).includes("平台原始月汇总 · 独立来源口径"),
        );
        assert.ok(json.missingDates.length > 0);
      }
      await act(async () =>
        select().props.onChange({ target: { value: "A-source-only" } }),
      );
      assert.deepEqual(metrics(), ["—", "—"]);
      assert.ok(trend().every((item) => item.value === null));
    });
  });

  test(`R17 history (${mode}): loading older after rollover leaves the unqueried new month unloaded`, async () => {
    await fixture(concurrent, async () => {
      await click("全部");
      await tick("2026-10-31T16:01:00Z");
      const before = calls.length;
      await click("继续加载更早月份 ›");
      assert.equal(calls.slice(before).includes("2026-11"), false);
      const json = await exportJson();
      assert.equal(json.to, "2026-11-01");
      assert.ok(json.unloadedMonths.includes("2026-11"));
      assert.equal(json.missingDates.includes("2026-11-01"), false);
      assert.equal(
        trend().find((item) => item.date === "2026-11-01")?.value,
        null,
      );
      assert.equal(trend().filter((item) => item.value != null).length, 24);
      // A newer hole must not leave an older-only button with empty targets.
      for (let batch = 0; batch < 8 && button("继续加载更早月份 ›"); batch++)
        await click("继续加载更早月份 ›");
      assert.equal(button("继续加载更早月份 ›"), undefined);
      assert.ok(button("补查未加载月份（1）"));
      const beforeCatchup = calls.length;
      await click("补查未加载月份（1）");
      assert.deepEqual(calls.slice(beforeCatchup), ["2026-11"]);
      assert.deepEqual((await exportJson()).unloadedMonths, []);
    });
  });

  test(`R17 history (${mode}): partial catchup preserves failed and unattempted new months`, async () => {
    await fixture(concurrent, async () => {
      load = async (month) => {
        if (month === "2026-08") throw new Error("synthetic month failure");
        return usage(month);
      };
      await click("全部");
      const first = await exportJson();
      assert.deepEqual(first.failedMonths, ["2026-08"]);
      await visibility(false);
      await tick("2027-01-01T16:01:00Z");
      load = async (month) => {
        if (month === "2026-12")
          throw { code: "rate_limited", message: "synthetic backoff" };
        return usage(month);
      };
      await visibility(true);
      const json = await exportJson();
      assert.deepEqual(json.failedMonths, ["2026-08", "2026-12"]);
      assert.ok(json.unloadedMonths.includes("2026-11"));
      assert.equal(
        json.missingDates.some((date: string) => date.startsWith("2026-11")),
        false,
      );
      assert.ok(json.monthly.some((month: any) => month.month === "2027-01"));
      assert.ok(json.monthly.some((month: any) => month.month === "2025-11"));
      const before = calls.length;
      load = async (month) => usage(month);
      await click("只重试失败月份（2）");
      const retried = await exportJson();
      assert.deepEqual(calls.slice(before), ["2026-12", "2026-08"]);
      assert.deepEqual(retried.failedMonths, []);
      assert.equal(
        retried.stale,
        false,
        "the final successful retry clears intermediate partial warnings",
      );
      assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
      assert.ok(retried.unloadedMonths.includes("2026-11"));
    });
  });

  test(`R17 history (${mode}): a remount can adopt a queued shared request instead of inheriting old owner cancellation`, async () => {
    now = NativeDate.parse("2026-10-31T15:59:00Z");
    calls = [];
    load = async (month) => usage(month);
    historyCache.invalidate();
    act(() => {
      view = Renderer.create(<HistoryPanel onBack={noop} windowVisible />, {
        unstable_isConcurrent: concurrent,
      } as any);
    });
    // Both effect lifetimes precede the cache loader's Promise microtask.
    // This represents shared-request ownership replay, not a claim that the
    // renderer executes React DOM's development StrictEffects implementation.
    act(() => view.unmount());
    act(() => {
      view = Renderer.create(<HistoryPanel onBack={noop} windowVisible />, {
        unstable_isConcurrent: concurrent,
      } as any);
    });
    try {
      await act(flush);
      assert.deepEqual(calls, ["2026-10"]);
      assert.deepEqual(metrics(), ["30", "¥3.00"]);
      assert.equal(text(view.toJSON()).includes("历史查询已暂停"), false);
    } finally {
      await act(async () => {
        view.unmount();
        await flush();
      });
      assert.equal(intervals.size, 0);
      assert.equal(events.get("visibilitychange")?.size ?? 0, 0);
    }
  });

  test(`R17 history (${mode}): hiding stops the batch and a hidden account change revokes every old result`, async () => {
    await fixture(concurrent, async () => {
      let complete!: (value: UsageResult) => void;
      let deferredMonth = "";
      load = (month) => {
        deferredMonth = month;
        return new Promise((resolve) => {
          complete = resolve;
        });
      };
      await click("全部");
      assert.ok(complete, "older uncached month is in flight");
      const before = calls.length;
      await visibility(false);
      await tick("2026-10-31T16:01:00Z");
      await act(async () => {
        historyCache.invalidate();
        await flush();
      });
      assert.equal(
        calls.length,
        before,
        "hidden epoch invalidation only revokes data",
      );
      assert.equal(text(view.toJSON()).includes("A-one"), false);
      await act(async () => {
        complete(usage(deferredMonth));
        await flush();
      });
      assert.equal(
        calls.length,
        before,
        "late old response must not continue the batch",
      );
      assert.equal(text(view.toJSON()).includes("A-one"), false);
      load = async (month) => usage(month, "B");
      await visibility(true);
      const json = await exportJson();
      assert.ok(json.daily.length > 0);
      assert.ok(
        json.daily.every((row: RawModelUsage) => row.model.startsWith("B-")),
      );
      assert.equal(text(view.toJSON()).includes("A-one"), false);
      assert.equal(select().props.value, "");
    });
  });
}
