import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { HistoryTrend } from "../src/components/HistoryTrend";
import {
  setCommittedConfig,
  setConfigSubscriptionReady,
} from "../src/config-store";
import { fetchCurrentUsage, invalidateUsageRequests } from "../src/usage-api";
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
const usageCalls: string[] = [];
let usageRead: (month: string) => Promise<UsageResult>;
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
g.__settingsIpc = async (
  command: string,
  args?: { year: number; month: number },
) => {
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
    case "fetch_usage": {
      fetchCalls += 1;
      const month = `${args!.year}-${String(args!.month).padStart(2, "0")}`;
      usageCalls.push(month);
      return usageRead(month);
    }
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
/**
 * StrictMode 会挂载→卸载→重挂，每个方向可能留下多于一个 registration，
 * 按索引取会拿到同名的两个 `main-window-shown`（实测 names 为
 * shown,shown,hidden），于是 `Promise.all` 永远等不到 hidden，查询不触发。
 * 按事件名取**最后一个**未完成的 registration 才是当前挂载的那一个。
 */
function pendingByName(name: string) {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration.name === name && !registration.settled) {
      return registration;
    }
  }
  return undefined;
}
/**
 * 当前挂载对应的那一对注册（每个事件名取最后一次注册）。
 * StrictMode 的双挂载会留下更早的注册，断言不能按数组长度或固定索引。
 */
