import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import {
  StackedBarChart,
  type StackedPoint,
} from "../src/components/StackedBarChart";
import type { LoadState } from "../src/types";

// Synthetic React events and source contracts only. These tests do not execute
// browser layout, DOM focus, real Enter/Space activation, scrolling or Windows.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const keyListeners = new Set<(event: { key: string }) => void>();
g.document = {
  addEventListener: (name: string, fn: (event: { key: string }) => void) => {
    if (name === "keydown") keyListeners.add(fn);
  },
  removeEventListener: (name: string, fn: (event: { key: string }) => void) => {
    if (name === "keydown") keyListeners.delete(fn);
  },
};
const dates = [
  "2026-10-26",
  "2026-10-27",
  "2026-10-28",
  "2026-10-29",
  "2026-10-30",
  "2026-10-31",
  "2026-11-01",
];
const point = (date: string, value = 10): StackedPoint => ({
  date,
  hit: value,
  miss: 2,
  response: 3,
  other: 4,
  total: value + 9,
});
const initial = dates.map((date, index) => point(date, 10 + index));
const shifted = [...initial.slice(1), point("2026-11-02", 20)];
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
const button = (view: any, date: string) =>
  view.root
    .findAllByType("button")
    .find((node: any) => node.props["aria-label"]?.startsWith(`${date}：`));
const inspector = (view: any) =>
  view.root.findByProps({ className: "chart-inspector" });
const assertActive = (view: any, date: string, pinned = false) => {
  const head = inspector(view).findByProps({
    className: "chart-inspector-head",
  });
  const [, month, day] = date.split("-");
  assert.equal(
    text(head.findByType("span")),
    `${Number(month)}/${Number(day)}${pinned ? " · 已固定" : ""}`,
  );
  assert.match(button(view, date).parent.props.className, /\bhovered\b/);
  assert.equal(button(view, date).props["aria-pressed"], pinned);
};
const assertDismissed = (view: any) => {
  assert.equal(
    inspector(view).findAllByProps({ className: "chart-inspector-head" })
      .length,
    0,
  );
  assert.ok(text(inspector(view)).includes("点选日期固定明细"));
  for (const node of view.root.findAllByType("button")) {
    assert.equal(node.props["aria-pressed"], false);
    assert.doesNotMatch(node.parent.props.className, /\bhovered\b/);
  }
};

async function render(
  element: React.ReactElement,
  concurrent: boolean,
  inspect: (view: any) => Promise<void>,
) {
  let view: any;
  await act(async () => {
    view = Renderer.create(<React.StrictMode>{element}</React.StrictMode>, {
      unstable_isConcurrent: concurrent,
    });
  });
  try {
    await inspect(view);
  } finally {
    await act(async () => view.unmount());
    assert.equal(keyListeners.size, 0, "Escape listeners must be released");
  }
}

for (const variant of ["summary", "detail"] as const) {
  for (const concurrent of [false, true]) {
    const mode = `${variant}, ${concurrent ? "concurrent" : "legacy"}`;
    const chart = (points: StackedPoint[]) => (
      <StackedBarChart points={points} variant={variant} hasOther />
    );
    const update = async (view: any, points: StackedPoint[]) => {
      await act(async () => {
        view.update(<React.StrictMode>{chart(points)}</React.StrictMode>);
      });
    };

    for (const event of ["onFocus", "onMouseEnter"] as const) {
      test(`R18: ${event} follows date identity across a month boundary (${mode})`, async () => {
        await render(chart(initial), concurrent, async (view) => {
          const date = "2026-10-31";
          const retainedButton = button(view, date);
          await act(async () => retainedButton.props[event]());
          assertActive(view, date);

          // The date's array index changes from 5 to 4 without another event.
          await update(view, shifted);
          assert.equal(button(view, date), retainedButton);
          assertActive(view, date);
          assert.equal(inspector(view).props["aria-live"], "polite");
          // ARIA 属性值是字符串；组件按规范传 "true"，断言布尔会永远失败。
          assert.equal(inspector(view).props["aria-atomic"], "true");
          assert.doesNotMatch(
            button(view, "2026-11-01").parent.props.className,
            /\bhovered\b/,
          );

          // A fresh array with updated values keeps the date, not stale values.
          await update(
            view,
            shifted.map((item) =>
              item.date === date ? point(date, 81) : { ...item },
            ),
          );
          assertActive(view, date);
          assert.ok(button(view, date).props["aria-label"].includes("合计 90"));
          assert.ok(text(inspector(view)).includes("90 Tokens"));

          await update(
            view,
            shifted.map((item) =>
              item.date === date ? { ...item, unavailable: true } : item,
            ),
          );
          assertActive(view, date);
          assert.ok(text(inspector(view)).includes("数据待取得"));
        });
      });
    }

    test(`R18: pin, focus and hover retain priority after refresh (${mode})`, async () => {
      await render(chart(initial), concurrent, async (view) => {
        const hoverDate = "2026-10-28";
        const focusDate = "2026-10-29";
        const pinDate = "2026-10-30";
        await act(async () => button(view, hoverDate).props.onMouseEnter());
        assertActive(view, hoverDate);
        await act(async () => button(view, focusDate).props.onFocus());
        assertActive(view, focusDate);
        await act(async () => button(view, pinDate).props.onClick());
        assertActive(view, pinDate, true);
        await update(view, shifted);
        assertActive(view, pinDate, true);

        await act(async () => button(view, pinDate).props.onClick());
        assertActive(view, focusDate);
        await act(async () => button(view, focusDate).props.onBlur());
        assertActive(view, hoverDate);
        await act(async () => button(view, hoverDate).props.onMouseLeave());
        assertDismissed(view);
      });
    });

    test(`R18: removed dates fall back by priority and never revive (${mode})`, async () => {
      await render(chart(initial), concurrent, async (view) => {
        const [hoverDate, focusDate, pinDate] = dates.slice(0, 3);
        await act(async () => {
          button(view, hoverDate).props.onMouseEnter();
          button(view, focusDate).props.onFocus();
          button(view, pinDate).props.onClick();
        });
        assertActive(view, pinDate, true);

        let remaining = initial.filter((item) => item.date !== pinDate);
        await update(view, remaining);
        assertActive(view, focusDate);
        assert.equal(keyListeners.size, 0);
        remaining = remaining.filter((item) => item.date !== focusDate);
        await update(view, remaining);
        assertActive(view, hoverDate);
        remaining = remaining.filter((item) => item.date !== hoverDate);
        await update(view, remaining);
        assertDismissed(view);

        await update(view, initial);
        assertDismissed(view);
        await act(async () => button(view, focusDate).props.onFocus());
        assertActive(view, focusDate);
        await update(view, []);
        assertDismissed(view);
        await update(view, initial);
        assertDismissed(view);
      });
    });

    test(`R18: Escape dismisses all layers locally and outside a pinned chart (${mode})`, async () => {
      await render(chart(initial), concurrent, async (view) => {
        const [hoverDate, focusDate, pinDate] = dates;
        const activate = async () =>
          act(async () => {
            button(view, hoverDate).props.onMouseEnter();
            button(view, focusDate).props.onFocus();
            button(view, pinDate).props.onClick();
          });
        await activate();
        let prevented = false;
        await act(async () =>
          button(view, focusDate).props.onKeyDown({
            key: "Escape",
            preventDefault: () => {
              prevented = true;
            },
          }),
        );
        assert.equal(prevented, true);
        assertDismissed(view);
        assert.equal(keyListeners.size, 0);

        await activate();
        assert.equal(keyListeners.size, 1);
        await act(async () => {
          for (const listener of [...keyListeners]) listener({ key: "Escape" });
        });
        assertDismissed(view);
        assert.equal(keyListeners.size, 0);
      });
    });
  }
}

