import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { historyCache } from "../src/history-cache";
import type { RawModelUsage, UsageResult } from "../src/types";

// Synthetic component events and ref requests only. No browser is started:
// .focus() mocks record requests, never pretend to deliver native focus events.
// Real Tab/Enter/Space, activeElement, live announcements and Windows/WebView2
// still require docs/REVIEW21_HISTORY_VIEWPORT_REGRESSIONS.md manual acceptance.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const NativeDate = Date;
const now = NativeDate.parse("2026-11-05T12:00:00Z");
g.Date = class extends NativeDate {
  constructor(value?: any) {
    super(value === undefined ? now : value);
  }
  static now() {
    return now;
  }
};
const timers = new Set<number>();
const resizeCallbacks = new Set<() => void>();
g.ResizeObserver = class {
  constructor(private callback: () => void) {}
  observe() {
    resizeCallbacks.add(this.callback);
  }
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
};
const listeners = new Map<string, Set<() => void>>();
let nextTimer = 1;
g.window = {
  setInterval: () => {
    const id = nextTimer++;
    timers.add(id);
    return id;
  },
  clearInterval: (id: number) => timers.delete(id),
};
g.document = {
  visibilityState: "visible",
  addEventListener: (name: string, run: () => void) => {
    const group = listeners.get(name) ?? new Set();
    group.add(run);
    listeners.set(name, group);
  },
  removeEventListener: (name: string, run: () => void) =>
    listeners.get(name)?.delete(run),
};
// Import after the window substitute exists: exercise the production layout-effect
// branch, rather than selecting the server/passive branch during static imports.
const { HistoryTrend } = await import("../src/components/HistoryTrend");
const { HistoryPanel } = await import("../src/components/HistoryPanel");
const dates = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"];
type Day = React.ComponentProps<typeof HistoryTrend>["days"][number];
const initial: Day[] = dates.map((date, index) => ({
  date,
  value: 100 + index,
}));
const chart = (
  days = initial,
  props: Partial<React.ComponentProps<typeof HistoryTrend>> = {},
) => (
  <HistoryTrend
    days={days}
    metric="totalTokens"
    dateLabel={(date) => date}
    {...props}
  />
);
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
const group = (view: any) =>
  view.root
    .findAllByProps({ role: "group" })
    .find((node: any) =>
      ["每日趋势数据", "每月趋势数据"].includes(node.props["aria-label"]),
    );
const reading = (view: any) =>
  view.root.findByProps({ className: "history-trend-reading" });
const button = (view: any, date: string) =>
  group(view)
    .findAllByType("button")
    .find((node: any) => node.props["aria-label"].startsWith(`${date}：`));
const assertSelected = (view: any, date: string, pinned = false) => {
  assert.equal(text(reading(view).findAllByType("span")[0]), date);
  assert.match(button(view, date).props.className, /\bactive\b/);
  assert.equal(button(view, date).props["aria-pressed"], pinned);
  assert.equal(
    reading(view).findAllByProps({ className: "history-trend-pin" }).length,
    pinned ? 1 : 0,
  );
  assert.equal(
    group(view)
      .findAllByType("button")
      .filter((node: any) => /\bactive\b/.test(node.props.className)).length,
    1,
  );
};
const assertDismissed = (view: any) => {
  assert.equal(text(reading(view)), "悬停或点击查看数据");
  for (const node of group(view).findAllByType("button")) {
    assert.equal(node.props["aria-pressed"], false);
    assert.doesNotMatch(node.props.className, /\bactive\b/);
  }
};
const update = async (view: any, element: React.ReactElement) => {
  await act(async () =>
    view.update(<React.StrictMode>{element}</React.StrictMode>),
  );
};
const key = async (node: any, value: string) => {
  let prevented = false;
  await act(async () =>
    node.props.onKeyDown({
      key: value,
      preventDefault: () => {
        prevented = true;
      },
    }),
  );
  return prevented;
};
async function render(
  element: React.ReactElement,
  concurrent: boolean,
  inspect: (
    view: any,
    focusRequests: string[],
    blurRequests: string[],
  ) => Promise<void>,
  createNodeMock?: (node: any) => any,
) {
  let view: any;
  const focusRequests: string[] = [];
  const blurRequests: string[] = [];
  await act(async () => {
    view = Renderer.create(<React.StrictMode>{element}</React.StrictMode>, {
      unstable_isConcurrent: concurrent,
      createNodeMock:
        createNodeMock ??
        ((node: any) =>
          node.type === "button"
            ? {
                focus: () => focusRequests.push(node.props["aria-label"]),
                blur: () => blurRequests.push(node.props["aria-label"]),
              }
            : { scrollLeft: 0, scrollWidth: 400 }),
    } as any);
  });
  try {
    await inspect(view, focusRequests, blurRequests);
  } finally {
    await act(async () => view.unmount());
    assert.equal(timers.size, 0);
    assert.equal(resizeCallbacks.size, 0);
    for (const entries of listeners.values()) assert.equal(entries.size, 0);
  }
}

