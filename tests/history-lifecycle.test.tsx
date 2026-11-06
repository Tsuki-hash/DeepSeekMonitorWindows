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
const deferredUsage = () => {
  let resolve!: (value: UsageResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UsageResult>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};
const chooseModel = async (value: string) => {
  assert.ok(
    select()
      .findAllByType("option")
      .some((option: any) => option.props.value === value),
    `model must be selectable before a user chooses it: ${value}`,
  );
  await act(async () => {
    select().props.onChange({ target: { value } });
    await flush();
  });
};
const assertModelSelection = (value: string, unavailable = false) => {
  assert.equal(select().props.value, value);
  const options = select().findAllByType("option");
  const matching = options.filter(
    (option: any) => option.props.value === value,
  );
  assert.equal(
    matching.length,
    1,
    "the controlled value has exactly one option",
  );
  assert.equal(
    text(matching[0]),
    unavailable ? `${value}（当前范围未返回）` : value || "全部模型",
  );
  assert.notEqual(matching[0].props.disabled, true);
  assert.notEqual(matching[0].props.hidden, true);
  assert.equal(
    new Set(options.map((option: any) => option.props.value)).size,
    options.length,
    "fallback and returned options cannot duplicate raw model values",
  );
  if (unavailable) {
    const hint = view.root.findByProps({
      id: select().props["aria-describedby"],
    });
    assert.equal(hint.props.role, "status");
    assert.ok(text(hint).includes(`仍按“${value}”筛选`));
    assert.ok(text(hint).includes("不代表零用量"));
  } else {
    assert.equal(select().props["aria-describedby"], undefined);
  }
};
const assertNoFilteredUsage = () => {
  assert.deepEqual(metrics(), ["—", "—"]);
  assert.ok(trend().every((item) => item.value === null));
  assert.equal(
    view.root
      .findByProps({ className: "history-models" })
      .findAllByType("details").length,
    0,
  );
  assert.ok(
    view.root
      .findAllByType("tbody")
      .every((body: any) => body.findAllByType("tr").length === 0),
    "daily rows and independent source rows use the same selected raw value",
  );
};
async function fixture(
  concurrent: boolean,
  inspect: () => Promise<void>,
  initialLoad: (month: string) => Promise<UsageResult> = async (month) =>
    usage(month),
  initialInstant = "2026-10-31T15:59:00Z",
) {
  now = NativeDate.parse(initialInstant);
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

const remountHistory = async (concurrent: boolean, configured = true) => {
  await act(async () => {
    view.unmount();
    await flush();
  });
  await act(async () => {
    view = Renderer.create(
      <HistoryPanel
        onBack={noop}
        windowVisible
        usageTokenConfigured={configured}
      />,
      { unstable_isConcurrent: concurrent } as any,
    );
    await flush();
  });
  await act(flush);
};

const assertCsvStale = async (expected: boolean) => {
  await click("CSV");
  const csv = (await blobs[blobs.length - 1].text()).replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const character = csv[i];
    if (character === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === "," || character === "\n")) {
      row.push(field);
      field = "";
      if (character === "\n") {
        rows.push(row);
        row = [];
      }
    } else if (quoted || character !== "\r") field += character;
  }
  if (row.length || field) rows.push([...row, field]);
  const column = rows[0].indexOf("stale");
  assert.ok(column >= 0);
  assert.ok(
    rows.length > 1,
    "fixture exports returned or explicitly missing dates",
  );
  assert.ok(
    rows.slice(1).every((record) => record[column] === String(expected)),
  );
};

