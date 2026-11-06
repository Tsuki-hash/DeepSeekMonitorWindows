import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PricingPeriodBadge } from "../src/components/PricingPeriodBadge";
import { StackedBarChart } from "../src/components/StackedBarChart";

// R31: actual production Badge + Chart, with synthetic host refs and events.
// Target React handlers run before document listeners, sharing defaultPrevented.
// This does not execute DOM bubbling, Tab/Enter defaults, WebView2 or Windows.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
type Listener = (event: any) => void;
const documentEvents = new Map<string, Set<Listener>>();
const windowEvents = new Map<string, Set<Listener>>();
const nativeEvents = new Map<string, Set<Listener>>();
const timers = new Map<number, () => void>();
let timerId = 0;
let view: any = null;
let nodes = new Map<any, HostNode>();
const focusCalls: HostNode[] = [];
const body = {};

function add(map: Map<string, Set<Listener>>, name: string, fn: Listener) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name)!.add(fn);
}
function hosts(): any[] {
  if (!view) return [];
  try {
    return view.root.findAll((node: any) => typeof node.type === "string");
  } catch {
    return [];
  }
}
class HostNode {
  constructor(readonly host: any) {}
  get isConnected() {
    return hosts().includes(this.host);
  }
  contains(other: unknown) {
    return (
      this.isConnected &&
      other instanceof HostNode &&
      other.isConnected &&
      this.host.findAll((node: any) => node === other.host).length > 0
    );
  }
  focus() {
    if (!this.isConnected || this.host.props.disabled) return;
    g.document.activeElement = this;
    focusCalls.push(this);
  }
}
function nodeFor(host: any): HostNode {
  assert.ok(host, "The requested host must exist in the production tree");
  if (!nodes.has(host)) nodes.set(host, new HostNode(host));
  return nodes.get(host)!;
}
function refMock(element: any) {
  // Bind once at attachment, not by old props after a state update. Wrappers
  // survive rerenders, while an identical remount has a different identity.
  const matches = hosts().filter(
    (node) => node.type === element.type && node.props === element.props,
  );
  assert.equal(matches.length, 1, "Every ref must bind to one current host");
  return nodeFor(matches[0]);
}
g.Node = HostNode;
g.document = {
  activeElement: body,
  addEventListener: (name: string, fn: Listener) =>
    add(documentEvents, name, fn),
  removeEventListener: (name: string, fn: Listener) =>
    documentEvents.get(name)?.delete(fn),
};
g.window = {
  setTimeout: (callback: () => void) => {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  },
  clearTimeout: (id: number) => timers.delete(id),
  addEventListener: (name: string, fn: Listener) => add(windowEvents, name, fn),
  removeEventListener: (name: string, fn: Listener) =>
    windowEvents.get(name)?.delete(fn),
};
g.__settingsListeners = nativeEvents;

const points = [
  {
    date: "2026-11-01",
    hit: 10,
    miss: 2,
    response: 3,
    other: 4,
    total: 19,
  },
];
const tree = () => (
  <>
    <PricingPeriodBadge />
    <StackedBarChart points={points} variant="summary" hasOther />
    <button type="button" data-testid="outside-control">
      外部操作
    </button>
  </>
);
const badge = () =>
  view.root
    .findAllByType("button")
    .find((node: any) =>
      node.props.className?.startsWith("pricing-period-badge"),
    );
const chartDate = () => view.root.findByProps({ className: "bar-slot" });
const outside = () =>
  view.root.findByProps({ "data-testid": "outside-control" });
const region = () =>
  view.root.findAllByProps({ role: "region", "aria-label": "峰谷计价说明" });