// 数值几何替身，不提供 CSS 布局或真实浏览器焦点。只有测试显式设置 activeElement
// 才表示模拟的原生焦点；ref 创建和 .focus() 请求都不会自动成功。
function monthlyViewport(initialDays: Day[], initialWidth = 81) {
  let days = initialDays;
  let width = initialWidth;
  let left = 0;
  let barWidth = 24;
  const gap = 3;
  const nodes = new Map<string, any>();
  const writes: number[] = [];
  const focusRequests: string[] = [];
  const resizeListeners = new Set<() => void>();
  const ownerDocument: any = {
    activeElement: null,
    defaultView: {
      addEventListener: (name: string, fn: () => void) => {
        assert.equal(name, "resize");
        resizeListeners.add(fn);
      },
      removeEventListener: (name: string, fn: () => void) => {
        assert.equal(name, "resize");
        resizeListeners.delete(fn);
      },
    },
  };
  const maximum = () =>
    Math.max(0, days.length * (barWidth + gap) - gap - width);
  const container = {
    clientLeft: 0,
    ownerDocument,
    get clientWidth() {
      return width;
    },
    get scrollWidth() {
      return Math.max(width, days.length * (barWidth + gap) - gap);
    },
    get scrollLeft() {
      return left;
    },
    set scrollLeft(value: number) {
      left = Math.max(0, Math.min(maximum(), value));
      writes.push(left);
    },
    getBoundingClientRect: () => ({ left: 100, width }),
  };
  return {
    container,
    writes,
    focusRequests,
    resizeListeners,
    maximum,
    node: (date: string) => nodes.get(date),
    setDays(next: Day[]) {
      days = next;
      left = Math.min(left, maximum());
    },
    setWidth(next: number) {
      width = next;
      left = Math.min(left, maximum());
    },
    setBarWidth(next: number) {
      barWidth = next;
    },
    actualFocus(date: string | null) {
      ownerDocument.activeElement = date == null ? null : nodes.get(date);
    },
    resize() {
      for (const run of resizeCallbacks) run();
      for (const run of resizeListeners) run();
    },
    createNodeMock(node: any) {
      if (node.type === "div" && node.props.className?.includes("history-bars"))
        return container;
      if (node.type !== "button") return {};
      const date = node.props["aria-label"].split("：")[0];
      if (!nodes.has(date)) {
        nodes.set(date, {
          ownerDocument,
          focus: () => focusRequests.push(date),
          blur: () =>
            assert.fail("viewport reconciliation must not blur a button"),
          getBoundingClientRect: () => ({
            left:
              100 +
              days.findIndex((day) => day.date === date) * (barWidth + gap) -
              left,
            width: barWidth,
          }),
        });
      }
      return nodes.get(date);
    },
  };
}

const months: Day[] = Array.from({ length: 12 }, (_, index) => ({
  date: `2026-${String(index + 1).padStart(2, "0")}-01`,
  value: index + 1,
}));
const nextMonth: Day = { date: "2027-01-01", value: 13 };
const previousMonth: Day = { date: "2025-12-01", value: 0 };
const monthChart = (days = months) => chart(days, { monthly: true });