// Round 29: cache state is authoritative across selection resets/unmounts.
for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  for (const failure of [
    {
      code: "not_configured",
      message: "not configured",
      configured: false,
      action: "去设置页配置用量 Token",
    },
    {
      code: "credentials_invalid",
      message: "invalid credentials",
      configured: true,
      action: "去设置页重新同步 Token",
    },
    {
      code: "rate_limited",
      message: "rate limited",
      configured: true,
      action: "只重试失败月份（1）",
    },
    {
      code: "unavailable",
      message: "unavailable",
      configured: true,
      action: "只重试失败月份（1）",
    },
    {
      code: "invalid_data",
      message: "平台 Token 数据无效",
      configured: true,
      action: "只重试失败月份（1）",
    },
    {
      code: "unknown",
      message: "ordinary month error",
      configured: true,
      action: "只重试失败月份（1）",
    },
    {
      code: "unknown",
      message: "请重新登录，用量 Token 已失效",
      configured: true,
      action: "去设置页重新同步 Token",
    },
  ]) {
    test(`R29 history (${mode}): ${failure.code}/${failure.message} cannot recover by switching ranges or remounting`, async () => {
      await fixture(concurrent, async () => {
        const original = await exportJson();
        if (!failure.configured) {
          await act(async () => {
            view.update(
              <HistoryPanel
                onBack={noop}
                windowVisible
                usageTokenConfigured={false}
              />,
            );
            await flush();
          });
        }
        load = async (month) => {
          if (month === "2026-10") throw failure;
          return usage(month);
        };
        const before = calls.length;
        await click("重新查询历史");
        assert.deepEqual(calls.slice(before), ["2026-10"]);
        const assertUnrecovered = async () => {
          const json = await exportJson();
          assert.deepEqual(json.failedMonths, ["2026-10"]);
          assert.equal(json.stale, true);
          assert.deepEqual(json.daily, original.daily);
          assert.deepEqual(
            json.sourceMonthlySnapshots,
            original.sourceMonthlySnapshots,
          );
          assert.deepEqual(json.unloadedMonths, []);
          assert.deepEqual(metrics(), ["30", "¥3.00"]);
          assert.ok(button(failure.action));
          assert.ok(button("只重试失败月份（1）"));
          assert.equal(view.root.findAllByProps({ role: "alert" }).length, 1);
          await assertCsvStale(true);
        };
        await assertUnrecovered();
        // A now-healthy loader must not be called, or assumed to have run, just
        // because the component's local error/snapshot state was reset.
        load = async (month) => usage(month, "recovered");
        await click("上月");
        const other = await exportJson();
        assert.deepEqual(other.failedMonths, []);
        assert.equal(other.stale, false);
        assert.ok(
          other.daily.every((row: any) => row.date.startsWith("2026-09")),
        );
        const afterOther = calls.length;
        await click("本月");
        assert.equal(calls.length, afterOther);
        await assertUnrecovered();
        await remountHistory(concurrent, failure.configured);
        assert.equal(calls.length, afterOther);
        await assertUnrecovered();
        const retryStart = calls.length;
        await click("只重试失败月份（1）");
        assert.deepEqual(calls.slice(retryStart), ["2026-10"]);
        const recovered = await exportJson();
        assert.deepEqual(recovered.failedMonths, []);
        assert.equal(recovered.stale, false);
        assert.ok(
          recovered.daily.every((row: RawModelUsage) =>
            row.model.startsWith("recovered-"),
          ),
        );
        await assertCsvStale(false);
        assert.equal(button("只重试失败月份（1）"), undefined);
        assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
        const recoveredCalls = calls.length;
        await remountHistory(concurrent, failure.configured);
        assert.equal(
          calls.length,
          recoveredCalls,
          "healthy TTL cache works after real recovery",
        );
        assert.deepEqual((await exportJson()).daily, recovered.daily);
      });
    });
  }

  test(`R29 history (${mode}): evicted failed payload remains unknown, not a zero or an unexplained success`, async () => {
    await fixture(concurrent, async () => {
      await click("全部");
      const original = await exportJson();
      assert.equal(original.monthly.length, 12);
      load = async () => {
        throw { code: "rate_limited" };
      };
      await click("重新查询历史");
      const retained = await exportJson();
      assert.deepEqual(
        retained.daily,
        original.daily,
        "the mounted all-history snapshot keeps its own success data",
      );
      assert.deepEqual(retained.failedMonths, ["2026-10"]);
      assert.equal(retained.stale, true);
      const beforeRemount = calls.length;
      await remountHistory(concurrent);
      assert.equal(calls.length, beforeRemount);
      const evicted = await exportJson();
      assert.deepEqual(evicted.failedMonths, ["2026-10"]);
      assert.equal(evicted.stale, true);
      assert.deepEqual(evicted.daily, []);
      assert.deepEqual(evicted.monthly, []);
      assert.deepEqual(evicted.sourceMonthlySnapshots, []);
      assert.deepEqual(metrics(), ["—", "—"]);
      assert.ok(trend().every((point) => point.value === null));
      assert.ok(text(view.toJSON()).includes("旧成功缓存已释放"));
      assert.ok(button("只重试失败月份（1）"));
      await assertCsvStale(true);
      load = async (month) => usage(month);
      await click("只重试失败月份（1）");
      assert.equal(calls.length, beforeRemount + 1);
      assert.deepEqual((await exportJson()).failedMonths, []);
      assert.deepEqual(metrics(), ["30", "¥3.00"]);
    });
  });

  test(`R29 history (${mode}): mixed failed/loaded/unloaded coverage survives range reset and remount`, async () => {
    await fixture(concurrent, async () => {
      load = async (month) => {
        if (month === "2026-10") throw { code: "invalid_data" };
        return usage(month);
      };
      await click("重新查询历史");
      await click("全部");
      const all = historyWindow("all", "2026-10-31").months;
      const snapshot = await exportJson();
      assert.deepEqual(snapshot.failedMonths, ["2026-10"]);
      assert.deepEqual(snapshot.unloadedMonths, all.slice(0, -12));
      assert.equal(snapshot.monthly.length, 12);
      assert.equal(snapshot.stale, true);
      assert.ok(button("继续加载更早月份 ›"));
      await remountHistory(concurrent);
      await click("全部");
      const remounted = await exportJson();
      assert.deepEqual(remounted.failedMonths, ["2026-10"]);
      assert.deepEqual(remounted.unloadedMonths, all.slice(0, -12));
      assert.equal(
        remounted.monthly.length,
        11,
        "the evicted failed month has no fabricated payload after remount",
      );
      assert.ok(remounted.missingDates.includes("2026-10-31"));
      const start = calls.length;
      load = async (month) => usage(month, "recovered");
      await click("只重试失败月份（1）");
      assert.deepEqual(calls.slice(start), ["2026-10"]);
      const recovered = await exportJson();
      assert.deepEqual(recovered.failedMonths, []);
      assert.deepEqual(recovered.unloadedMonths, all.slice(0, -12));
      assert.equal(recovered.monthly.length, 12);
    });
  });

  for (const change of ["ttl", "accounting-day"] as const) {
    test(`R29 history (${mode}): ${change} expiry can clear failure only after an actual loader success`, async () => {
      await fixture(
        concurrent,
        async () => {
          load = async () => {
            throw { code: "invalid_data" };
          };
          await click("重新查询历史");
          const old = await exportJson();
          assert.deepEqual(old.failedMonths, ["2026-10"]);
          await tick(
            change === "ttl" ? "2026-10-30T14:06:00Z" : "2026-10-30T16:01:00Z",
          );
          const before = calls.length;
          await remountHistory(concurrent);
          assert.deepEqual(calls.slice(before), ["2026-10"]);
          assert.deepEqual((await exportJson()).failedMonths, ["2026-10"]);
          assert.equal((await exportJson()).stale, true);
          const pending = deferredUsage();
          load = () => pending.promise;
          await click("只重试失败月份（1）");
          assert.equal(button("JSON").props.disabled, true);
          await act(async () => {
            pending.resolve(usage("2026-10", "new"));
            await flush();
          });
          const recovered = await exportJson();
          assert.deepEqual(recovered.failedMonths, []);
          assert.equal(recovered.stale, false);
        },
        undefined,
        "2026-10-30T14:00:00Z",
      );
    });
  }

  for (const late of ["success", "failure"] as const) {
    test(`R29 history (${mode}): retry remount adopts the active request and ignores old-token late ${late}`, async () => {
      await fixture(concurrent, async () => {
        load = async () => {
          throw { code: "credentials_invalid" };
        };
        await click("重新查询历史");
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("只重试失败月份（1）");
        const before = calls.length;
        await remountHistory(concurrent);
        assert.equal(calls.length, before, "remount joins the active retry");
        assert.equal(button("JSON").props.disabled, true);
        load = async (month) => usage(month, "B");
        await act(async () => {
          historyCache.invalidate();
          await flush();
        });
        const current = await exportJson();
        assert.deepEqual(current.failedMonths, []);
        assert.equal(current.stale, false);
        assert.ok(
          current.daily.every((row: RawModelUsage) =>
            row.model.startsWith("B-"),
          ),
        );
        await act(async () => {
          if (late === "success") pending.resolve(usage("2026-10", "A-late"));
          else pending.reject({ code: "rate_limited" });
          await flush();
        });
        assert.deepEqual((await exportJson()).daily, current.daily);
        assert.equal(button("只重试失败月份（1）"), undefined);
        await remountHistory(concurrent);
        assert.deepEqual((await exportJson()).daily, current.daily);
        assert.equal((await exportJson()).stale, false);
      });
    });
  }

  test(`R29 history (${mode}): excluded source dates are visible without entering normal totals`, async () => {
    await fixture(
      concurrent,
      async () => {
        const json = await exportJson();
        assert.deepEqual(metrics(), ["30", "¥3.00"]);
        assert.ok(
          text(view.toJSON()).includes("2 条来源日期异常，已排除正常合计"),
        );
        assert.ok(text(view.toJSON()).includes("2026-10-32"));
        assert.ok(text(view.toJSON()).includes("2026-09-30"));
        assert.equal(json.excludedDateRecords.length, 2);
        assert.ok(json.daily.every((row: any) => row.date === "2026-10-31"));
      },
      async (month) => {
        const original = usage(month);
        return {
          ...original,
          days: [
            ...original.days,
            { date: "2026-10-32", rawModels: [raw("invalid-source", 123, 12)] },
            {
              date: "2026-09-30",
              rawModels: [raw("wrong-month-source", 456, 45)],
            },
          ] as UsageResult["days"],
        };
      },
    );
  });
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
          // Cross the boundary before the next display-clock render. The old
          // click handler must still defend against its now-expired targets.
          now = NativeDate.parse(scenario.at);
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
      // Exercise the stale handler between midnight and the next display tick.
      now = NativeDate.parse("2026-10-31T16:01:00Z");
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