for (const usageState of ["ok", "loading", "nokey", "error"] as LoadState[]) {
  test(`R18: detail content is inside a named scroll region, Back remains outside (${usageState})`, async () => {
    let backCalls = 0;
    let settingsCalls = 0;
    const error = "查询失败：" + "不可分隔的长错误信息".repeat(30);
    await render(
      <ModelDetailPanel
        model="flash"
        usage={null}
        usageState={usageState}
        usageError={usageState === "error" ? error : ""}
        onBack={() => {
          backCalls += 1;
        }}
        onSettings={() => {
          settingsCalls += 1;
        }}
      />,
      false,
      async (view) => {
        const panel = view.root.findByProps({ "data-testid": "detail-panel" });
        const region = view.root.findByProps({ className: "detail-scroll" });
        const back = view.root.findByProps({ "aria-label": "返回主面板" });
        assert.equal(region.parent, panel);
        assert.equal(region.props.role, "region");
        assert.equal(region.props.tabIndex, 0);
        assert.equal(region.props["aria-label"], "V4.1 Flash 用量详情");
        assert.equal(back.parent, panel);
        assert.equal(
          region.findAllByProps({ "aria-label": "返回主面板" }).length,
          0,
        );
        assert.equal(
          region.findAllByProps({ className: "card detail-hero" }).length,
          1,
        );
        assert.equal(
          region.findAllByProps({ className: "detail-metrics" }).length,
          1,
        );
        assert.equal(
          region.findAllByProps({ className: "card detail-chart" }).length,
          1,
        );
        await act(async () => back.props.onClick());
        assert.equal(backCalls, 1);
        if (usageState === "ok") {
          assert.equal(
            region.findAllByProps({ className: "detail-bar-slot" }).length,
            7,
          );
          assert.equal(
            region.findAllByProps({ "aria-live": "polite" }).length,
            1,
          );
        } else if (usageState === "nokey") {
          await act(async () =>
            region.findByProps({ className: "empty-settings" }).props.onClick(),
          );
          assert.equal(settingsCalls, 1);
        } else {
          assert.ok(
            text(region).includes(usageState === "error" ? error : "查询中…"),
          );
        }
      },
    );
  });
}

test("R18: detail CSS keeps a bounded scroll fallback and content-sized chart rows", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `Missing ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };
  assert.match(rule(".detail-scroll"), /min-height:\s*0;/);
  assert.match(rule(".detail-scroll"), /overflow:\s*auto;/);
  assert.match(rule(".detail-scroll"), /flex:\s*1;/);
  assert.match(rule(".detail-scroll > *"), /flex-shrink:\s*0;/);
  assert.match(rule(".detail-chart"), /flex:\s*1 0 auto;/);
  assert.match(rule(".detail-bars"), /min-height:\s*128px;/);
  assert.match(css, /\n\.detail-bar-column\s*\{[^}]*minmax\(80px, 1fr\)/);
  assert.match(rule(".detail-chart .chart-inspector"), /height:\s*auto;/);
});
