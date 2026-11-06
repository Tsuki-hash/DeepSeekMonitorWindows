import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { OnboardingPanel } from "../src/components/OnboardingPanel";
import { setCommittedConfig } from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";
import { draftGuardActions } from "../src/draft-guard";
import type { AppConfig, UsageResult } from "../src/types";

// R29: real App + SettingsPanel, synthetic refs/events/RAF/IPC only. The mock
// observes every open/scroll/focus, including child refs if they are reintroduced.
// It does not implement navigation or cancellation decisions for the component.
// No DOM, native keyboard, WebView2, StrictEffects or screen reader is exercised.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
type Target = "usageToken" | "dataNotices";
type Listener = (event: any) => void;
const documentEvents = new Map<string, Set<Listener>>();
const windowEvents = new Map<string, Set<Listener>>();
function add(map: Map<string, Set<Listener>>, name: string, fn: Listener) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name)!.add(fn);
}
function dispatch(map: Map<string, Set<Listener>>, name: string, event = {}) {
  for (const fn of [...(map.get(name) ?? [])]) fn(event);
}
let timer = 0;
const frames = new Map<number, () => void>();
const cancelledFrames = new Set<number>();
const focusLog: string[] = [];
const scrollLog: string[] = [];
const openLog: string[] = [];
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
const body = { tagName: "BODY" };
let renderer: any = null;
let nodes = new Map<any, FocusNode>();
let documentFocused = true;

const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
function hosts(): any[] {
  if (!renderer) return [];
  try {
    return renderer.root.findAll((node: any) => typeof node.type === "string");
  } catch {
    return [];
  }
}
const panelName = () =>
  hosts().find((node) => node.props["data-testid"]?.endsWith("-panel"))?.props[
    "data-testid"
  ] ?? "no-panel";