test("R21 history: only active owns the selection inset; keyboard focus stays distinct", () => {
  // Source-contract assertion only: computed CSS and WebView2 paint remain manual.
  const css = readFileSync("src/styles.css", "utf8");
  const selectionRules = [
    ...css.matchAll(/([^{}]+)\{[^{}]*box-shadow:\s*inset[^{}]*\}/g),
  ]
    .map((match) => match[1].trim())
    .filter((selector) => selector.includes("history-bars"));
  assert.equal(selectionRules.length, 1);
  assert.match(selectionRules[0], /\.history-bars > button\.active i$/);
  assert.doesNotMatch(selectionRules[0], /:hover/);
  assert.match(
    css,
    /\.history-bars > button:focus-visible\s*\{\s*outline: 2px solid var\(--focus-ring\);\s*outline-offset: -2px;/,
  );
  assert.match(css, /\.history-bars\.monthly\s*\{[^}]*overflow-anchor: none;/);
});

for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  test(`R21 monthly: first layout tails once, updates only follow a reader already at the end (${mode})`, async () => {
    const viewport = monthlyViewport(months);
    await render(
      monthChart(),
      concurrent,
      async (view) => {
        assert.equal(viewport.container.scrollLeft, viewport.maximum());
        assert.equal(viewport.writes.length, 1);
        await act(async () => viewport.resize());
        await update(
          view,
          monthChart(months.map((day) => ({ ...day, value: 99 }))),
        );
        assert.equal(
          viewport.writes.length,
          1,
          "replayed unchanged layout does not jump again",
        );
        let days = [...months, nextMonth];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(viewport.container.scrollLeft, viewport.maximum());
        viewport.container.scrollLeft = 54;
        await act(async () => group(view).props.onScroll());
        days = [...days, { date: "2027-02-01", value: 14 }];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(
          viewport.container.scrollLeft,
          54,
          "reading older months stays put",
        );
        assert.deepEqual(viewport.focusRequests, []);
      },
      viewport.createNodeMock,
    );
  });

  for (const selection of ["pin", "actual-focus", "escape-focus"] as const) {
    test(`R21 monthly: ${selection} blocks append from evicting the old date (${mode})`, async () => {
      const viewport = monthlyViewport(months);
      await render(
        monthChart(),
        concurrent,
        async (view) => {
          const date = months[9].date;
          const oldLeft = viewport.container.scrollLeft;
          if (selection === "pin") {
            await act(async () => button(view, date).props.onClick());
          } else {
            viewport.actualFocus(date);
            await act(async () => button(view, date).props.onFocus());
            if (selection === "escape-focus") {
              await key(button(view, date), "Escape");
              assertDismissed(view);
            }
          }
          const days = [...months, nextMonth];
          viewport.setDays(days);
          await update(view, monthChart(days));
          assert.equal(viewport.container.scrollLeft, oldLeft);
          assert.ok(viewport.node(date).getBoundingClientRect().left >= 100);
          if (selection === "escape-focus") assertDismissed(view);
          else assertSelected(view, date, selection === "pin");
          if (selection !== "pin")
            assert.equal(
              viewport.container.ownerDocument.activeElement,
              viewport.node(date),
            );
          assert.deepEqual(viewport.focusRequests, []);
        },
        viewport.createNodeMock,
      );
    });
  }

  test(`R21 monthly: rendered refs, focus requests and stale focus state are not actual focus (${mode})`, async () => {
    const viewport = monthlyViewport(months);
    await render(
      monthChart(),
      concurrent,
      async (view) => {
        await key(button(view, months[9].date), "ArrowRight");
        assert.deepEqual(viewport.focusRequests, [months[10].date]);
        await act(async () => button(view, months[9].date).props.onFocus());
        // Explicitly no activeElement: an event/state or .focus() request alone is not evidence.
        const days = [...months, nextMonth];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(viewport.container.scrollLeft, viewport.maximum());
      },
      viewport.createNodeMock,
    );
  });

  test(`R21 monthly: pending native scroll wins even when a data commit changes layout (${mode})`, async () => {
    const viewport = monthlyViewport(months);
    await render(
      monthChart(),
      concurrent,
      async (view) => {
        viewport.container.scrollLeft = 54; // Its browser scroll event has not arrived.
        let days = [...months, nextMonth];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(viewport.container.scrollLeft, 54);
        viewport.container.scrollLeft = 81; // Another pending scroll, then prepend.
        days = [previousMonth, ...days];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(viewport.container.scrollLeft, 108);
        // Actual focus moved the viewport without a scroll event or React focus state.
        viewport.container.scrollLeft = 27;
        viewport.actualFocus(months[0].date);
        days = [...days, { date: "2027-02-01", value: 14 }];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(viewport.container.scrollLeft, 27);
        assert.equal(
          viewport.node(months[0].date).getBoundingClientRect().left,
          100,
        );
        assert.deepEqual(viewport.focusRequests, []);
      },
      viewport.createNodeMock,
    );
  });

  test(`R21 monthly: prepend, simultaneous append and bar-size changes preserve the date anchor (${mode})`, async () => {
    const viewport = monthlyViewport(months);
    await render(
      monthChart(),
      concurrent,
      async (view) => {
        viewport.container.scrollLeft = 55;
        await act(async () => group(view).props.onScroll());
        const anchor = months[2].date;
        const oldPixel = viewport.node(anchor).getBoundingClientRect().left;
        let days = [previousMonth, ...months, nextMonth];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(
          viewport.node(anchor).getBoundingClientRect().left,
          oldPixel,
        );
        assert.equal(viewport.container.scrollLeft, 82);
        viewport.setBarWidth(30);
        await act(async () => viewport.resize());
        assert.equal(
          viewport.node(anchor).getBoundingClientRect().left,
          oldPixel,
        );
        days = days.slice(1); // Removing a leading month uses the same surviving identity.
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(
          viewport.node(anchor).getBoundingClientRect().left,
          oldPixel,
        );
      },
      viewport.createNodeMock,
    );
  });

  test(`R21 monthly: resizing preserves reading and actual focus; state commits respect native focus scrolling (${mode})`, async () => {
    const viewport = monthlyViewport(months);
    await render(
      monthChart(),
      concurrent,
      async (view) => {
        viewport.container.scrollLeft = 54;
        await act(async () => group(view).props.onScroll());
        viewport.setWidth(108);
        await act(async () => viewport.resize());
        assert.equal(viewport.container.scrollLeft, 54);
        const date = months[5].date;
        viewport.actualFocus(date);
        await act(async () => button(view, date).props.onFocus());
        viewport.setWidth(54);
        await act(async () => viewport.resize());
        assert.equal(viewport.container.scrollLeft, 105);
        assert.equal(
          viewport.node(date).getBoundingClientRect().left + 24,
          154,
        );
        // Browser focus may scroll before its scroll event is dispatched. A state-only
        // render must capture that position, not restore the previous reading anchor.
        const target = months[10].date;
        viewport.container.scrollLeft = 240;
        viewport.actualFocus(target);
        await act(async () => button(view, target).props.onFocus());
        assert.equal(viewport.container.scrollLeft, 240);
        assertSelected(view, target);
        viewport.container.scrollLeft = 27;
        await act(async () => group(view).props.onScroll());
        const days = [...months, nextMonth];
        viewport.setDays(days);
        await update(view, monthChart(days));
        assert.equal(
          viewport.container.scrollLeft,
          27,
          "manual scrolling away from focus is not undone",
        );
      },
      viewport.createNodeMock,
    );
  });

  test(`R21 monthly: zero width, empty data, reentry and daily mode are safe (${mode})`, async () => {
    const viewport = monthlyViewport([], 0);
    await render(
      monthChart([]),
      concurrent,
      async (view) => {
        viewport.setDays(months);
        await update(view, monthChart());
        assert.deepEqual(viewport.writes, []);
        viewport.setWidth(81);
        await act(async () => viewport.resize());
        assert.equal(viewport.container.scrollLeft, viewport.maximum());
        viewport.setDays([]);
        await update(view, monthChart([]));
        assertDismissed(view);
        viewport.setDays(months);
        await update(view, monthChart());
        assert.equal(viewport.container.scrollLeft, viewport.maximum());
        await update(view, chart(months));
        assert.equal(resizeCallbacks.size, 0);
        viewport.container.scrollLeft = 0;
        const days = [...months, nextMonth];
        viewport.setDays(days);
        await update(view, chart(days));
        assert.equal(
          viewport.container.scrollLeft,
          0,
          "daily mode does not manage horizontal scroll",
        );
      },
      viewport.createNodeMock,
    );
    // Existing ref-only renderer supplies no clientWidth, rects or ownerDocument.
    await render(monthChart(), concurrent, async (view) => {
      await update(view, monthChart([...months, nextMonth]));
      await update(view, monthChart([]));
      assertDismissed(view);
    });
  });

  test(`R21 monthly: resize fallback removes its listener on unmount (${mode})`, async () => {
    const observer = g.ResizeObserver;
    delete g.ResizeObserver;
    const viewport = monthlyViewport(months);
    try {
      await render(
        monthChart(),
        concurrent,
        async () => {
          assert.equal(viewport.resizeListeners.size, 1);
          viewport.setWidth(108);
          await act(async () => viewport.resize());
          assert.equal(viewport.container.scrollLeft, viewport.maximum());
        },
        viewport.createNodeMock,
      );
      assert.equal(viewport.resizeListeners.size, 0);
    } finally {
      g.ResizeObserver = observer;
    }
  });
}