// Round 19: cancelling work cannot discard recovery for committed failures.
for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  for (const scenario of [
    { coverage: "mixed", interruption: "stop" },
    { coverage: "mixed", interruption: "hide" },
    { coverage: "failed-only", interruption: "hide" },
  ] as const) {
    for (const late of ["success", "failure"] as const) {
      test(`R19 history (${mode}): ${scenario.interruption} before the first retry response preserves ${scenario.coverage} recovery after late ${late}`, async () => {
        await fixture(
          concurrent,
          async () => {
            const all = historyWindow("all", "2026-10-31").months;
            const failed =
              scenario.coverage === "failed-only"
                ? all
                : ["2021-02", "2026-08"];
            load = async (month) => {
              if (failed.includes(month)) throw { code: "invalid_data" };
              return usage(month);
            };
            await click("全部");
            for (
              let remaining = all.length - 12;
              remaining > 0;
              remaining -= 12
            )
              await click("继续加载更早月份 ›");
            assert.equal(button("继续加载更早月份 ›"), undefined);
            if (scenario.coverage === "mixed")
              await act(async () =>
                select().props.onChange({ target: { value: "A-one" } }),
              );
            const original = await exportJson();
            assert.deepEqual(original.failedMonths, failed);
            assert.deepEqual(original.unloadedMonths, []);
            assert.equal(original.monthly.length, all.length - failed.length);
            const originalMetrics = metrics();
            const pending = deferredUsage();
            load = () => pending.promise;
            const start = calls.length;
            const retryLabel = `只重试失败月份（${failed.length}）`;
            await click(retryLabel);
            const first = failed[failed.length - 1];
            assert.deepEqual(calls.slice(start), [first]);
            if (scenario.interruption === "stop") {
              await click("停止查询");
            } else {
              await visibility(false);
              await visibility(true);
            }
            assert.equal(button("停止查询"), undefined);
            assert.ok(button(retryLabel));
            assert.deepEqual(
              calls.slice(start),
              [first],
              "same-day show must not start a broader query, even with no successful months",
            );
            assert.deepEqual(metrics(), originalMetrics);
            const cancelled = await exportJson();
            assert.deepEqual(cancelled.daily, original.daily);
            assert.deepEqual(cancelled.failedMonths, failed);
            assert.deepEqual(cancelled.unloadedMonths, []);
            await act(async () => {
              if (late === "success") pending.resolve(usage(first, "late"));
              else pending.reject({ code: "credentials_invalid" });
              await flush();
            });
            assert.deepEqual(calls.slice(start), [first]);
            assert.ok(button(retryLabel));
            assert.equal(button("去设置页重新同步 Token"), undefined);
            const ignored = await exportJson();
            assert.deepEqual(ignored.daily, original.daily);
            assert.deepEqual(ignored.failedMonths, failed);
            assert.deepEqual(ignored.unloadedMonths, []);
            const resume = calls.length;
            load = async (month) => usage(month);
            await click(retryLabel);
            assert.deepEqual(
              calls.slice(resume),
              [...failed].reverse(),
              "resuming retries only failures, never the successful months loaded back to 2020",
            );
            const recovered = await exportJson();
            assert.deepEqual(recovered.failedMonths, []);
            assert.deepEqual(recovered.unloadedMonths, []);
            assert.equal(recovered.monthly.length, all.length);
            assert.equal(recovered.stale, false);
            assert.equal(button(retryLabel), undefined);
            assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
            if (scenario.coverage === "mixed")
              assert.equal(select().props.value, "A-one");
          },
          async (month) => {
            if (scenario.coverage === "failed-only")
              throw { code: "invalid_data" };
            return usage(month);
          },
        );
      });
    }
  }

  test(`R19 history (${mode}): stopping after one recovered month keeps only the remaining failure`, async () => {
    await fixture(concurrent, async () => {
      load = async (month) => {
        if (["2026-08", "2026-09"].includes(month))
          throw { code: "invalid_data" };
        return usage(month);
      };
      await click("全部");
      const pending = deferredUsage();
      load = async (month) =>
        month === "2026-08" ? pending.promise : usage(month);
      await click("只重试失败月份（2）");
      await click("停止查询");
      assert.ok(button("只重试失败月份（1）"));
      assert.equal(button("只重试失败月份（2）"), undefined);
      const stopped = await exportJson();
      assert.deepEqual(stopped.failedMonths, ["2026-08"]);
      assert.ok(
        stopped.monthly.some((month: any) => month.month === "2026-09"),
      );
      await act(async () => {
        pending.resolve(usage("2026-08", "late"));
        await flush();
      });
      assert.deepEqual((await exportJson()).failedMonths, ["2026-08"]);
      const start = calls.length;
      load = async (month) => usage(month);
      await click("只重试失败月份（1）");
      assert.deepEqual(calls.slice(start), ["2026-08"]);
      assert.deepEqual((await exportJson()).failedMonths, []);
    });
  });

  test(`R19 history (${mode}): stopping an authentication retry preserves its settings action`, async () => {
    await fixture(
      concurrent,
      async () => {
        assert.ok(button("去设置页重新同步 Token"));
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("只重试失败月份（1）");
        await click("停止查询");
        assert.ok(button("去设置页重新同步 Token"));
        assert.ok(button("只重试失败月份（1）"));
        await act(async () => {
          pending.resolve(usage("2026-10"));
          await flush();
        });
        assert.ok(button("去设置页重新同步 Token"));
        assert.deepEqual((await exportJson()).failedMonths, ["2026-10"]);
      },
      async () => {
        throw { code: "credentials_invalid" };
      },
    );
  });

  test(`R19 history (${mode}): a partially expired rolling retry exposes only the remaining current failure`, async () => {
    await fixture(
      concurrent,
      async () => {
        await tick("2026-10-31T16:01:00Z");
        await click("近30天");
        assert.deepEqual((await exportJson()).failedMonths, [
          "2026-10",
          "2026-11",
        ]);
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("只重试失败月份（2）");
        await tick("2026-11-30T16:01:00Z");
        await click("停止查询");
        assert.ok(button("只重试失败月份（1）"));
        assert.equal(button("只重试失败月份（2）"), undefined);
        assert.equal(button("重新查询当前区间"), undefined);
        await act(async () => {
          pending.reject({ code: "credentials_invalid" });
          await flush();
        });
        const before = calls.length;
        load = async (month) => usage(month);
        await click("只重试失败月份（1）");
        assert.deepEqual(calls.slice(before), ["2026-11"]);
        const current = await exportJson();
        assert.deepEqual(current.failedMonths, []);
        assert.deepEqual(current.unloadedMonths, ["2026-12"]);
        assert.equal(current.from, "2026-11-02");
        assert.equal(current.to, "2026-12-01");
      },
      async () => {
        throw { code: "invalid_data" };
      },
    );
  });

  test(`R19 history (${mode}): switching fixed months revokes the previous retry and recovery actions`, async () => {
    await fixture(
      concurrent,
      async () => {
        await click("历史月份");
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("只重试失败月份（1）");
        const before = calls.length;
        load = async (month) => usage(month);
        await act(async () => {
          view.root
            .findByProps({ type: "month" })
            .props.onChange({ target: { value: "2024-02" } });
          await flush();
        });
        await act(flush);
        assert.deepEqual(calls.slice(before), ["2024-02"]);
        assert.equal(button("只重试失败月份（1）"), undefined);
        assert.equal(button("重新查询当前区间"), undefined);
        await act(async () => {
          pending.reject({ code: "credentials_invalid" });
          await flush();
        });
        const current = await exportJson();
        assert.equal(current.from, "2024-02-01");
        assert.deepEqual(current.failedMonths, []);
        assert.equal(button("去设置页重新同步 Token"), undefined);
        await visibility(false);
        await tick("2026-10-31T16:01:00Z");
        await visibility(true);
        assert.deepEqual(calls.slice(before), ["2024-02"]);
      },
      async () => {
        throw { code: "invalid_data" };
      },
    );
  });

  for (const scenario of [
    { label: "本月", at: "2026-10-31T16:01:00Z", expected: ["2026-11"] },
    { label: "上月", at: "2026-10-31T16:01:00Z", expected: ["2026-10"] },
    {
      label: "近30天",
      at: "2026-11-30T16:01:00Z",
      expected: ["2026-12", "2026-11"],
    },
  ]) {
    test(`R19 history (${mode}): stopping an expired ${scenario.label} retry offers the current window instead`, async () => {
      await fixture(
        concurrent,
        async () => {
          await click(scenario.label);
          const original = await exportJson();
          const pending = deferredUsage();
          load = () => pending.promise;
          const start = calls.length;
          await click("只重试失败月份（1）");
          await tick(scenario.at);
          await click("停止查询");
          assert.equal(button("只重试失败月份（1）"), undefined);
          assert.ok(button("重新查询当前区间"));
          assert.equal(calls.length, start + 1);
          await act(async () => {
            pending.resolve(usage(original.failedMonths[0], "late"));
            await flush();
          });
          const stopped = await exportJson();
          assert.equal(stopped.from, original.from);
          assert.equal(stopped.to, original.to);
          assert.deepEqual(stopped.failedMonths, original.failedMonths);
          assert.ok(button("重新查询当前区间"));
          const resume = calls.length;
          load = async (month) => usage(month);
          await click("重新查询当前区间");
          assert.deepEqual(calls.slice(resume), scenario.expected);
          assert.deepEqual((await exportJson()).failedMonths, []);
        },
        async () => {
          throw { code: "invalid_data" };
        },
      );
    });
  }

  for (const late of ["success", "failure"] as const) {
    test(`R19 history (${mode}): hidden account replacement cannot revive a cancelled retry after late ${late}`, async () => {
      await fixture(
        concurrent,
        async () => {
          await click("全部");
          const pending = deferredUsage();
          load = () => pending.promise;
          await click("只重试失败月份（12）");
          await visibility(false);
          const before = calls.length;
          await act(async () => {
            historyCache.invalidate();
            await flush();
          });
          assert.equal(calls.length, before);
          assert.equal(button("只重试失败月份（12）"), undefined);
          assert.equal(button("重新查询当前区间"), undefined);
          assert.equal(button("JSON").props.disabled, true);
          load = async (month) => usage(month, "B");
          await visibility(true);
          const current = await exportJson();
          const all = historyWindow("all", "2026-10-31").months;
          assert.deepEqual(calls.slice(before), all.slice(-12).reverse());
          await act(async () => {
            if (late === "success") pending.resolve(usage("2026-10", "A"));
            else pending.reject({ code: "credentials_invalid" });
            await flush();
          });
          const after = await exportJson();
          assert.deepEqual(after.daily, current.daily);
          assert.deepEqual(after.failedMonths, []);
          assert.deepEqual(after.unloadedMonths, all.slice(0, -12));
          assert.ok(
            after.daily.every((row: RawModelUsage) =>
              row.model.startsWith("B-"),
            ),
          );
          assert.equal(button("去设置页重新同步 Token"), undefined);
          assert.equal(button("只重试失败月份（12）"), undefined);
          assert.equal(button("重新查询当前区间"), undefined);
        },
        async () => {
          throw { code: "invalid_data" };
        },
      );
    });
  }
}