class FocusNode {
  host: any;
  label: string;
  hidden = false;
  opened = false;
  attributes = new Map<string, string>();
  constructor(host: any) {
    this.host = host;
    this.label = host.props["data-settings-focus"]
      ? `settings:${host.props["data-settings-focus"]}`
      : host.props["data-settings-disclosure"]
        ? `disclosure:${host.props["data-settings-disclosure"]}`
        : host.props["data-usage-model"]
          ? `row:${host.props["data-usage-model"]}`
          : host.type === "h1"
            ? `${panelName()}:heading`
            : (host.props["aria-label"] ?? text(host) ?? host.type);
  }
  get isConnected() {
    return hosts().includes(this.host);
  }
  get tagName() {
    return this.host.type.toUpperCase();
  }
  get dataset() {
    return { usageModel: this.host.props["data-usage-model"] };
  }
  get disabled() {
    return Boolean(this.host.props.disabled);
  }
  get open() {
    return this.opened || Boolean(this.host.props.open);
  }
  set open(value: boolean) {
    this.opened = value;
    if (value) openLog.push(this.label);
  }
  closest() {
    return this.hidden ? this : null;
  }
  getClientRects() {
    return this.isConnected && !this.hidden ? [{}] : [];
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  scrollIntoView() {
    scrollLog.push(this.label);
  }
  focus() {
    if (!this.isConnected || this.disabled || this.hidden) return;
    focusLog.push(this.label);
    g.document.activeElement = this;
    dispatch(documentEvents, "focusin", { target: this });
  }
}
function nodeFor(host: any): FocusNode {
  assert.ok(host, "The production tree must contain the requested host");
  if (!nodes.has(host)) nodes.set(host, new FocusNode(host));
  return nodes.get(host)!;
}
function select(selector: string) {
  const directed = selector.match(/data-settings-focus=["'](\w+)["']/);
  const disclosure = selector.match(/data-settings-disclosure=["'](\w+)["']/);
  const model = selector.match(/data-usage-model=["'](\w+)["']/);
  const host = directed
    ? hosts().find((node) => node.props["data-settings-focus"] === directed[1])
    : disclosure
      ? hosts().find(
          (node) => node.props["data-settings-disclosure"] === disclosure[1],
        )
      : model
        ? hosts().find(
            (node) =>
              node.type === "button" &&
              node.props["data-usage-model"] === model[1],
          )
        : hosts().find((node) => node.type === "h1");
  return host ? nodeFor(host) : null;
}
const stage = {
  get isConnected() {
    return renderer !== null;
  },
  contains: (node: FocusNode) => node.isConnected,
  querySelector: select,
};
// Resolve real ref hosts lazily after commit. This also observes an accidental
// reintroduction of SettingsPanel's independent RAF instead of hiding it behind
// no-op child refs. LeavePromptDialog's own focus remains observable separately.
function refMock(element: any) {
  if (element.props.className?.startsWith("stage ")) return stage;
  const host = () =>
    hosts().find(
      (node) => node.type === element.type && node.props === element.props,
    );
  return {
    get isConnected() {
      return Boolean(host());
    },
    get open() {
      return host() ? nodeFor(host()).open : false;
    },
    set open(value: boolean) {
      if (host()) nodeFor(host()).open = value;
    },
    scrollTo: noop,
    scrollIntoView: () => host() && nodeFor(host()).scrollIntoView(),
    setAttribute: (name: string, value: string) =>
      host() && nodeFor(host()).setAttribute(name, value),
    focus: () => host() && nodeFor(host()).focus(),
    querySelector: (selector: string) => {
      const selected = host()?.findAll(
        (node: any) => node.type === selector,
      )[0];
      return selected ? nodeFor(selected) : null;
    },
  };
}
g.HTMLElement = FocusNode;
g.window = {
  setTimeout: () => ++timer,
  clearTimeout: noop,
  setInterval: () => ++timer,
  clearInterval: noop,
  requestAnimationFrame: (fn: () => void) => {
    const id = ++timer;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id: number) => {
    cancelledFrames.add(id);
    frames.delete(id);
  },
  addEventListener: (name: string, fn: Listener) => add(windowEvents, name, fn),
  removeEventListener: (name: string, fn: Listener) =>
    windowEvents.get(name)?.delete(fn),
};
g.document = {
  body,
  activeElement: body,
  visibilityState: "visible",
  hasFocus: () => documentFocused,
  documentElement: {
    getAttribute: (key: string) => attrs.get(key) ?? null,
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    style: { getPropertyValue: () => "", setProperty: noop },
  },
  addEventListener: (name: string, fn: Listener) =>
    add(documentEvents, name, fn),
  removeEventListener: (name: string, fn: Listener) =>
    documentEvents.get(name)?.delete(fn),
};
g.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
g.__settingsListeners = new Map();
let revision = 0;
let config: AppConfig;
const makeConfig = (): AppConfig => ({
  configRevision: ++revision,
  apiKeyRevision: revision,
  usageTokenRevision: revision,
  apiKeyConfigured: true,
  apiKeyPreview: "SYNTHETIC_ONLY",
  usageTokenConfigured: true,
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: false,
  autostart: false,
  configPath: "SYNTHETIC_ONLY",
});
const sampleUsage = (): UsageResult => ({
  models: [
    {
      key: "flash",
      name: "Synthetic Flash",
      totalTokens: 123,
      requestCount: 1,
      cacheHitTokens: 0,
      cacheMissTokens: 123,
      responseTokens: 0,
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
      return {
        isAvailable: true,
        currency: "CNY",
        totalBalance: "3",
        grantedBalance: "0",
        toppedUpBalance: "3",
      };
    case "fetch_usage":
      return sampleUsage();
    case "is_main_window_visible":
      return true;
    case "begin_tray_balance_session":
      return 1;
    case "update_tray_balance":
      return true;
    case "get_usage_sync_status":
      return { generation: 0, requestId: null, active: false, kind: "web" };
    case "get_desktop_options":
      return { alwaysOnTop: false, shortcutEnabled: false, error: null };
    case "get_alert_status":
      return {
        options: {
          enabled: false,
          lowBalanceEnabled: true,
          lowBalanceCny: 10,
          monthlyBudgetEnabled: false,
          monthlyBudgetCny: 100,
          quietHours: true,
        },
        balanceState: "waiting",
        budgetState: "disabled",
        balanceCheckedAt: null,
        budgetCheckedAt: null,
        lastNotificationAt: null,
        quietNow: false,
        error: null,
      };
    default:
      return null;
  }
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
  // Model only the disconnected-element fallback; do not emulate navigation.
  const active = g.document.activeElement;
  if (active instanceof FocusNode && !active.isConnected) {
    g.document.activeElement = body;
  }
}
async function mount(concurrent: boolean) {
  await act(async () => {
    renderer = Renderer.create(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
      { unstable_isConcurrent: concurrent, createNodeMock: refMock } as any,
    );
  });
  await flush();
}
async function call(callback: () => void) {
  await act(async () => callback());
  await flush();
}
async function emit(name: string, payload?: unknown) {
  await call(() => {
    for (const fn of g.__settingsListeners.get(name) ?? []) fn({ payload });
  });
}
function clearLogs() {
  focusLog.length = 0;
  scrollLog.length = 0;
  openLog.length = 0;
}
function assertUntouched() {
  assert.deepEqual(focusLog, [], "Cancelled navigation cannot move focus");
  assert.deepEqual(scrollLog, [], "Cancelled navigation cannot scroll");
  assert.deepEqual(openLog, [], "Cancelled navigation cannot open details");
}
async function drainFrames() {
  await act(async () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      fn();
    }
  });
  await flush();
  assert.equal(frames.size, 0, "The navigation must not queue a replay");
}
async function invokeStale(saved: Array<[number, () => void]>) {
  assert.ok(saved.length > 0, "Interruption must begin with a pending RAF");
  for (const [id] of saved) assert.ok(cancelledFrames.has(id));
  await call(() => {
    for (const [, fn] of saved) fn();
  });
}
const targetNode = (target: Target) =>
  nodeFor(hosts().find((host) => host.props["data-settings-focus"] === target));
const apiKeyInput = () =>
  hosts().find(
    (host) => host.type === "input" && host.props["aria-label"] === "API Key",
  );
async function backToDashboard() {
  if (panelName() === "settings-panel") {
    await call(() => renderer.root.findByType(SettingsPanel).props.onBack());
  }
  assert.equal(panelName(), "dashboard-panel");
  await drainFrames();
}
async function enter(target: Target) {
  assert.equal(panelName(), "dashboard-panel");
  if (target === "dataNotices") {
    await call(() =>
      renderer.root.findByType(DashboardPanel).props.onDataStatus(),
    );
  } else {
    await call(() =>
      renderer.root.findByType(DashboardPanel).props.onHistory(),
    );
    await drainFrames();
    await call(() =>
      renderer.root.findByType(HistoryPanel).props.onConfigureUsage(),
    );
  }
  assert.equal(panelName(), "settings-panel");
  const node = targetNode(target);
  assert.equal(node.tagName, target === "usageToken" ? "DIV" : "SUMMARY");
  assert.ok(frames.size > 0, "The committed directed request must queue a RAF");
  clearLogs();
}
async function expectDirectedOnce(target: Target) {
  await drainFrames();
  assert.deepEqual(focusLog, [`settings:${target}`]);
  assert.deepEqual(scrollLog, [`settings:${target}`]);
  assert.deepEqual(
    openLog,
    target === "dataNotices" ? ["disclosure:dataNotices"] : [],
  );
  assert.equal(g.document.activeElement, targetNode(target));
  clearLogs();
  await emit("main-window-shown");
  await drainFrames();
  assertUntouched();
}
async function reenterSuccessfully(target: Target) {
  await backToDashboard();
  await enter(target);
  await expectDirectedOnce(target);
}
function scenario(
  name: string,
  bodyOfTest: (target: Target, concurrent: boolean) => Promise<void>,
) {
  for (const target of ["usageToken", "dataNotices"] as const) {
    for (const concurrent of [false, true]) {
      test(`R29 directed ${target} (${concurrent ? "concurrent" : "legacy"}): ${name}`, async () => {
        setCommittedConfig(null);
        invalidateUsageRequests();
        config = makeConfig();
        frames.clear();
        cancelledFrames.clear();
        clearLogs();
        nodes = new Map();
        storage.clear();
        attrs.clear();
        documentFocused = true;
        g.document.activeElement = body;
        g.document.visibilityState = "visible";
        g.__settingsListen = undefined;
        try {
          await mount(concurrent);
          await bodyOfTest(target, concurrent);
        } finally {
          if (renderer) await act(async () => renderer.unmount());
          renderer = null;
          await flush();
          assert.equal(frames.size, 0, "Unmount cancels all queued RAFs");
          assert.equal(
            [...documentEvents.values()].some((set) => set.size),
            false,
          );
          assert.equal(
            [...windowEvents.values()].some((set) => set.size),
            false,
          );
          assert.equal(
            [...g.__settingsListeners.values()].some((set: any) => set.size),
            false,
          );
        }
      });
    }
  }
}

scenario(
  "targets focus once and a later explicit visit works",
  async (target) => {
    await enter(target);
    await expectDirectedOnce(target);
    await reenterSuccessfully(target);
  },
);

scenario(
  "onboarding and model-detail directed entrances use the same owner",
  async (target) => {
    if (target === "usageToken") {
      config = {
        ...config,
        configRevision: ++revision,
        apiKeyRevision: revision,
        usageTokenRevision: revision,
        apiKeyConfigured: false,
        apiKeyPreview: null,
        usageTokenConfigured: false,
      };
      await emit("credential-config-changed", config);
      await call(() =>
        renderer.root.findByType(OnboardingPanel).props.onChoose("platform"),
      );
    } else {
      const row = hosts().find(
        (host) =>
          host.type === "button" && host.props["data-usage-model"] === "flash",
      );
      const trigger = nodeFor(row);
      await call(() => row.props.onClick({ currentTarget: trigger }));
      const detailFrame = [...frames];
      await call(() =>
        renderer.root.findByType(ModelDetailPanel).props.onDataStatus(),
      );
      clearLogs();
      await invokeStale(detailFrame);
      assertUntouched();
    }
    assert.equal(panelName(), "settings-panel");
    clearLogs();
    await expectDirectedOnce(target);
  },
);

scenario(
  "focusin, keydown and pointerdown permanently cancel",
  async (target) => {
    for (const event of ["focusin", "keydown", "pointerdown"] as const) {
      await backToDashboard();
      await enter(target);
      const old = [...frames];
      const chosen = nodeFor(apiKeyInput());
      if (event === "focusin") chosen.focus();
      else dispatch(documentEvents, event, { target: chosen, key: "Tab" });
      const active = g.document.activeElement;
      clearLogs();
      await invokeStale(old);
      await drainFrames();
      assertUntouched();
      assert.equal(g.document.activeElement, active);
      await emit("main-window-shown");
      await drainFrames();
      assertUntouched();
      await reenterSuccessfully(target);
    }
  },
);

scenario(
  "native hidden, document hidden and blur never replay",
  async (target) => {
    for (const reason of ["native", "document", "blur"] as const) {
      await backToDashboard();
      await enter(target);
      const old = [...frames];
      if (reason === "native") await emit("main-window-hidden");
      if (reason === "document") {
        g.document.visibilityState = "hidden";
        dispatch(documentEvents, "visibilitychange");
      }
      if (reason === "blur") {
        documentFocused = false;
        dispatch(windowEvents, "blur");
      }
      await invokeStale(old);
      await drainFrames();
      assertUntouched();
      g.document.visibilityState = "visible";
      documentFocused = true;
      dispatch(documentEvents, "visibilitychange");
      await emit("main-window-shown");
      await invokeStale(old);
      await drainFrames();
      assertUntouched();
      await reenterSuccessfully(target);
    }
  },
);

scenario("execution rechecks document visibility and focus", async (target) => {
  for (const reason of ["document", "focus"] as const) {
    await backToDashboard();
    await enter(target);
    // No event is dispatched: the frame must inspect the current browser state.
    if (reason === "document") g.document.visibilityState = "hidden";
    else documentFocused = false;
    await drainFrames();
    assertUntouched();
    g.document.visibilityState = "visible";
    documentFocused = true;
    await emit("main-window-shown");
    await drainFrames();
    assertUntouched();
    await reenterSuccessfully(target);
  }
});

scenario(
  "account change cancels instead of rearming a directed request",
  async (target) => {
    await enter(target);
    const old = [...frames];
    const firstAccount = config;
    config = makeConfig();
    await emit("credential-config-changed", config);
    await invokeStale(old);
    await drainFrames();
    assertUntouched();
    // Returning to the same credentials is still a new account-state lifetime.
    config = { ...firstAccount, configRevision: ++revision };
    await emit("credential-config-changed", config);
    await emit("main-window-shown");
    await invokeStale(old);
    await drainFrames();
    assertUntouched();
    await reenterSuccessfully(target);
  },
);

scenario(
  "preference commits replace a frame without reviving the old frame",
  async (target) => {
    await enter(target);
    const old = [...frames];
    config = {
      ...config,
      configRevision: ++revision,
      refreshIntervalSeconds: 300,
    };
    await emit("credential-config-changed", config);
    await invokeStale(old);
    assertUntouched();
    await expectDirectedOnce(target);
  },
);

scenario(
  "new navigation cancels even without a pointer or key event",
  async (target) => {
    await enter(target);
    const old = [...frames];
    await call(() => renderer.root.findByType(SettingsPanel).props.onBack());
    clearLogs();
    await invokeStale(old);
    assertUntouched();
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
    assert.deepEqual(scrollLog, []);
    assert.deepEqual(openLog, []);
    const opposite = target === "usageToken" ? "dataNotices" : "usageToken";
    await enter(opposite);
    await invokeStale(old);
    assertUntouched();
    await expectDirectedOnce(opposite);
    await reenterSuccessfully(target);
  },
);

scenario(
  "dirty-draft prompt and Cancel keep the directed request dead",
  async (target) => {
    await enter(target);
    // Change props without focus/key events so navigate's own cancellation is
    // required. This is the real credential draft and real page leave blocker.
    await call(() =>
      apiKeyInput().props.onChange({ target: { value: "SYNTHETIC_DRAFT" } }),
    );
    const old = [...frames];
    await call(() => renderer.root.findByType(SettingsPanel).props.onBack());
    assert.equal(panelName(), "settings-panel");
    const dialog = renderer.root.findByProps({ role: "alertdialog" });
    await invokeStale(old);
    assertUntouched();
    await drainFrames();
    const firstButton = nodeFor(dialog.findAllByType("button")[0]);
    assert.equal(g.document.activeElement, firstButton);
    assert.deepEqual(scrollLog, []);
    assert.deepEqual(openLog, []);
    const cancel = dialog
      .findAllByType("button")
      .find((host: any) => text(host) === draftGuardActions.cancel);
    assert.ok(cancel);
    await call(() => cancel.props.onClick());
    assert.equal(
      renderer.root.findAllByProps({ role: "alertdialog" }).length,
      0,
    );
    clearLogs();
    await invokeStale(old);
    await emit("main-window-shown");
    await drainFrames();
    assertUntouched();
    assert.equal(apiKeyInput().props.value, "SYNTHETIC_DRAFT");
    await call(() => apiKeyInput().props.onChange({ target: { value: "" } }));
    await reenterSuccessfully(target);
  },
);

scenario(
  "unmount invalidates late callbacks and detached targets",
  async (target) => {
    await enter(target);
    const old = [...frames];
    const node = targetNode(target);
    await act(async () => renderer.unmount());
    renderer = null;
    await flush();
    assert.equal(node.isConnected, false);
    await invokeStale(old);
    assertUntouched();
  },
);

scenario(
  "ordinary settings titles and model-return focus remain intact",
  async (target) => {
    await enter(target);
    await expectDirectedOnce(target);
    await backToDashboard();
    await call(() =>
      renderer.root.findByType(DashboardPanel).props.onSettings(),
    );
    clearLogs();
    await drainFrames();
    assert.deepEqual(focusLog, ["settings-panel:heading"]);
    assert.deepEqual(scrollLog, []);
    assert.deepEqual(openLog, []);
    await backToDashboard();
    const row = hosts().find(
      (host) =>
        host.type === "button" && host.props["data-usage-model"] === "flash",
    );
    const trigger = nodeFor(row);
    trigger.focus();
    await call(() => row.props.onClick({ currentTarget: trigger }));
    clearLogs();
    await drainFrames();
    assert.deepEqual(focusLog, ["detail-panel:heading"]);
    const back = hosts().find(
      (host) =>
        host.type === "button" && host.props["aria-label"] === "返回主面板",
    );
    await call(() => back.props.onClick());
    clearLogs();
    await drainFrames();
    assert.deepEqual(focusLog, ["row:flash"]);
    assert.deepEqual(scrollLog, []);
    assert.deepEqual(openLog, []);
  },
);