const assertClosed = () => {
  assert.equal(badge().props["aria-expanded"], false);
  assert.equal(badge().props["aria-controls"], undefined);
  assert.equal(region().length, 0);
};
const assertOpen = () => {
  assert.equal(badge().props["aria-expanded"], true);
  assert.equal(region().length, 1);
  assert.equal(badge().props["aria-controls"], region()[0].props.id);
};
async function focus(host: any) {
  await act(async () => {
    const previous = g.document.activeElement;
    if (previous instanceof HostNode && previous.isConnected) {
      previous.host.props.onBlur?.();
    }
    nodeFor(host).focus();
    host.props.onFocus?.();
  });
}
async function click(host: any) {
  await act(async () => host.props.onClick());
}
async function openBadge() {
  await focus(badge());
  await click(badge());
  assertOpen();
}
async function keyDown(
  host: any,
  key = "Escape",
  options: { prevented?: boolean; beforeDocument?: () => void } = {},
) {
  const nativeEvent = {
    key,
    target: nodeFor(host),
    defaultPrevented: options.prevented ?? false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  let delivered = 0;
  await act(async () => {
    // Preserve listeners installed at dispatch: React state updates must not
    // remove the Badge listener before this event reaches document.
    const listeners = [...(documentEvents.get("keydown") ?? [])];
    host.props.onKeyDown?.({
      key,
      target: nativeEvent.target,
      nativeEvent,
      get defaultPrevented() {
        return nativeEvent.defaultPrevented;
      },
      preventDefault: () => nativeEvent.preventDefault(),
    });
    options.beforeDocument?.();
    for (const listener of listeners) {
      delivered += 1;
      listener(nativeEvent);
    }
  });
  return { nativeEvent, delivered };
}
async function pointerDown(host: any) {
  await act(async () => {
    for (const listener of [...(documentEvents.get("pointerdown") ?? [])]) {
      listener({ target: nodeFor(host) });
    }
  });
}
async function render(concurrent: boolean, inspect: () => Promise<void>) {
  nodes = new Map();
  focusCalls.length = 0;
  g.document.activeElement = body;
  await act(async () => {
    // An empty committed renderer exists before ref attachment in both modes.
    view = Renderer.create(null, {
      unstable_isConcurrent: concurrent,
      createNodeMock: refMock,
    });
    view.update(<React.StrictMode>{tree()}</React.StrictMode>);
  });
  try {
    assert.equal(timers.size, 1);
    assert.equal(nativeEvents.get("main-window-shown")?.size, 1);
    await inspect();
  } finally {
    await act(async () => view.unmount());
    view = null;
    for (const map of [documentEvents, windowEvents, nativeEvents]) {
      for (const listeners of map.values()) assert.equal(listeners.size, 0);
    }
    assert.equal(timers.size, 0, "Pricing refresh timers must be released");
  }
}

for (const concurrent of [false, true]) {
  const mode = concurrent ? "concurrent" : "legacy";

  test(`R31: chart Escape bubbles without stealing focus or consuming the Badge (${mode})`, async () => {
    await render(concurrent, async () => {
      await openBadge();
      const date = chartDate();
      await focus(date); // Synthetic Tab movement, without an outside pointer.
      await click(date); // Models Enter's click, without executing native defaults.
      assert.equal(date.props["aria-pressed"], true);
      assertOpen();
      focusCalls.length = 0;

      const event = await keyDown(date);
      assert.equal(
        event.delivered,
        2,
        "Both Badge and pinned Chart receive it",
      );
      assert.equal(event.nativeEvent.defaultPrevented, true);
      assert.equal(date.props["aria-pressed"], false);
      assert.equal(
        view.root.findAllByProps({ className: "chart-inspector-head" }).length,
        0,
      );
      assert.equal(g.document.activeElement, nodeFor(date));
      assert.deepEqual(focusCalls, []);
      assertOpen(); // The Chart's handled Escape belongs to the Chart alone.
    });
  });

  test(`R31: unhandled outside Escape closes without taking focus (${mode})`, async () => {
    await render(concurrent, async () => {
      await openBadge();
      const control = outside();
      await focus(control);
      focusCalls.length = 0;
      const event = await keyDown(control);
      assert.equal(event.nativeEvent.defaultPrevented, false);
      assertClosed();
      assert.equal(g.document.activeElement, nodeFor(control));
      assert.deepEqual(focusCalls, []);
    });
  });

  test(`R31: Badge-owned Escape closes and restores its trigger (${mode})`, async () => {
    await render(concurrent, async () => {
      const trigger = nodeFor(badge());
      await openBadge();
      assert.equal(
        nodeFor(badge()),
        trigger,
        "The ref survives the open update",
      );
      focusCalls.length = 0;
      await keyDown(badge());
      assertClosed();
      assert.equal(g.document.activeElement, trigger);
      assert.deepEqual(
        focusCalls,
        [trigger],
        "A broken ref must not pass silently",
      );

      await openBadge();
      // Models focus moved into a future focusable descendant or by an AT.
      await focus(region()[0]);
      focusCalls.length = 0;
      await keyDown(region()[0]);
      assertClosed();
      assert.equal(g.document.activeElement, trigger);
      assert.deepEqual(focusCalls, [trigger]);
    });
  });

  test(`R31: defaultPrevented and non-Escape keys leave an open Badge alone (${mode})`, async () => {
    await render(concurrent, async () => {
      await openBadge();
      focusCalls.length = 0;
      await keyDown(badge(), "Escape", { prevented: true });
      assertOpen();
      await keyDown(badge(), "ArrowRight");
      assertOpen();
      assert.deepEqual(focusCalls, []);
      assert.equal(g.document.activeElement, nodeFor(badge()));
    });
  });

  test(`R31: focus moved before document handling is not restored by an old target (${mode})`, async () => {
    await render(concurrent, async () => {
      await openBadge();
      const control = nodeFor(outside());
      focusCalls.length = 0;
      await keyDown(badge(), "Escape", {
        beforeDocument: () => control.focus(),
      });
      assertClosed();
      assert.equal(g.document.activeElement, control);
      assert.deepEqual(focusCalls, [control]);

      await openBadge();
      focusCalls.length = 0;
      // Even when focus is inside, an outside event cannot claim ownership.
      await keyDown(outside());
      assertClosed();
      assert.equal(g.document.activeElement, nodeFor(badge()));
      assert.deepEqual(focusCalls, []);
    });
  });

  test(`R31: toggle, inside pointer, outside dismissal and listener cleanup stay intact (${mode})`, async () => {
    await render(concurrent, async () => {
      assertClosed();
      await openBadge();
      await pointerDown(region()[0]);
      assertOpen();
      await click(badge());
      assertClosed();
      assert.equal(documentEvents.get("keydown")?.size, 0);
      assert.equal(documentEvents.get("pointerdown")?.size, 0);

      await openBadge();
      await focus(outside());
      focusCalls.length = 0;
      await pointerDown(outside());
      assertClosed();
      assert.equal(g.document.activeElement, nodeFor(outside()));
      assert.deepEqual(focusCalls, []);
      await openBadge(); // Leave listeners installed for the unmount assertions.
    });
  });
}
