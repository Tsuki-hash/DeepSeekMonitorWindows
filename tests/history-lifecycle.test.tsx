import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { HistoryTrend } from "../src/components/HistoryTrend";
import { historyCache } from "../src/history-cache";
import type { RawModelUsage, UsageResult } from "../src/types";
import { historyWindow } from "../src/history";

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
  // Also cover an explicit retry of every failed month since 2020.
  for (let i = 0; i < 1200; i++) await Promise.resolve();
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
async function fixture(
  concurrent: boolean,
  inspect: () => Promise<void>,
  initialLoad: (month: string) => Promise<UsageResult> = async (month) =>
    usage(month),
) {
  now = NativeDate.parse("2026-10-31T15:59:00Z");
  calls = [];
  blobs.length = 0;
  load = initialLoad;
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

// Round 18: explicit recovery for expired retries, and independent attempt cursors.
for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  for (const scenario of [
    { label: "本月", at: "2026-10-31T16:01:00Z", expected: ["2026-11"] },
    { label: "上月", at: "2026-10-31T16:01:00Z", expected: ["2026-10"] },
    {
      label: "近30天",
      at: "2026-11-30T16:01:00Z",
      expected: ["2026-12", "2026-11"],
    },
  ]) {
    test(`R18 history (${mode}): expired failed-only ${scenario.label} retry offers a real current-window query`, async () => {
      await fixture(
        concurrent,
        async () => {
          await click(scenario.label);
          const before = calls.length;
          const original = await exportJson();
          assert.deepEqual(original.daily, []);
          assert.equal(original.failedMonths.length, 1);
          await tick(scenario.at);
          await click("只重试失败月份（1）");
          assert.equal(
            calls.length,
            before,
            "an empty retry does not query outside the selected window",
          );
          assert.ok(text(view.toJSON()).includes("重试范围已过期"));
          assert.ok(text(view.toJSON()).includes("本次未发起查询"));
          assert.ok(button("重新查询当前区间"));
          assert.equal(button("只重试失败月份（1）"), undefined);
          const unchanged = await exportJson();
          assert.equal(unchanged.from, original.from);
          assert.equal(unchanged.to, original.to);
          assert.deepEqual(unchanged.failedMonths, original.failedMonths);
          assert.equal(
            unchanged.stale,
            true,
            "zero targets must not clear the error or imply recovery",
          );
          load = async (month) => usage(month);
          await click("重新查询当前区间");
          assert.deepEqual(calls.slice(before), scenario.expected);
          const recovered = await exportJson();
          assert.deepEqual(recovered.failedMonths, []);
          assert.deepEqual(recovered.unloadedMonths, []);
          assert.equal(recovered.stale, false);
          assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
        },
        async () => {
          throw { code: "invalid_data", message: "synthetic month failure" };
        },
      );
    });
  }

  test(`R18 history (${mode}): an expired retry preserves previous successful data until recovery`, async () => {
    await fixture(concurrent, async () => {
      load = async () => {
        throw { code: "unknown", message: "synthetic month failure" };
      };
      await click("重新查询历史");
      const original = await exportJson();
      const before = calls.length;
      await tick("2026-10-31T16:01:00Z");
      await click("只重试失败月份（1）");
      assert.equal(calls.length, before);
      assert.deepEqual((await exportJson()).daily, original.daily);
      assert.deepEqual(metrics(), ["30", "¥3.00"]);
      assert.ok(button("重新查询当前区间"));
      load = async (month) => usage(month);
      await click("重新查询历史");
      assert.deepEqual(calls.slice(before), ["2026-11"]);
      assert.equal((await exportJson()).from, "2026-11-01");
    });
  });

  test(`R18 history (${mode}): a fixed failed historical month remains retryable after rollover`, async () => {
    await fixture(concurrent, async () => {
      load = async () => {
        throw { code: "invalid_data", message: "synthetic month failure" };
      };
      await click("历史月份");
      await click("重新查询历史");
      await tick("2026-10-31T16:01:00Z");
      const before = calls.length;
      load = async (month) => usage(month);
      await click("只重试失败月份（1）");
      assert.deepEqual(calls.slice(before), ["2026-10"]);
      assert.equal((await exportJson()).from, "2026-10-01");
      assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
    });
  });

  for (const code of ["invalid_data", "unknown"]) {
    test(`R18 history (${mode}): all-${code} batches reach 2020 without repeating or inventing successful months`, async () => {
      await fixture(
        concurrent,
        async () => {
          const before = calls.length;
          const all = historyWindow("all", "2026-10-31").months;
          await click("全部");
          assert.deepEqual(calls.slice(before), all.slice(-12).reverse());
          let exported = await exportJson();
          assert.deepEqual(exported.failedMonths, all.slice(-12));
          assert.deepEqual(exported.unloadedMonths, all.slice(0, -12));
          assert.deepEqual(metrics(), ["—", "—"]);
          assert.ok(trend().every((item) => item.value === null));
          // Traverse the finite 2020..current range. Every batch must move older,
          // including when there has never been a single successful response.
          for (
            let remaining = all.length - 12;
            remaining > 0;
            remaining -= 12
          ) {
            const batchStart = calls.length;
            await click("继续加载更早月份 ›");
            assert.deepEqual(
              calls.slice(batchStart),
              all.slice(Math.max(0, remaining - 12), remaining).reverse(),
            );
            exported = await exportJson();
            assert.deepEqual(exported.daily, []);
            assert.deepEqual(exported.monthly, []);
            assert.ok(
              exported.missingDates.every((date: string) =>
                exported.failedMonths.includes(date.slice(0, 7)),
              ),
            );
          }
          assert.deepEqual(calls.slice(before), [...all].reverse());
          assert.deepEqual(exported.failedMonths, all);
          assert.deepEqual(exported.unloadedMonths, []);
          assert.equal(button("继续加载更早月份 ›"), undefined);
          assert.ok(button(`只重试失败月份（${all.length}）`));
          const retryStart = calls.length;
          load = async (month) => usage(month);
          await click(`只重试失败月份（${all.length}）`);
          assert.deepEqual(calls.slice(retryStart), [...all].reverse());
          const recovered = await exportJson();
          assert.deepEqual(recovered.failedMonths, []);
          assert.deepEqual(recovered.unloadedMonths, []);
          assert.equal(recovered.monthly.length, all.length);
          assert.equal(recovered.stale, false);
        },
        async () => {
          throw {
            code,
            message:
              code === "invalid_data"
                ? "平台 Token 数据解析失败"
                : "月份样本异常",
          };
        },
      );
    });
  }

  test(`R18 history (${mode}): successful, failed and older successful batches remain independently retryable`, async () => {
    await fixture(concurrent, async () => {
      await click("全部");
      await act(async () =>
        select().props.onChange({ target: { value: "A-one" } }),
      );
      const all = historyWindow("all", "2026-10-31").months;
      const failedBatch = all.slice(-24, -12);
      load = async () => {
        throw { code: "invalid_data", message: "synthetic month failure" };
      };
      await click("继续加载更早月份 ›");
      assert.deepEqual((await exportJson()).failedMonths, failedBatch);
      const before = calls.length;
      load = async (month) => usage(month);
      await click("继续加载更早月份 ›");
      assert.deepEqual(calls.slice(before), all.slice(-36, -24).reverse());
      const expanded = await exportJson();
      assert.deepEqual(expanded.failedMonths, failedBatch);
      assert.equal(expanded.monthly.length, 24);
      assert.deepEqual(expanded.unloadedMonths, all.slice(0, -36));
      assert.equal(select().props.value, "A-one");
      assert.equal(trend().filter((item) => item.value !== null).length, 24);
      const retryStart = calls.length;
      await click("只重试失败月份（12）");
      assert.deepEqual(calls.slice(retryStart), [...failedBatch].reverse());
      const recovered = await exportJson();
      assert.equal(recovered.monthly.length, 36);
      assert.deepEqual(recovered.failedMonths, []);
      assert.deepEqual(recovered.unloadedMonths, all.slice(0, -36));
      assert.equal(recovered.stale, false);
      assert.equal(select().props.value, "A-one");
    });
  });

  for (const [status, code] of [
    [401, "credentials_invalid"],
    [403, "credentials_invalid"],
    [404, "unavailable"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ] as const) {
    test(`R18 history (${mode}): backend HTTP ${status} classification still stops after one month`, async () => {
      // The native API maps these statuses to stable codes; this fixture tests
      // the component's code boundary, not the real HTTP/native mapping.
      await fixture(
        concurrent,
        async () => {
          const before = calls.length;
          await click("全部");
          assert.deepEqual(calls.slice(before), ["2026-10"]);
          const json = await exportJson();
          const all = historyWindow("all", "2026-10-31").months;
          assert.deepEqual(json.failedMonths, ["2026-10"]);
          assert.deepEqual(json.unloadedMonths, all.slice(0, -1));
          assert.ok(
            json.missingDates.every((date: string) =>
              date.startsWith("2026-10"),
            ),
          );
          const retryStart = calls.length;
          await click("只重试失败月份（1）");
          assert.deepEqual(calls.slice(retryStart), ["2026-10"]);
          assert.deepEqual(
            (await exportJson()).unloadedMonths,
            all.slice(0, -1),
          );
        },
        async () => {
          throw { code, message: `synthetic HTTP ${status}` };
        },
      );
    });
  }

  test(`R18 history (${mode}): unknown legacy authentication text still stops the batch`, async () => {
    await fixture(
      concurrent,
      async () => {
        const before = calls.length;
        await click("全部");
        assert.deepEqual(calls.slice(before), ["2026-10"]);
        assert.ok(button("去设置页重新同步 Token"));
        assert.deepEqual((await exportJson()).failedMonths, ["2026-10"]);
      },
      async () => {
        throw { code: "unknown", message: "请重新登录，用量 Token 已失效" };
      },
    );
  });

  test(`R18 history (${mode}): cancel after a failed month does not advance over a late in-flight failure`, async () => {
    await fixture(
      concurrent,
      async () => {
        let rejectPending!: (reason: unknown) => void;
        load = async (month) => {
          if (month === "2026-10") throw { code: "invalid_data" };
          return new Promise<UsageResult>((_, reject) => {
            rejectPending = reject;
          });
        };
        await click("全部");
        assert.ok(rejectPending);
        await click("停止查询");
        const stopped = await exportJson();
        assert.deepEqual(stopped.failedMonths, ["2026-10"]);
        assert.ok(stopped.unloadedMonths.includes("2026-09"));
        assert.equal(stopped.missingDates.includes("2026-09-01"), false);
        const before = calls.length;
        await act(async () => {
          rejectPending({ code: "unknown", message: "late failure" });
          await flush();
        });
        assert.equal(calls.length, before);
        assert.deepEqual(
          (await exportJson()).failedMonths,
          stopped.failedMonths,
        );
        load = async (month) => usage(month);
        await click("继续加载更早月份 ›");
        assert.equal(calls[before], "2026-09");
        assert.equal(calls.slice(before).length, 12);
        assert.deepEqual((await exportJson()).failedMonths, ["2026-10"]);
      },
      async () => {
        throw { code: "invalid_data" };
      },
    );
  });

  test(`R18 history (${mode}): hidden account changes reset a failed-only cursor and discard late errors`, async () => {
    await fixture(
      concurrent,
      async () => {
        let rejectPending!: (reason: unknown) => void;
        load = async (month) => {
          if (month === "2026-10") throw { code: "invalid_data" };
          return new Promise<UsageResult>((_, reject) => {
            rejectPending = reject;
          });
        };
        await click("全部");
        assert.ok(rejectPending);
        const before = calls.length;
        await visibility(false);
        await act(async () => {
          historyCache.invalidate();
          rejectPending({
            code: "unknown",
            message: "old account late failure",
          });
          await flush();
        });
        assert.equal(calls.length, before);
        assert.equal(button("继续加载更早月份 ›"), undefined);
        assert.equal(button("只重试失败月份（1）"), undefined);
        assert.equal(button("JSON").props.disabled, true);
        load = async (month) => usage(month, "B");
        await visibility(true);
        const all = historyWindow("all", "2026-10-31").months;
        assert.deepEqual(calls.slice(before), all.slice(-12).reverse());
        const json = await exportJson();
        assert.deepEqual(json.failedMonths, []);
        assert.deepEqual(json.unloadedMonths, all.slice(0, -12));
        assert.ok(
          json.daily.every((row: RawModelUsage) => row.model.startsWith("B-")),
        );
      },
      async () => {
        throw { code: "invalid_data" };
      },
    );
  });
}