for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";
  test(`R20 history: focus A survives entering/leaving B and the chart (${mode})`, async () => {
    await render(
      chart(),
      concurrent,
      async (view, focusRequests, blurRequests) => {
        const [a, b] = dates;
        await act(async () => button(view, a).props.onFocus());
        assertSelected(view, a);
        await act(async () => button(view, b).props.onMouseEnter());
        assertSelected(view, a);
        await act(async () => button(view, b).props.onMouseLeave());
        assertSelected(view, a);
        await act(async () => group(view).props.onMouseLeave());
        assertSelected(view, a);
        await act(async () => button(view, b).props.onMouseEnter());
        await act(async () => button(view, a).props.onBlur());
        assertSelected(view, b);
        assert.deepEqual(focusRequests, []);
        assert.deepEqual(blurRequests, []);
      },
    );
  });

  test(`R20 history: pin > focus > hover, independent releases and no synthetic focus (${mode})`, async () => {
    await render(chart(), concurrent, async (view) => {
      const [hover, focus, pin, next] = dates;
      await act(async () => {
        button(view, hover).props.onMouseEnter();
        button(view, focus).props.onFocus();
        button(view, pin).props.onClick();
      });
      assertSelected(view, pin, true);
      await act(async () => {
        button(view, next).props.onMouseEnter();
        button(view, hover).props.onMouseLeave();
      });
      assertSelected(view, pin, true);
      await act(async () => button(view, pin).props.onClick());
      assertSelected(view, focus);
      await act(async () => button(view, focus).props.onBlur());
      assertSelected(view, next);
      await act(async () => {
        button(view, next).props.onFocus();
        button(view, focus).props.onBlur();
        group(view).props.onMouseLeave();
      });
      assertSelected(view, next);
      await act(async () => button(view, next).props.onBlur());
      assertDismissed(view);
      // Click alone must not manufacture either a focus or a hover identity.
      await act(async () => button(view, pin).props.onClick());
      assertSelected(view, pin, true);
      await act(async () => button(view, pin).props.onClick());
      assertDismissed(view);
    });
  });

  for (const event of ["onFocus", "onMouseEnter", "onClick"] as const) {
    test(`R20 history: ${event} follows the date across shifts and new values (${mode})`, async () => {
      await render(chart(), concurrent, async (view) => {
        const date = dates[1];
        const retained = button(view, date);
        await act(async () => retained.props[event]());
        const shifted = [
          ...initial.slice(1),
          { date: "2026-11-03", value: 500 },
        ];
        await update(view, chart(shifted));
        assert.equal(button(view, date), retained);
        assertSelected(view, date, event === "onClick");
        await update(
          view,
          chart(shifted.map((day) => ({ ...day, value: 1234567 }))),
        );
        assertSelected(view, date, event === "onClick");
        assert.equal(
          text(reading(view).findByType("strong")),
          "1,234,567 Tokens",
        );
        assert.equal(
          button(view, date).props["aria-label"],
          `${date}：1,234,567 Tokens`,
        );
        await update(
          view,
          chart(shifted.map((day) => ({ ...day, value: null }))),
        );
        assertSelected(view, date, event === "onClick");
        assert.equal(
          text(reading(view).findByType("strong")),
          "未取得（不代表零）",
        );
        assert.equal(
          button(view, date).props["aria-label"],
          `${date}：未取得（不代表零）`,
        );
      });
    });
  }

  test(`R20 history: removed dates fall back, empty data and reentry never revive state (${mode})`, async () => {
    await render(chart(), concurrent, async (view, focusRequests) => {
      const [hover, focus, pin] = dates;
      await act(async () => {
        button(view, hover).props.onMouseEnter();
        button(view, focus).props.onFocus();
        button(view, pin).props.onClick();
      });
      assertSelected(view, pin, true);
      let remaining = initial.filter((day) => day.date !== pin);
      await update(view, chart(remaining));
      assertSelected(view, focus);
      remaining = remaining.filter((day) => day.date !== focus);
      await update(view, chart(remaining));
      assertSelected(view, hover);
      remaining = remaining.filter((day) => day.date !== hover);
      await update(view, chart(remaining));
      assertDismissed(view);
      await update(view, chart());
      assertDismissed(view);
      await act(async () => {
        button(view, hover).props.onMouseEnter();
        button(view, focus).props.onFocus();
        button(view, pin).props.onClick();
      });
      await update(view, chart([]));
      assertDismissed(view);
      assert.equal(group(view).findAllByType("button").length, 0);
      assert.equal(
        text(view.root.findByProps({ className: "history-axis" })),
        "",
      );
      await update(view, chart());
      assertDismissed(view);
      assert.deepEqual(
        focusRequests,
        [],
        "data removal must not relocate focus",
      );
    });
  });

  test(`R20 history: Escape dismisses without moving focus; arrows use current dates (${mode})`, async () => {
    await render(
      chart(),
      concurrent,
      async (view, focusRequests, blurRequests) => {
        const [a, b, c] = dates;
        await act(async () => {
          button(view, a).props.onFocus();
          button(view, b).props.onMouseEnter();
          button(view, c).props.onClick();
        });
        assert.equal(await key(button(view, a), "Escape"), true);
        assertDismissed(view);
        assert.deepEqual(focusRequests, []);
        assert.deepEqual(blurRequests, []);
        assert.equal(await key(button(view, a), "ArrowRight"), true);
        assert.deepEqual(focusRequests, [button(view, b).props["aria-label"]]);
        assertDismissed(view); // A focus request is not an actual focus event.
        await act(async () => button(view, b).props.onFocus());
        assertSelected(view, b);
        await update(view, chart([initial[2], initial[1], initial[0]]));
        assertSelected(view, b);
        await key(button(view, b), "ArrowLeft");
        assert.equal(focusRequests.at(-1), button(view, c).props["aria-label"]);
        assertSelected(view, b);
        await act(async () => {
          button(view, b).props.onBlur();
          button(view, c).props.onFocus();
        });
        assertSelected(view, c);
        await key(button(view, c), "ArrowLeft");
        assert.equal(focusRequests.at(-1), button(view, c).props["aria-label"]);
        await update(view, chart([initial[2], initial[0]]));
        await key(button(view, c), "ArrowRight");
        assert.equal(focusRequests.at(-1), button(view, a).props["aria-label"]);
        await key(button(view, a), "ArrowRight");
        assert.equal(focusRequests.at(-1), button(view, a).props["aria-label"]);
        const count = focusRequests.length;
        assert.equal(await key(button(view, c), "Tab"), false);
        assert.equal(await key(button(view, c), "Enter"), false);
        assert.equal(await key(button(view, c), " "), false);
        assert.equal(focusRequests.length, count);
        assert.deepEqual(blurRequests, []);
      },
    );
  });

  test(`R20 history: amount precision, zero/unknown, monthly and accessible names stay intact (${mode})`, async () => {
    const days = [
      { date: "2025-11-01", value: 1234.567891 },
      { date: "2026-11-01", value: 0 },
      { date: "2026-12-01", value: null },
    ];
    await render(
      chart(days, { metric: "cost", monthly: true }),
      concurrent,
      async (view) => {
        assert.equal(group(view).props["aria-label"], "每月趋势数据");
        const status = reading(view);
        assert.equal(status.props.role, "status");
        assert.equal(status.props["aria-live"], "polite");
        assert.equal(status.props["aria-atomic"], true);
        const expectedValues = ["¥1,234.567891", "¥0.00", "未取得（不代表零）"];
        for (const [index, expected] of expectedValues.entries()) {
          const target = button(view, days[index].date);
          assert.equal(
            target.props["aria-label"],
            `${days[index].date}：${expected}`,
          );
          assert.equal(target.props.type, "button");
          assert.equal(target.findByType("i").props["aria-hidden"], true);
          await act(async () => target.props.onFocus());
          assert.equal(text(reading(view).findByType("strong")), expected);
        }
        await update(view, <HistoryTrend days={days} metric="cost" monthly />);
        assert.equal(
          group(view).findAllByType("button")[0].props["aria-label"],
          "2025-11：¥1,234.567891",
        );
        await update(view, <HistoryTrend days={days} metric="cost" />);
        assert.equal(group(view).props["aria-label"], "每日趋势数据");
        assert.equal(
          group(view).findAllByType("button")[0].props["aria-label"],
          "11/1：¥1,234.567891",
        );
      },
    );
  });
}