// Round 21: a retained model filter must always have an explicit native option.
// Renderer assertions cover the controlled value/option/data contract only;
// Windows WebView2's collapsed select and native popup require manual checks.
for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";

  for (const range of ["本月", "历史月份"]) {
    test(`R21 history (${mode}): ${range} snapshot A to B to A keeps the filter explicit without changing source values`, async () => {
      await fixture(concurrent, async () => {
        await click(range);
        await chooseModel("A-one");
        assertModelSelection("A-one");
        assert.deepEqual(metrics(), ["10", "¥1.00"]);
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("重新查询历史");
        assertModelSelection("A-one");
        assert.deepEqual(metrics(), ["10", "¥1.00"]);
        await act(async () => {
          pending.resolve(usage("2026-10", "B"));
          await flush();
        });
        assertModelSelection("A-one", true);
        assertNoFilteredUsage();
        if (range === "历史月份") {
          const before = calls.length;
          await visibility(false);
          await tick("2026-10-31T16:01:00Z");
          await visibility(true);
          assert.equal(
            calls.length,
            before,
            "the fixed month stays in October",
          );
          assertModelSelection("A-one", true);
          assertNoFilteredUsage();
        }
        const json = await exportJson();
        assert.equal(json.from, "2026-10-01");
        assert.equal(json.to, "2026-10-31");
        assert.deepEqual(
          json.daily.map((row: RawModelUsage) => row.model),
          ["B-one", "B-two"],
        );
        assert.equal(json.sourceMonthlySnapshots[0].models[0].totalTokens, 900);
        assert.equal(JSON.stringify(json).includes("当前范围未返回"), false);
        await click("费用");
        assertNoFilteredUsage();
        load = async (month) => usage(month);
        await click("重新查询历史");
        assertModelSelection("A-one");
        assert.deepEqual(metrics(), ["10", "¥1.00"]);
        assert.equal(trend().find((item) => item.value !== null)?.value, 1);
        assert.equal(
          view.root.findAllByType("tbody")[0].findAllByType("tr").length,
          1,
        );
      });
    });
  }

  for (const scenario of [
    { range: "本月", at: "2026-10-31T16:01:00Z", show: false },
    { range: "本月", at: "2026-10-31T16:01:00Z", show: true },
    { range: "上月", at: "2026-10-31T16:01:00Z", show: false },
    { range: "近30天", at: "2026-11-30T16:01:00Z", show: false },
  ]) {
    test(`R21 history (${mode}): ${scenario.range} rollover ${scenario.show ? "show" : "refresh"} never displays all while filtering a missing model`, async () => {
      await fixture(concurrent, async () => {
        await click(scenario.range);
        await chooseModel("A-one");
        const before = calls.length;
        load = async (month) => usage(month, "B");
        if (scenario.show) await visibility(false);
        await tick(scenario.at);
        assert.equal(calls.length, before);
        assertModelSelection("A-one");
        if (scenario.show) await visibility(true);
        else await click("重新查询历史");
        assertModelSelection("A-one", true);
        assertNoFilteredUsage();
        await chooseModel("B-two");
        assertModelSelection("B-two");
        assert.deepEqual(metrics(), ["20", "¥2.00"]);
        assert.equal(
          select()
            .findAllByType("option")
            .some((option: any) => option.props.value === "A-one"),
          false,
          "only the active absent selection is retained, not an old model cache",
        );
        await chooseModel("");
        assertModelSelection("");
        assert.deepEqual(metrics(), ["30", "¥3.00"]);
      });
    });
  }

  for (const result of ["empty", "failed"] as const) {
    test(`R21 history (${mode}): rollover to ${result} data keeps the missing model distinct from all and zero`, async () => {
      await fixture(concurrent, async () => {
        await chooseModel("A-one");
        await tick("2026-10-31T16:01:00Z");
        load = async (month) => {
          if (result === "failed") throw { code: "invalid_data" };
          return { ...usage(month), rawModels: [], days: [] };
        };
        await click("重新查询历史");
        assertModelSelection("A-one", true);
        assertNoFilteredUsage();
        assert.equal(select().findAllByType("option").length, 2);
        const json = await exportJson();
        assert.deepEqual(
          json.failedMonths,
          result === "failed" ? ["2026-11"] : [],
        );
        assert.deepEqual(json.daily, []);
        assert.deepEqual(json.unloadedMonths, []);
        load = async (month) => usage(month);
        await click(
          result === "failed" ? "只重试失败月份（1）" : "重新查询历史",
        );
        assertModelSelection("A-one");
        assert.deepEqual(metrics(), ["10", "¥1.00"]);
      });
    });
  }

  test(`R21 history (${mode}): failed refresh keeps an actually retained model available`, async () => {
    await fixture(concurrent, async () => {
      await chooseModel("A-one");
      load = async () => {
        throw { code: "invalid_data" };
      };
      await click("重新查询历史");
      assertModelSelection("A-one");
      assert.deepEqual(metrics(), ["10", "¥1.00"]);
      assert.deepEqual((await exportJson()).failedMonths, ["2026-10"]);
    });
  });

  test(`R21 history (${mode}): source-only and raw model names are never changed by the missing-option label`, async () => {
    const rawName = "vendor/Model A:v1（当前范围未返回）";
    await fixture(concurrent, async () => {
      load = async (month) => ({
        ...usage(month),
        rawModels: [raw(rawName, 321, 3.21)],
        days: [],
      });
      await click("重新查询历史");
      await chooseModel(rawName);
      assertModelSelection(rawName);
      assert.deepEqual(metrics(), ["—", "—"]);
      assert.equal(
        view.root
          .findByProps({ className: "history-models" })
          .findAllByType("details").length,
        1,
        "a model returned only by the source month is available, with unknown daily totals",
      );
      load = async (month) => usage(month, "B");
      await click("重新查询历史");
      assertModelSelection(rawName, true);
      assertNoFilteredUsage();
      await chooseModel("");
      assertModelSelection("");
      assert.deepEqual(metrics(), ["30", "¥3.00"]);
    });
  });

  test(`R21 history (${mode}): all retains earlier models and unloaded holes, then replaces the missing option when older data returns it`, async () => {
    await fixture(concurrent, async () => {
      load = async (month) => usage(month, month === "2026-10" ? "A" : "B");
      await click("全部");
      await chooseModel("A-one");
      const first = await exportJson();
      await tick("2026-10-31T16:01:00Z");
      load = async (month) => usage(month, "B");
      await click("继续加载更早月份 ›");
      assertModelSelection("A-one");
      assert.deepEqual(metrics(), ["10", "¥1.00"]);
      const expanded = await exportJson();
      assert.equal(expanded.monthly.length, 24);
      assert.ok(expanded.unloadedMonths.includes("2026-11"));
      assert.ok(
        first.monthly.every((month: any) =>
          expanded.monthly.some((item: any) => item.month === month.month),
        ),
      );
      await click("重新查询历史");
      assertModelSelection("A-one", true);
      assertNoFilteredUsage();
      const replaced = await exportJson();
      assert.equal(replaced.monthly.length, 25);
      assert.ok(replaced.unloadedMonths.length > 0);
      assert.equal(replaced.unloadedMonths.includes("2026-11"), false);
      const oldest = replaced.monthly[0].month;
      assert.ok(
        replaced.monthly.some(
          (month: any) => month.month === expanded.monthly[0].month,
        ),
      );
      load = async (month) => usage(month);
      await click("继续加载更早月份 ›");
      assertModelSelection("A-one");
      assert.equal(trend().filter((item) => item.value !== null).length, 12);
      assert.ok(
        (await exportJson()).monthly.some(
          (month: any) => month.month === oldest,
        ),
      );
    });
  });

  for (const choice of ["", "A-two"]) {
    test(`R21 history (${mode}): a user choice ${choice || "all"} batched with refresh completion is not overwritten`, async () => {
      await fixture(concurrent, async () => {
        await chooseModel("A-one");
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("重新查询历史");
        await act(async () => {
          pending.resolve(usage("2026-10", "B"));
          select().props.onChange({ target: { value: choice } });
          await flush();
        });
        assertModelSelection(choice, choice !== "");
        if (choice) assertNoFilteredUsage();
        else assert.deepEqual(metrics(), ["30", "¥3.00"]);
        const next = deferredUsage();
        load = () => next.promise;
        await click("重新查询历史");
        await chooseModel("B-two");
        assertModelSelection("B-two");
        await act(async () => {
          next.resolve(usage("2026-10"));
          await flush();
        });
        assertModelSelection("B-two", true);
        assertNoFilteredUsage();
        await chooseModel("");
        assertModelSelection("");
        assert.deepEqual(metrics(), ["30", "¥3.00"]);
      });
    });
  }

  for (const change of [
    "range",
    "custom-month",
    "account-visible",
    "account-hidden",
  ] as const) {
    test(`R21 history (${mode}): ${change} clears the missing selection and rejects the old pending result`, async () => {
      await fixture(concurrent, async () => {
        if (change === "custom-month") await click("历史月份");
        await chooseModel("A-one");
        load = async (month) => usage(month, "B");
        await click("重新查询历史");
        assertModelSelection("A-one", true);
        const pending = deferredUsage();
        load = () => pending.promise;
        await click("重新查询历史");
        load = async (month) => usage(month, "C");
        if (change === "range") await click("上月");
        else if (change === "custom-month") {
          await act(async () => {
            view.root.findByProps({ type: "month" }).props.onChange({
              target: { value: "2024-02" },
            });
            await flush();
          });
          await act(flush);
        } else {
          if (change === "account-hidden") await visibility(false);
          await act(async () => {
            historyCache.invalidate();
            await flush();
          });
          assertModelSelection("");
          assert.equal(text(view.toJSON()).includes("A-one"), false);
          if (change === "account-hidden") {
            assert.equal(select().findAllByType("option").length, 1);
            assert.equal(button("JSON").props.disabled, true);
            await visibility(true);
          }
        }
        assertModelSelection("");
        const current = await exportJson();
        assert.ok(current.daily.length > 0);
        assert.ok(
          current.daily.every((row: RawModelUsage) =>
            row.model.startsWith("C-"),
          ),
        );
        await act(async () => {
          pending.resolve(usage("2026-10", "A"));
          await flush();
        });
        assertModelSelection("");
        assert.equal(text(view.toJSON()).includes("A-one"), false);
        assert.equal(text(view.toJSON()).includes("B-one"), false);
        assert.deepEqual((await exportJson()).daily, current.daily);
      });
    });
  }
}