function currentRegistrations() {
  return visibilityNames
    .map((name) => {
      for (let index = registrations.length - 1; index >= 0; index -= 1) {
        if (registrations[index].name === name) return registrations[index];
      }
      return undefined;
    })
    .filter((slot): slot is Registration => slot != null);
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
      usageCalls.length = 0;
      usageRead = async () => sampleUsage();
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
      // 先只放行一个方向：shown 或 hidden（按事件名取，不按数组索引）。
      const accepted = visibilityNames[first];
      await change(() => pendingByName(accepted)?.accept());
      const before = fetchCalls;
      await change(() => nativeChange(visible));
      assert.equal(queryCalls, 0);
      assert.equal(
        fetchCalls,
        before,
        "A partial subscription may not trigger a show refresh",
      );
      assert.equal(scheduled().length, 0);
      // 放行另一个方向后，两路都就绪，才允许查询一次。
      await change(() => pendingByName(visibilityNames[1 - first])?.accept());
      assert.equal(queryCalls, 1);
      await probeFocus(visible);
    });
  }

  scenario(`registered before query: ${visible}`, async (concurrent) => {
    nativeVisible = !visible;
    await mount(concurrent);
    await change(() => {
      // 同一轮里放行两路并立刻投递原生事件：查询还没返回，事件已到，
      // 由 revision 保证结果不被旧查询覆盖。按事件名取当前挂载的注册。
      pendingByName(visibilityNames[0])?.accept();
      pendingByName(visibilityNames[1])?.accept();
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
      // StrictMode 重复注册：按事件名取当前挂载的那一对，避免索引错位。
      const peer = pendingByName(visibilityNames[1 - rejected]);
      const target = pendingByName(event);
      if (firstResolved) await change(() => peer?.accept());
      await change(() => target?.reject());
      assert.equal(queryCalls, 0);
      assert.equal(errorShown(), true);
      assert.equal(scheduled().length, 0);
      if (!firstResolved) await change(() => peer?.accept());
      assert.equal(peer?.released, 1);
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
  // 只核对当前挂载的那一对注册：StrictMode 会先挂载再重挂，
  // 早先一轮的注册不属于本次生命周期。
  assert.deepEqual(
    currentRegistrations().map((slot) => slot.released),
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
    // 只取当前挂载的那一对：StrictMode 的双挂载会留下更早的注册，
    // 把它们算进「旧生命周期」会让 released 计数与断言不符。
    const old = currentRegistrations();
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
  // 只放行 shown 方向：本场景验证「一个已就绪、另一个迟到」的释放。
  await change(() => pendingByName(visibilityNames[0])?.accept());
  const old = currentRegistrations();
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

const historyButton = (label: string) => {
  const node = hosts().find(
    (item) =>
      item.type === "button" &&
      (nodeText(item) === label || item.props["aria-label"] === label),
  );
  assert.ok(node, `Missing history action: ${label}`);
  return node;
};
const clickHistoryAction = async (label: string) => {
  const node = historyButton(label);
  assert.notEqual(node.props.disabled, true, `${label} must be available`);
  await change(() => node.props.onClick());
};
const previousMonth = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
};
const historyUsage = (month: string): UsageResult => {
  const raw = {
    model: "SYNTHETIC_HISTORY_ONLY",
    groupKey: null,
    totalTokens: 123,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: 123,
    otherTokens: 0,
    cost: 1,
  };
  return {
    schemaVersion: 2,
    models: [],
    rawModels: [raw],
    days: [{ date: `${month}-01`, rawModels: [raw] }] as UsageResult["days"],
    monthCost: 1,
  };
};
const historyDays = () =>
  structuredClone(renderer.root.findByType(HistoryTrend).props.days);

// R30: exercise production App -> HistoryPanel ownership, not a directly
// updated windowVisible prop. Concurrent act holds the React commit while the
// native callback and the IPC promise continuation run in the same turn.
for (const outcome of ["success", "failure"] as const) {
  for (const showAgain of [false, true]) {
    scenario(
      `R30 history hidden before commit: ${outcome}, shown=${showAgain}`,
      async (concurrent) => {
        await mount(concurrent);
        await acceptBoth();
        await clickHistoryAction("历史");
        const pending = deferred<UsageResult>();
        const blockedMonth = previousMonth(todayStr().slice(0, 7));
        const nextMonth = previousMonth(blockedMonth);
        let blockedLoads = 0;
        usageRead = async (month) => {
          if (month !== blockedMonth) return historyUsage(month);
          blockedLoads += 1;
          return pending.promise;
        };
        await clickHistoryAction("全部");
        assert.equal(
          blockedLoads,
          1,
          "The history deferred loader has started",
        );
        assert.equal(usageCalls.includes(nextMonth), false);
        const before = historyDays();
        await act(async () => {
          nativeChange(false);
          if (concurrent) {
            assert.equal(
              renderer.root.findByType(HistoryPanel).props.windowVisible,
              true,
              "The native hidden event precedes the React prop commit",
            );
          }
          if (showAgain) nativeChange(true);
          if (outcome === "success")
            pending.resolve(historyUsage(blockedMonth));
          else pending.reject({ code: "invalid_data" });
          for (let turn = 0; turn < 80; turn++) await Promise.resolve();
          assert.equal(
            usageCalls.includes(nextMonth),
            false,
            "Revoked history must not fetch its next month before commit",
          );
        });
        await flush();
        assert.equal(usageCalls.includes(nextMonth), false);
        assert.deepEqual(historyDays(), before, "Late history cannot commit");
        assert.match(
          nodeText(renderer.root.findByType(HistoryPanel)),
          /后续月份查询已停止/,
        );
        assert.equal(
          historyButton("重新查询历史").props.disabled,
          !showAgain,
          "A revoked batch releases busy even if hidden/shown are batched",
        );
        if (!showAgain) {
          assert.equal(
            historyButton("继续加载更早月份 ›").props.disabled,
            true,
          );
          await change(() => nativeChange(true));
          assert.deepEqual(historyDays(), before);
        }
        usageRead = async (month) => historyUsage(month);
        await clickHistoryAction("继续加载更早月份 ›");
        // Twelve serial monthly requests require more microtasks than the
        // ordinary visibility fixture. This does not advance native timers.
        await act(async () => {
          for (let turn = 0; turn < 400; turn++) await Promise.resolve();
        });
        assert.ok(
          usageCalls.includes(nextMonth),
          "A new explicit query can run",
        );
        assert.doesNotMatch(
          nodeText(renderer.root.findByType(HistoryPanel)),
          /后续月份查询已停止/,
        );
      },
    );
  }
}

scenario(
  "R30 retained history actions and custom month survive hidden",
  async (concurrent) => {
    await mount(concurrent);
    await acceptBoth();
    await clickHistoryAction("历史");
    const failedMonth = previousMonth(todayStr().slice(0, 7));
    usageRead = async (month) => {
      if (month === failedMonth) throw { code: "invalid_data" };
      return historyUsage(month);
    };
    await clickHistoryAction("全部");
    await act(async () => {
      for (let turn = 0; turn < 400; turn++) await Promise.resolve();
    });
    assert.equal(historyButton("只重试失败月份（1）").props.disabled, false);
    assert.equal(historyButton("继续加载更早月份 ›").props.disabled, false);
    const before = historyDays();
    await change(() => nativeChange(false));
    assert.equal(historyButton("只重试失败月份（1）").props.disabled, true);
    assert.equal(historyButton("继续加载更早月份 ›").props.disabled, true);
    assert.equal(historyButton("全部").props["aria-pressed"], true);
    assert.deepEqual(historyDays(), before);
    await change(() => nativeChange(true));
    assert.equal(historyButton("只重试失败月份（1）").props.disabled, false);
    assert.deepEqual(historyDays(), before);
    usageRead = async (month) => historyUsage(month);
    await clickHistoryAction("历史月份");
    const monthInput = () => renderer.root.findByProps({ type: "month" });
    await change(() =>
      monthInput().props.onChange({ target: { value: "2024-02" } }),
    );
    await change(() => nativeChange(false));
    assert.equal(monthInput().props.disabled, true);
    assert.equal(monthInput().props.value, "2024-02");
    const fixedCount = usageCalls.filter((month) => month === "2024-02").length;
    await change(() => nativeChange(true));
    assert.equal(monthInput().props.disabled, false);
    assert.equal(monthInput().props.value, "2024-02");
    assert.equal(
      usageCalls.filter((month) => month === "2024-02").length,
      fixedCount,
      "Showing a fixed historical month preserves its selection and cache",
    );
  },
);

scenario(
  "R30 retained manual history action cannot start before hidden commit",
  async (concurrent) => {
    await mount(concurrent);
    await acceptBoth();
    await clickHistoryAction("历史");
    const action = historyButton("重新查询历史");
    assert.equal(action.props.disabled, false);
    const before = usageCalls.length;
    await act(async () => {
      nativeChange(false);
      if (concurrent) {
        assert.equal(
          renderer.root.findByType(HistoryPanel).props.windowVisible,
          true,
        );
      }
      action.props.onClick();
      for (let turn = 0; turn < 80; turn++) await Promise.resolve();
      assert.equal(usageCalls.length, before);
    });
    await flush();
    assert.equal(usageCalls.length, before);
    assert.equal(historyButton("重新查询历史").props.disabled, true);
  },
);

scenario(
  "R30 initial unknown history is explained until ready",
  async (concurrent) => {
    await mount(concurrent);
    const before = usageCalls.length;
    await clickHistoryAction("历史");
    assert.equal(usageCalls.length, before);
    assert.equal(historyButton("重新查询历史").props.disabled, true);
    assert.equal(historyButton("全部").props.disabled, true);
    assert.match(
      nodeText(renderer.root.findByType(HistoryPanel)),
      /状态尚未确认/,
    );
    await acceptBoth();
    assert.equal(
      usageCalls.length,
      before + 1,
      "Readiness starts one history query",
    );
    assert.equal(historyButton("重新查询历史").props.disabled, false);
    assert.doesNotMatch(
      nodeText(renderer.root.findByType(HistoryPanel)),
      /状态尚未确认/,
    );
  },
);

for (const failure of ["shown", "hidden", "query"] as const) {
  scenario(
    `R30 history recovery after ${failure} failure`,
    async (concurrent) => {
      if (failure === "query") {
        query = async () => {
          throw new Error("Synthetic query failure");
        };
      }
      await mount(concurrent);
      if (failure === "query") await acceptBoth();
      else {
        // 按事件名选取：StrictMode 双挂载会让固定索引拿到错误方向。
        await change(() => {
          pendingByName(visibilityNames[failure === "shown" ? 0 : 1])?.reject();
          pendingByName(visibilityNames[failure === "shown" ? 1 : 0])?.accept();
        });
      }
      assert.equal(errorShown(), true);
      const before = usageCalls.length;
      await clickHistoryAction("历史");
      assert.equal(usageCalls.length, before);
      assert.equal(historyButton("重新查询历史").props.disabled, true);
      assert.equal(historyButton("全部").props.disabled, true);
      assert.match(
        nodeText(renderer.root.findByType(HistoryPanel)),
        /请先点击上方“重试窗口状态”/,
      );
      // 旧生命周期的注册：只取当前挂载那一对，StrictMode 残留不计入。
      const old = currentRegistrations();
      query = async () => true;
      await retry();
      assert.equal(historyButton("重新查询历史").props.disabled, true);
      await change(() => old.forEach((entry) => entry.callback({})));
      assert.equal(
        usageCalls.length,
        before,
        "Old callbacks cannot release history",
      );
      await acceptBoth();
      assert.equal(usageCalls.length, before + 1);
      assert.equal(historyButton("重新查询历史").props.disabled, false);
      await clickHistoryAction("重新查询历史");
      assert.equal(
        usageCalls.length,
        before + 2,
        "Manual refresh works after recovery",
      );
    },
  );
}

// Fix the accounting date only within these scenarios. They exercise the real
// App subscription -> request invalidation -> usage-api -> mocked IPC binding.
async function atMonthStart(bodyOfTest: () => Promise<void>) {
  const NativeDate = Date;
  const now = NativeDate.parse("2026-11-02T04:00:00Z");
  g.Date = class extends NativeDate {
    constructor(value?: any) {
      super(value === undefined ? now : value);
    }
    static now() {
      return now;
    }
  };
  try {
    await bodyOfTest();
  } finally {
    g.Date = NativeDate;
  }
}

for (const transition of ["account", "clear", "ready"] as const) {
  scenario(
    `R33 revoked month-start continuation: ${transition}`,
    (concurrent) =>
      atMonthStart(async () => {
        const oldCurrent = deferred<UsageResult>();
        const newCurrent = deferred<UsageResult>();
        const reads: Array<{ month: string; account: number }> = [];
        usageRead = (month) => {
          reads.push({ month, account: config.usageTokenRevision });
          if (reads.length === 1) return oldCurrent.promise;
          if (month === "2026-11") return newCurrent.promise;
          return Promise.resolve(sampleUsage());
        };
        await mount(concurrent);
        assert.deepEqual(usageCalls, ["2026-11"]);
        // Reusing this exported callback must join only the current generation.
        const retainedRead = fetchCurrentUsage;
        const old = retainedRead();
        const oldRejected = assert.rejects(() => old, /替代/);
        const oldAccount = config.usageTokenRevision;
        await change(() => {
          if (transition === "ready") {
            // A transient loss followed by recovery is still a new request owner.
            setConfigSubscriptionReady(false);
            setConfigSubscriptionReady(true);
          } else {
            config = {
              ...config,
              configRevision: ++revision,
              usageTokenRevision: revision,
              usageTokenConfigured: transition !== "clear",
            };
            setCommittedConfig(config);
          }
        });
        assert.equal(usageCalls.length, transition === "clear" ? 1 : 2);
        const fresh = transition === "clear" ? null : retainedRead();
        if (fresh) assert.notEqual(fresh, old);
        await change(() => oldCurrent.resolve(sampleUsage()));
        await oldRejected;
        assert.deepEqual(
          usageCalls,
          transition === "clear" ? ["2026-11"] : ["2026-11", "2026-11"],
          "An old current-month completion must not start any previous-month IPC",
        );
        assert.equal(reads[0].account, oldAccount);
        if (fresh) {
          assert.equal(
            retainedRead(),
            fresh,
            "Old cleanup must not release fresh work",
          );
          await change(() =>
            newCurrent.resolve({ ...sampleUsage(), monthCost: 22 }),
          );
          const result = await fresh;
          assert.equal(result.monthCost, 22);
          assert.deepEqual(usageCalls, ["2026-11", "2026-11", "2026-10"]);
          assert.equal(reads[2].account, config.usageTokenRevision);
          assert.equal(
            renderer.root.findByType(DashboardPanel).props.usage.monthCost,
            22,
            "Only the fresh account result may reach the dashboard",
          );
        } else {
          assert.equal(
            renderer.root.findByType(DashboardPanel).props.usage,
            null,
          );
        }
      }),
  );
}

for (const completion of ["resolve", "reject"] as const) {
  scenario(
    `R33 revoked previous-month ${completion} remains cancellation`,
    (concurrent) =>
      atMonthStart(async () => {
        const previous = deferred<UsageResult>();
        usageRead = (month) =>
          month === "2026-10"
            ? previous.promise
            : Promise.resolve(sampleUsage());
        await mount(concurrent);
        assert.deepEqual(usageCalls, ["2026-11", "2026-10"]);
        const old = fetchCurrentUsage();
        const rejected = assert.rejects(() => old, /替代/);
        await change(() => {
          config = {
            ...config,
            configRevision: ++revision,
            usageTokenRevision: revision,
            usageTokenConfigured: false,
          };
          setCommittedConfig(config);
        });
        await change(() => {
          if (completion === "resolve") previous.resolve(sampleUsage());
          else previous.reject(new Error("Synthetic previous-month failure"));
        });
        await rejected;
        assert.deepEqual(usageCalls, ["2026-11", "2026-10"]);
        assert.equal(
          renderer.root.findByType(DashboardPanel).props.usage,
          null,
        );
        assert.equal(
          renderer.root.findByType(DashboardPanel).props.usageState,
          "nokey",
        );
      }),
  );
}

scenario(
  "R33 owned previous-month failure still returns partial data",
  (concurrent) =>
    atMonthStart(async () => {
      const previous = deferred<UsageResult>();
      usageRead = (month) =>
        month === "2026-10" ? previous.promise : Promise.resolve(sampleUsage());
      await mount(concurrent);
      const request = fetchCurrentUsage();
      await change(() =>
        previous.reject(new Error("Synthetic network failure")),
      );
      const result = await request;
      assert.deepEqual(usageCalls, ["2026-11", "2026-10"]);
      assert.equal(result.monthCost, 1);
      assert.deepEqual(result.unavailableDates, [
        "2026-10-31",
        "2026-10-30",
        "2026-10-29",
        "2026-10-28",
        "2026-10-27",
      ]);
      assert.deepEqual(result.warnings, ["上月数据暂未获取，缺失日期标为未知"]);
    }),
);

function onlyTimer(delay: number) {
  const matches = [...timers.values()].filter((timer) => timer.delay === delay);
  assert.equal(matches.length, 1, `Expected one owned ${delay}ms timer`);
  return matches[0];
}

for (const code of [
  "credentials_invalid",
  "not_configured",
  "rate_limited",
  "unavailable",
  "config_read_error",
  "encryption_unavailable",
  "cancelled",
] as const) {
  scenario(`R34 previous-month ${code} propagates`, (concurrent) =>
    atMonthStart(async () => {
      const previous = deferred<UsageResult>();
      const failure = {
        code,
        message: `Synthetic previous-month ${code}`,
        credential: "usage_token",
        retryable: code === "rate_limited" || code === "unavailable",
      };
      usageRead = (month) =>
        month === "2026-10" ? previous.promise : Promise.resolve(sampleUsage());
      await mount(concurrent);
      const request = fetchCurrentUsage();
      const rejection = request.then(
        () => assert.fail("A channel failure must not become partial success"),
        (error) => error,
      );
      await acceptBoth();
      await change(() => previous.reject(failure));
      assert.equal(
        await rejection,
        failure,
        "Preserve the exact structured IPC error",
      );
      const props = renderer.root.findByType(DashboardPanel).props;
      assert.equal(props.usage, null);
      assert.equal(props.usageUpdatedAt, null);
      assert.equal(props.usageError, failure.message);
      assert.equal(
        props.usageState,
        code === "not_configured" ? "nokey" : "error",
      );
      assert.deepEqual(usageCalls, ["2026-11", "2026-10"]);
      if (code === "credentials_invalid" || code === "not_configured") {
        const paused = onlyTimer(300_000);
        await change(() => paused.callback());
        assert.deepEqual(
          usageCalls,
          ["2026-11", "2026-10"],
          "A paused usage channel must not call IPC when its probe timer runs",
        );
        onlyTimer(300_000);
      } else if (failure.retryable) {
        onlyTimer(120_000);
      }
    }),
  );
}

scenario("R34 previous-month 401 clears old data", (concurrent) =>
  atMonthStart(async () => {
    await mount(concurrent);
    await acceptBoth();
    assert.equal(
      renderer.root.findByType(DashboardPanel).props.usage.monthCost,
      1,
    );
    const failure = {
      code: "credentials_invalid",
      message: "Synthetic token rejection after current-month success",
      retryable: false,
    };
    usageRead = (month) =>
      month === "2026-10"
        ? Promise.reject(failure)
        : Promise.resolve({ ...sampleUsage(), monthCost: 99 });
    await change(() =>
      renderer.root.findByType(DashboardPanel).props.onRefresh(),
    );
    const props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(props.usageState, "error");
    assert.equal(props.usageError, failure.message);
    assert.equal(
      props.usage,
      null,
      "Neither the retained nor partial new snapshot stays usable",
    );
    assert.equal(props.usageUpdatedAt, null);
    const before = usageCalls.length;
    await change(() => onlyTimer(300_000).callback());
    assert.equal(usageCalls.length, before);
  }),
);

scenario("R34 previous-month 429 backs off until recovery", (concurrent) =>
  atMonthStart(async () => {
    await mount(concurrent);
    await acceptBoth();
    const old = renderer.root.findByType(DashboardPanel).props;
    const failure = {
      code: "rate_limited",
      message: "Synthetic previous-month rate limit",
      retryable: true,
    };
    usageRead = (month) =>
      month === "2026-10"
        ? Promise.reject(failure)
        : Promise.resolve({ ...sampleUsage(), monthCost: 99 });
    await change(() =>
      renderer.root.findByType(DashboardPanel).props.onRefresh(),
    );
    let props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(
      props.usageState,
      "ok",
      "A retained snapshot remains displayable as stale",
    );
    assert.equal(props.usageError, failure.message);
    assert.equal(
      props.usage,
      old.usage,
      "The new current-month-only result is not committed",
    );
    assert.equal(props.usageUpdatedAt, old.usageUpdatedAt);
    assert.equal(usageCalls.length, 4);
    await change(() => onlyTimer(120_000).callback());
    assert.equal(usageCalls.length, 6);
    onlyTimer(240_000);
    props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(props.usage, old.usage);
    assert.equal(props.usageError, failure.message);
    usageRead = async () => ({ ...sampleUsage(), monthCost: 22 });
    await change(() => onlyTimer(240_000).callback());
    props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(usageCalls.length, 8);
    assert.equal(props.usage.monthCost, 22);
    assert.equal(props.usageState, "ok");
    assert.equal(props.usageError, "");
    assert.equal(
      scheduled().length,
      2,
      "Recovery restores both base schedules",
    );
    assert.equal(
      [...timers.values()].some((timer) => timer.delay === 240_000),
      false,
    );
  }),
);

scenario("R34 old-account 429 cannot affect new success", (concurrent) =>
  atMonthStart(async () => {
    const previous = deferred<UsageResult>();
    let previousReads = 0;
    usageRead = (month) => {
      if (month === "2026-10" && ++previousReads === 1) return previous.promise;
      return Promise.resolve({ ...sampleUsage(), monthCost: 22 });
    };
    await mount(concurrent);
    await acceptBoth();
    const old = fetchCurrentUsage();
    const revoked = assert.rejects(() => old, /替代/);
    await change(() => {
      config = {
        ...config,
        configRevision: ++revision,
        usageTokenRevision: revision,
      };
      setCommittedConfig(config);
    });
    assert.equal(
      renderer.root.findByType(DashboardPanel).props.usage.monthCost,
      22,
    );
    await change(() =>
      previous.reject({
        code: "rate_limited",
        message: "Old account 429",
        retryable: true,
      }),
    );
    await revoked;
    const props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(props.usage.monthCost, 22);
    assert.equal(props.usageError, "");
    assert.equal(props.usageState, "ok");
    assert.deepEqual(usageCalls, ["2026-11", "2026-10", "2026-11", "2026-10"]);
    assert.equal(scheduled().length, 2);
    assert.equal(
      [...timers.values()].some((timer) => timer.delay === 120_000),
      false,
    );
  }),
);

scenario("R34 invalid month data preserves partial success", (concurrent) =>
  atMonthStart(async () => {
    usageRead = (month) =>
      month === "2026-10"
        ? Promise.reject({
            code: "invalid_data",
            // A structured month error must not become auth failure by text.
            message: "Synthetic Token count has invalid month data",
            retryable: false,
          })
        : Promise.resolve(sampleUsage());
    await mount(concurrent);
    await acceptBoth();
    const props = renderer.root.findByType(DashboardPanel).props;
    assert.equal(props.usageState, "ok");
    assert.equal(props.usageError, "");
    assert.equal(props.usage.monthCost, 1);
    assert.deepEqual(props.usage.unavailableDates, [
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
    ]);
    assert.deepEqual(props.usage.warnings, [
      "上月数据暂未获取，缺失日期标为未知",
    ]);
    assert.deepEqual(usageCalls, ["2026-11", "2026-10"]);
    assert.equal(scheduled().length, 2);
  }),
);

// Source contracts complement the synthetic IPC rejection scenarios above.
// They do not execute Rust, create a native window or validate browser layout.
test("R29 native visibility error contract", () => {
  const source = readFileSync("src-tauri/src/commands.rs", "utf8");
  const command = source.slice(
    source.indexOf("pub(crate) fn is_main_window_visible"),
    source.indexOf("pub(crate) fn get_app_config"),
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