const raw = (tokens: number): RawModelUsage => ({
  model: "history-test-model",
  groupKey: null,
  totalTokens: tokens,
  cost: tokens / 100,
  requestCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  responseTokens: tokens,
  otherTokens: 0,
});
g.__settingsListeners = new Map();
g.__settingsIpc = async (
  command: string,
  args: { month: number; year: number },
) => {
  assert.equal(command, "fetch_usage");
  const month = `${args.year}-${String(args.month).padStart(2, "0")}`;
  return {
    schemaVersion: 2,
    models: [],
    rawModels: [raw(30)],
    days: [
      { date: `${month}-01`, rawModels: [raw(10)] },
      { date: `${month}-02`, rawModels: [raw(20)] },
    ] as UsageResult["days"],
    monthCost: 0.3,
  } satisfies UsageResult;
};
const flush = async () => {
  for (let index = 0; index < 100; index++) await Promise.resolve();
};
for (const concurrent of [false, true]) {
  test(`R20 history: production HistoryPanel renders the mixed-input fix (${concurrent ? "concurrent" : "legacy"})`, async () => {
    historyCache.invalidate();
    await render(
      <HistoryPanel onBack={() => {}} />,
      concurrent,
      async (view) => {
        await act(flush);
        const reproduce = async () => {
          const [a, b] = group(view)
            .findAllByType("button")
            .filter(
              (node: any) => !node.props["aria-label"].includes("未取得"),
            );
          assert.ok(a && b, "production chart exposes two returned dates");
          const expected = a.props["aria-label"].split("：");
          await act(async () => a.props.onFocus());
          await act(async () => b.props.onMouseEnter());
          assert.equal(
            text(reading(view).findAllByType("span")[0]),
            expected[0],
          );
          assert.equal(text(reading(view).findByType("strong")), expected[1]);
          await act(async () => {
            b.props.onMouseLeave();
            group(view).props.onMouseLeave();
          });
          assert.equal(
            text(reading(view).findAllByType("span")[0]),
            expected[0],
          );
          assert.match(a.props.className, /\bactive\b/);
          assert.doesNotMatch(b.props.className, /\bactive\b/);
        };
        const click = async (label: string) => {
          await act(async () => {
            view.root
              .findAllByType("button")
              .find((node: any) => text(node) === label)
              .props.onClick();
            await flush();
          });
          await act(flush);
        };
        await reproduce();
        await click("费用");
        await reproduce();
        await click("全部");
        assert.equal(group(view).props["aria-label"], "每月趋势数据");
        await reproduce();
        await click("Tokens");
        await reproduce();
      },
    );
  });
}
