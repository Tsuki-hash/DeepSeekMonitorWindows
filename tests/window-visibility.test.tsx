import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { setCommittedConfig } from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";
import { todayStr } from "../src/format";
import type { AppConfig, UsageResult } from "../src/types";

// R29: real App, native-listener registration and IPC controlled independently.
// These are synthetic renderer tests, NOT Windows/WebView2, real DOM focus,
// browser event ordering or createRoot StrictEffects replay evidence. Both
// renderer modes and explicit unmount/remount exercise cleanup ownership only.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
type Callback = (event: any) => void;
const documentEvents = new Map<string, Set<Callback>>();
const windowEvents = new Map<string, Set<Callback>>();
function add(
  map: Map<string, Set<Callback>>,
  name: string,
  callback: Callback,
) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name)!.add(callback);
}
function dispatch(map: Map<string, Set<Callback>>, name: string, event = {}) {
  for (const callback of [...(map.get(name) ?? [])]) callback(event);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let id = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
const frames = new Map<number, () => void>();
const focusLog: string[] = [];
const body = {};
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
let renderer: any = null;
function hosts(): any[] {
  if (!renderer) return [];
  return renderer.root.findAll((node: any) => typeof node.type === "string");
}
function nodeText(node: any): string {
  return typeof node === "string"
    ? node
    : (node.children?.map(nodeText).join("") ?? "");
}
const stage = {
  get isConnected() {
    return renderer !== null;
  },
  querySelector: () => {
    const heading = hosts().find((node) => node.type === "h1");
    if (!heading) return null;
    const element = {
      isConnected: true,
      setAttribute: noop,
      focus() {
        focusLog.push(nodeText(heading));
        g.document.activeElement = element;
        dispatch(documentEvents, "focusin", { target: element });
      },
    };
    return element;
  },
};
g.window = {
  setTimeout: (callback: () => void, delay: number) => {
    const next = ++id;
    timers.set(next, {
      callback: () => {
        timers.delete(next);
        callback();
      },
      delay,
    });
    return next;
  },
  clearTimeout: (timer: number) => timers.delete(timer),
  setInterval: () => ++id,
  clearInterval: noop,
  requestAnimationFrame: (callback: () => void) => {
    const next = ++id;
    frames.set(next, callback);
    return next;
  },
  cancelAnimationFrame: (frame: number) => frames.delete(frame),
  addEventListener: (name: string, callback: Callback) =>
    add(windowEvents, name, callback),
  removeEventListener: (name: string, callback: Callback) =>
    windowEvents.get(name)?.delete(callback),
};
g.document = {
  body,
  activeElement: body,
  visibilityState: "visible",
  hasFocus: () => true,
  documentElement: {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    style: { getPropertyValue: () => "", setProperty: noop },
  },
  addEventListener: (name: string, callback: Callback) =>
    add(documentEvents, name, callback),
  removeEventListener: (name: string, callback: Callback) =>
    documentEvents.get(name)?.delete(callback),
};
g.localStorage = {
  getItem: (name: string) => storage.get(name) ?? null,
  setItem: (name: string, value: string) => storage.set(name, value),
  removeItem: (name: string) => storage.delete(name),
};
g.__settingsListeners = new Map<string, Set<Callback>>();

const visibilityNames = ["main-window-shown", "main-window-hidden"] as const;
type Registration = {
  name: string;
  callback: Callback;
  released: number;
  settled: boolean;
  accept: () => void;
  reject: () => void;
};
const registrations: Registration[] = [];
g.__settingsListen = (name: string, callback: Callback) => {
  if (!visibilityNames.includes(name as any)) {
    add(g.__settingsListeners, name, callback);
    return Promise.resolve(() =>
      g.__settingsListeners.get(name)?.delete(callback),
    );
  }
  const result = deferred<() => void>();
  const registration: Registration = {
    name,
    callback,
    released: 0,
    settled: false,
    accept() {
      assert.equal(registration.settled, false);
      registration.settled = true;
      add(g.__settingsListeners, name, callback);
      result.resolve(() => {
        registration.released += 1;
        g.__settingsListeners.get(name)?.delete(callback);
      });
    },
    reject() {
      assert.equal(registration.settled, false);
      registration.settled = true;
      result.reject(new Error("Synthetic listener registration rejection"));
    },
  };
  registrations.push(registration);
  return result.promise;
};

let revision = 0;
let config: AppConfig;
let nativeVisible = true;
let queryCalls = 0;
let fetchCalls = 0;
let query: () => Promise<boolean>;
const sampleUsage = (): UsageResult => ({
  models: [
    {
      key: "flash",
      name: "Synthetic Flash",
      totalTokens: 1,
      requestCount: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      responseTokens: 1,
      otherTokens: 0,
      cost: 1,
    },
  ],
  days: [],
  monthCost: 1,
});
g.__settingsIpc = async (command: string) => {
  switch (command) {
    case "get_app_config":
      return { ...config };
    case "fetch_balance":
      fetchCalls += 1;
      return {
        isAvailable: true,
        currency: "CNY",
        totalBalance: "3",
        grantedBalance: "0",
        toppedUpBalance: "3",
      };
    case "fetch_usage":
      fetchCalls += 1;
      return sampleUsage();
    case "is_main_window_visible":
      queryCalls += 1;
      return query();
    case "begin_tray_balance_session":
      return 1;
    case "update_tray_balance":
      return true;
    default:
      return null;
  }
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}
async function change(action: () => void) {
  await act(async () => action());
  await flush();
}
async function mount(concurrent: boolean) {
  await act(async () => {
    renderer = Renderer.create(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
      {
        unstable_isConcurrent: concurrent,
        createNodeMock: (element: any) =>
          element.props.className?.startsWith("stage ")
            ? stage
            : {
                scrollTo: noop,
                scrollIntoView: noop,
                focus: noop,
                setAttribute: noop,
                querySelector: () => null,
              },
      } as any,
    );
  });
  await flush();
}
async function unmount() {
  await act(async () => renderer.unmount());
  renderer = null;
  g.document.activeElement = body;
  await flush();
}
const scheduled = () =>
  [...timers.values()].filter((timer) => timer.delay === 60_000);
// At the beginning of a month, fetchCurrentUsage also requests the previous
// month for its 7-day chart. Do not mistake that existing behavior for a repeat.
const refreshFetchCount = () => (Number(todayStr().slice(8)) <= 6 ? 3 : 2);
const listening = () =>
  visibilityNames.map((name) => g.__settingsListeners.get(name)?.size ?? 0);
const errorShown = () =>
  hosts().some(
    (node) =>
      node.type === "strong" && nodeText(node) === "无法确认窗口显隐状态",
  );
function nativeChange(visible: boolean) {
  nativeVisible = visible;
  dispatch(g.__settingsListeners, visibilityNames[visible ? 0 : 1]);
}
async function acceptBoth(start = registrations.length - 2) {
  await change(() => {
    registrations[start].accept();
    registrations[start + 1].accept();
  });
}
async function drainFrames() {
  await change(() => {
    for (const [frame, callback] of [...frames]) {
      frames.delete(frame);
      callback();
    }
  });
}
async function probeFocus(visible: boolean) {
  const detail = renderer.root.findAllByType(ModelDetailPanel)[0];
  if (detail) {
    await change(() => detail.props.onBack());
    await drainFrames();
  }
  g.document.activeElement = body;
  await change(() =>
    renderer.root.findByType(DashboardPanel).props.onDetail("flash"),
  );
  focusLog.length = 0;
  await drainFrames();
  assert.equal(
    focusLog.length,
    visible ? 1 : 0,
    "Native visibility gates navigation focus",
  );
  assert.equal(
    scheduled().length,
    visible ? 2 : 0,
    "Native visibility gates both refresh schedulers",
  );
}
async function retry() {
  const button = hosts().find(
    (node) => node.type === "button" && nodeText(node) === "重试窗口状态",
  );
  assert.ok(button, "An explicit recovery action must remain available");
  await change(() => button.props.onClick());
}
function scenario(
  name: string,
  bodyOfTest: (concurrent: boolean) => Promise<void>,
) {
  for (const concurrent of [false, true]) {
    const mode = concurrent ? "concurrent" : "legacy";
    test(`R29 synthetic visibility (${mode}): ${name}`, async () => {
      setCommittedConfig(null);
      invalidateUsageRequests();
      config = {
        configRevision: ++revision,
        apiKeyRevision: revision,
        usageTokenRevision: revision,
        apiKeyConfigured: true,
        apiKeyPreview: "SYNTHETIC_ONLY",
        usageTokenConfigured: true,
        refreshIntervalSeconds: 60,
        autoRefreshEnabled: true,
        autostart: false,
        configPath: "SYNTHETIC_ONLY",
      };
      registrations.length = 0;
      queryCalls = 0;
      fetchCalls = 0;
      nativeVisible = true;
      query = async () => nativeVisible;
      focusLog.length = 0;
      attrs.clear();
      storage.clear();
      g.document.activeElement = body;
      try {
        await bodyOfTest(concurrent);
      } finally {
        if (renderer) await unmount();
        // Late resolves are delivered after unmount to prove they are released.
        await change(() => {
          for (const registration of registrations) {
            if (!registration.settled) registration.accept();
          }
        });
        assert.deepEqual(listening(), [0, 0]);
        assert.equal(
          timers.size,
          0,
          "Unmount must leave no scheduler/date polling",
        );
        assert.equal(frames.size, 0);
        assert.equal(
          [...documentEvents.values(), ...windowEvents.values()].some(
            (set) => set.size,
          ),
          false,
        );
      }
    });
  }
}

for (const visible of [false, true]) {
  scenario(`before listen: visible=${visible}`, async (concurrent) => {
    nativeVisible = !visible;
    await mount(concurrent);
    assert.equal(queryCalls, 0, "Do not query until BOTH listeners resolve");
    assert.equal(scheduled().length, 0);
    await change(() => nativeChange(visible));
    await acceptBoth();
    assert.equal(queryCalls, 1);
    await probeFocus(visible);
  });

  for (const first of [0, 1]) {
    scenario(`one listener (${first}): ${visible}`, async (concurrent) => {
      nativeVisible = !visible;
      await mount(concurrent);
      await change(() => registrations[first].accept());
      const before = fetchCalls;
      await change(() => nativeChange(visible));
      assert.equal(queryCalls, 0);
      assert.equal(
        fetchCalls,
        before,
        "A partial subscription may not trigger a show refresh",
      );
      assert.equal(scheduled().length, 0);
      await change(() => registrations[1 - first].accept());
      assert.equal(queryCalls, 1);
      await probeFocus(visible);
    });
  }

  scenario(`registered before query: ${visible}`, async (concurrent) => {
    nativeVisible = !visible;
    await mount(concurrent);
    await change(() => {
      registrations[0].accept();
      registrations[1].accept();
      nativeChange(visible);
      assert.equal(queryCalls, 0);
    });
    assert.equal(queryCalls, 1);
    await probeFocus(visible);
  });

  scenario(`late query loses to ${visible}`, async (concurrent) => {
    const pending = deferred<boolean>();
    query = () => pending.promise;
    await mount(concurrent);
    await acceptBoth();
    assert.equal(queryCalls, 1);
    assert.equal(
      scheduled().length,
      0,
      "Unknown initial visibility is fail-closed",
    );
    await change(() => nativeChange(visible));
    await change(() => pending.resolve(!visible));
    await probeFocus(visible);
  });
}

scenario("hide cancels timers/focus without replay", async (concurrent) => {
  await mount(concurrent);
  await acceptBoth();
  await change(() =>
    renderer.root.findByType(DashboardPanel).props.onDetail("flash"),
  );
  const oldFrames = [...frames.values()];
  const oldTimers = scheduled();
  assert.ok(oldFrames.length > 0);
  assert.equal(oldTimers.length, 2);
  const before = fetchCalls;
  await change(() => {
    // Deliver due callbacks in the very same turn as hidden, before React can
    // commit the false state and clean up the scheduler effects.
    nativeChange(false);
    oldFrames.forEach((callback) => callback());
    oldTimers.forEach((timer) => timer.callback());
  });
  assert.equal(
    fetchCalls,
    before,
    "Cancelled scheduler callbacks cannot fetch",
  );
  assert.equal(focusLog.length, 0);
  assert.equal(scheduled().length, 0);
  await change(() => nativeChange(true));
  assert.equal(
    fetchCalls,
    before + refreshFetchCount(),
    "A fully subscribed show refreshes both channels once",
  );
  await drainFrames();
  assert.equal(
    focusLog.length,
    0,
    "Shown must not resurrect a cancelled navigation",
  );
  assert.equal(scheduled().length, 2);
});

for (const firstResolved of [false, true]) {
  for (const rejected of [0, 1]) {
    const event = visibilityNames[rejected];
    const readiness = firstResolved ? "ready" : "pending";
    const name = `reject ${event}, peer ${readiness}: retry restores`;
    scenario(name, async (concurrent) => {
      await mount(concurrent);
      const peer = registrations[1 - rejected];
      if (firstResolved) await change(() => peer.accept());
      await change(() => registrations[rejected].reject());
      assert.equal(queryCalls, 0);
      assert.equal(errorShown(), true);
      assert.equal(scheduled().length, 0);
      if (!firstResolved) await change(() => peer.accept());
      assert.equal(peer.released, 1);
      assert.deepEqual(listening(), [0, 0]);
      const before = fetchCalls;
      await change(() =>
        registrations.slice(0, 2).forEach((slot) => slot.callback({})),
      );
      assert.equal(
        fetchCalls,
        before,
        "Even retained stale callbacks lose ownership",
      );
      await probeFocus(false);
      await retry();
      assert.equal(queryCalls, 0);
      assert.equal(errorShown(), false);
      await acceptBoth();
      assert.equal(queryCalls, 1);
      assert.deepEqual(listening(), [1, 1]);
      await probeFocus(true);
    });
  }
}

scenario("query failure retains manual recovery", async (concurrent) => {
  query = async () => {
    throw new Error("Synthetic visibility query failure");
  };
  await mount(concurrent);
  await acceptBoth();
  assert.equal(errorShown(), true);
  assert.deepEqual(listening(), [0, 0]);
  assert.deepEqual(
    registrations.map((slot) => slot.released),
    [1, 1],
  );
  assert.equal(scheduled().length, 0);
  const before = fetchCalls;
  await change(() => {
    void renderer.root.findByType(DashboardPanel).props.onRefresh();
  });
  assert.equal(fetchCalls, before + refreshFetchCount());
  query = async () => true;
  await retry();
  await acceptBoth();
  assert.equal(queryCalls, 2);
  assert.equal(errorShown(), false);
  await probeFocus(true);
});

scenario("query failure cannot revoke newer shown", async (concurrent) => {
  const pending = deferred<boolean>();
  query = () => pending.promise;
  await mount(concurrent);
  await acceptBoth();
  await change(() => nativeChange(true));
  await change(() => pending.reject(new Error("Late synthetic rejection")));
  assert.equal(errorShown(), false);
  assert.deepEqual(listening(), [1, 1]);
  await probeFocus(true);
});

scenario("unknown/hidden navigation never revives", async (concurrent) => {
  const pending = deferred<boolean>();
  query = () => pending.promise;
  await mount(concurrent);
  await acceptBoth();
  await change(() =>
    renderer.root.findByType(DashboardPanel).props.onDetail("flash"),
  );
  assert.equal(
    frames.size,
    0,
    "Unknown visibility may not retain a focus request",
  );
  await change(() => pending.resolve(true));
  await drainFrames();
  assert.equal(focusLog.length, 0);
  await change(() => nativeChange(false));
  await change(() => renderer.root.findByType(ModelDetailPanel).props.onBack());
  assert.equal(
    frames.size,
    0,
    "Hidden navigation may not retain a focus request",
  );
  await change(() => nativeChange(true));
  await drainFrames();
  assert.equal(focusLog.length, 0);
  await probeFocus(true);
});

for (const oldVisible of [false, true]) {
  scenario(`old lifecycle yields ${oldVisible}`, async (concurrent) => {
    const oldRead = deferred<boolean>();
    query = () => oldRead.promise;
    await mount(concurrent);
    await acceptBoth();
    const old = registrations.slice();
    await unmount();
    assert.deepEqual(
      old.map((slot) => slot.released),
      [1, 1],
    );
    nativeVisible = !oldVisible;
    query = async () => nativeVisible;
    await mount(concurrent);
    await acceptBoth();
    const before = fetchCalls;
    await change(() => {
      oldRead.resolve(oldVisible);
      old.forEach((slot) => slot.callback({}));
    });
    assert.equal(fetchCalls, before);
    assert.deepEqual(listening(), [1, 1]);
    await probeFocus(!oldVisible);
  });
}

scenario("unmount releases ready/late listeners", async (concurrent) => {
  await mount(concurrent);
  await change(() => registrations[0].accept());
  const old = registrations.slice();
  await unmount();
  assert.equal(old[0].released, 1);
  await mount(concurrent);
  await acceptBoth();
  const before = fetchCalls;
  await change(() => old[1].accept());
  assert.equal(old[1].released, 1);
  assert.equal(queryCalls, 1);
  await change(() => old.forEach((slot) => slot.callback({})));
  assert.equal(fetchCalls, before);
  assert.deepEqual(listening(), [1, 1]);
  await probeFocus(true);
});

scenario("late rejection and repeated remounts", async (concurrent) => {
  await mount(concurrent);
  const abandoned = registrations.slice();
  await unmount();
  await change(() => {
    abandoned[0].reject();
    abandoned[1].accept();
  });
  assert.equal(queryCalls, 0);
  assert.equal(abandoned[1].released, 1);
  for (let round = 0; round < 3; round++) {
    await mount(concurrent);
    await acceptBoth();
    assert.deepEqual(listening(), [1, 1]);
    assert.equal(scheduled().length, 2);
    await unmount();
    assert.deepEqual(listening(), [0, 0]);
    assert.equal(timers.size, 0);
  }
  assert.equal(queryCalls, 3);
});

// Source contracts complement the synthetic IPC rejection scenarios above.
// They do not execute Rust, create a native window or validate browser layout.
test("R29 native visibility error contract", () => {
  const source = readFileSync("src-tauri/src/commands.rs", "utf8");
  const command = source.slice(
    source.indexOf("pub(crate) fn is_main_window_visible"),
    source.indexOf("/// 面板尺寸模式。"),
  );
  assert.match(command, /-> Result<bool, String>/);
  assert.match(command, /require_main\(&window\)\?/);
  assert.match(
    command,
    /\.is_visible\(\)\s*\.map_err\(\|_\| "无法读取窗口显隐状态"\.to_string\(\)\)/,
  );
  assert.equal(command.includes("unwrap_or"), false);
  assert.equal(command.includes("e.to_string()"), false);
});

test("R29 visibility recovery has a separate scrollable row", () => {
  const css = readFileSync("src/styles.css", "utf8");
  assert.match(
    css,
    /\.stage\.visibility-unavailable\s*\{\s*grid-template-rows:\s*auto minmax\(0, 1fr\)/,
  );
  assert.match(
    css,
    /\.stage\.visibility-unavailable\.with-navigation\s*\{\s*grid-template-rows:\s*auto minmax\(0, 1fr\) 48px/,
  );
  assert.match(
    css,
    /\.stage > \.visibility-error\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*max-height:\s*35vh;[^}]*overflow-y:\s*auto/,
  );
  assert.match(
    css,
    /\.stage\.visibility-unavailable > \.settings-panel\s*\{[^}]*grid-area:\s*2 \/ 1;[^}]*height:\s*100%;[^}]*overflow-y:\s*auto/,
  );
  assert.match(
    css,
    /\.stage\.visibility-unavailable > \.primary-navigation\s*\{\s*grid-area:\s*3 \/ 1/,
  );
});
