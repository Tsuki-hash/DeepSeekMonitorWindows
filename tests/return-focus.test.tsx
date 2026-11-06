import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { getCommittedConfig, setCommittedConfig } from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";
import type { AppConfig, ModelName, UsageResult } from "../src/types";

// R28: production components with synthetic refs, focus events, RAF and IPC.
// These are NOT DOM tests: no native focus/Enter/Space/layout/accessibility tree,
// createRoot StrictEffects replay, Windows WebView2, NVDA or Narrator is exercised.
// The current renderer tree determines which mock nodes exist. The fixture does
// not reimplement App's navigation/account/request ownership decisions.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
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
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
const body = { tagName: "BODY" };
let renderer: any = null;
let nodes = new Map<any, FocusNode>();
let documentFocused = true;

function hosts(): any[] {
  if (!renderer) return [];
  try {
    return renderer.root.findAll((node: any) => typeof node.type === "string");
  } catch {
    return [];
  }
}
const text = (node: any): string =>
  typeof node === "string" ? node : (node?.children?.map(text).join("") ?? "");
const panelName = () =>
  hosts().find((node) => node.props["data-testid"]?.endsWith("-panel"))?.props[
    "data-testid"
  ] ?? "no-panel";

class FocusNode {
  host: any;
  label: string;
  hidden = false;
  disabledOverride = false;
  rejectFocus = false;
  attributes = new Map<string, string>();
  constructor(host: any) {
    this.host = host;
    this.label = host.props["data-usage-model"]
      ? `row:${host.props["data-usage-model"]}`
      : host.type === "h1"
        ? `${panelName()}:heading`
        : (host.props["aria-label"] ?? host.type);
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
    return this.disabledOverride || Boolean(this.host.props.disabled);
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
  focus() {
    if (!this.isConnected || this.disabled || this.hidden || this.rejectFocus) {
      return;
    }
    focusLog.push(this.label);
    g.document.activeElement = this;
    dispatch(documentEvents, "focusin", { target: this });
  }
}
function nodeFor(host: any): FocusNode {
  assert.ok(host, "The production component must render the requested node");
  if (!nodes.has(host)) nodes.set(host, new FocusNode(host));
  return nodes.get(host)!;
}
function select(selector: string) {
  const model = selector.match(/data-usage-model="(flash|pro|other)"/);
  const host = model
    ? hosts().find(
        (node) =>
          node.type === "button" && node.props["data-usage-model"] === model[1],
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
  models: (["flash", "pro", "other"] as const).map((key, i) => ({
    key,
    name: `Synthetic ${key}`,
    totalTokens: [0, 123_456_789, null][i],
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: 0,
    otherTokens: 0,
    cost: 1,
  })),
  days: [],
  monthCost: 3,
});
let usage: UsageResult;
let usageFailure: unknown = null;
let visibilityRead: () => Promise<boolean> = async () => true;
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
      if (usageFailure) throw usageFailure;
      return structuredClone(usage);
    case "is_main_window_visible":
      return visibilityRead();
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

// The renderer never changes document.activeElement. Simulate only the browser's
// disconnected-node fallback; App itself must decide whether and where to focus.
function detachedFallback() {
  const active = g.document.activeElement;
  if (active instanceof FocusNode && !active.isConnected) {
    g.document.activeElement = body;
  }
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
  detachedFallback();
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
                setAttribute: noop,
                focus: noop,
                querySelector: () => null,
              },
      } as any,
    );
  });
  await flush();
}
const rowHost = (key: ModelName) =>
  hosts().find(
    (node) => node.type === "button" && node.props["data-usage-model"] === key,
  );
const labelledButton = (label: string) =>
  hosts().find(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  );
async function activate(host: any) {
  const node = nodeFor(host);
  dispatch(documentEvents, "pointerdown", { target: node });
  node.focus();
  // Exercise the production UsageRow -> DashboardPanel -> App callback chain.
  await act(async () => host.props.onClick({ currentTarget: node }));
  await flush();
  return node;
}
async function open(key: ModelName) {
  const original = await activate(rowHost(key));
  assert.equal(panelName(), "detail-panel");
  assert.equal(original.isConnected, false);
  return original;
}
async function back() {
  await activate(labelledButton("返回主面板"));
  assert.equal(panelName(), "dashboard-panel");
}
async function drainFrames() {
  await act(async () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      fn();
    }
  });
  await flush();
  assert.equal(
    frames.size,
    0,
    "No second navigation focus should remain queued",
  );
}
async function invokeStale(saved: Array<[number, () => void]>) {
  assert.ok(saved.length > 0, "A pending RAF must exist before interruption");
  for (const [id] of saved) assert.ok(cancelledFrames.has(id));
  await act(async () => {
    for (const [, fn] of saved) fn();
  });
  await flush();
}
async function emit(name: string, payload?: unknown) {
  await act(async () => {
    for (const fn of g.__settingsListeners.get(name) ?? []) fn({ payload });
  });
  await flush();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function scenario(
  name: string,
  bodyOfTest: (concurrent: boolean) => Promise<void>,
) {
  for (const concurrent of [false, true]) {
    test(`R28 synthetic focus (${concurrent ? "concurrent" : "legacy"} renderer): ${name}`, async () => {
      setCommittedConfig(null);
      invalidateUsageRequests();
      config = makeConfig();
      usage = sampleUsage();
      usageFailure = null;
      visibilityRead = async () => true;
      frames.clear();
      cancelledFrames.clear();
      focusLog.length = 0;
      nodes = new Map();
      storage.clear();
      attrs.clear();
      documentFocused = true;
      g.document.activeElement = body;
      g.document.visibilityState = "visible";
      try {
        await bodyOfTest(concurrent);
      } finally {
        if (renderer) await act(async () => renderer.unmount());
        renderer = null;
        await flush();
        assert.equal(frames.size, 0, "Unmount cancels pending focus RAFs");
        assert.equal(
          [...documentEvents.values()].some((set) => set.size),
          false,
        );
        assert.equal(
          [...windowEvents.values()].some((set) => set.size),
          false,
        );
      }
    });
  }
}

scenario(
  "each model returns to a newly mounted same-key button, once",
  async (concurrent) => {
    await mount(concurrent);
    for (const key of ["flash", "pro", "other", "pro", "flash"] as const) {
      const entrance = rowHost(key);
      assert.equal(entrance.props.type, "button");
      assert.equal(entrance.props.onKeyDown, undefined);
      assert.equal(entrance.findAllByType("button").length, 1);
      assert.match(
        text(
          renderer.root.findByProps({ id: entrance.props["aria-describedby"] }),
        ),
        /平台本月 Tokens.*不是近 7 日合计/,
      );
      const original = await open(key);
      focusLog.length = 0;
      await drainFrames();
      assert.deepEqual(focusLog, ["detail-panel:heading"]);
      assert.equal(renderer.root.findByType(ModelDetailPanel).props.model, key);
      await back();
      const remounted = nodeFor(rowHost(key));
      assert.notEqual(remounted, original);
      focusLog.length = 0;
      await drainFrames();
      assert.equal(g.document.activeElement, remounted);
      assert.deepEqual(focusLog, [`row:${key}`]);
      await emit("main-window-shown");
      await drainFrames();
      assert.deepEqual(
        focusLog,
        [`row:${key}`],
        "A data refresh must not refocus",
      );
    }
  },
);

scenario(
  "missing, hidden, disabled or focus-rejecting entry falls back to heading",
  async (concurrent) => {
    await mount(concurrent);
    await open("other");
    await drainFrames();
    usage = {
      ...usage,
      models: usage.models.filter((model) => model.key !== "other"),
    };
    await emit("main-window-shown");
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
    usage = sampleUsage();
    await emit("main-window-shown");
    await drainFrames();
    assert.deepEqual(
      focusLog,
      ["dashboard-panel:heading"],
      "Reappearing data must not revive restoration",
    );
    for (const flag of ["hidden", "disabledOverride", "rejectFocus"] as const) {
      await open("pro");
      await drainFrames();
      await back();
      const unavailable = nodeFor(rowHost("pro"));
      unavailable[flag] = true;
      focusLog.length = 0;
      await drainFrames();
      assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
      unavailable[flag] = false;
    }
  },
);

scenario(
  "account change between return commit and RAF invalidates the old frame",
  async (concurrent) => {
    await mount(concurrent);
    await open("flash");
    await drainFrames();
    await back();
    const old = [...frames];
    config = makeConfig();
    await emit("credential-config-changed", config);
    focusLog.length = 0;
    await invokeStale(old);
    assert.deepEqual(focusLog, []);
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
    assert.equal(
      getCommittedConfig()?.usageTokenRevision,
      config.usageTokenRevision,
    );
  },
);

scenario(
  "credential failure then recovery cannot revive an earlier origin",
  async (concurrent) => {
    await mount(concurrent);
    await open("pro");
    await drainFrames();
    usageFailure = {
      code: "credentials_invalid",
      message: "Synthetic invalid credential",
    };
    await emit("main-window-shown");
    usageFailure = null;
    await emit("main-window-shown");
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
  },
);

scenario(
  "ordinary refresh and preference commits preserve the same-key origin",
  async (concurrent) => {
    await mount(concurrent);
    await open("other");
    await drainFrames();
    usage = {
      ...usage,
      models: [...usage.models]
        .reverse()
        .map((model) => ({ ...model, name: `Renamed ${model.key}` })),
    };
    await emit("main-window-shown");
    config = {
      ...config,
      configRevision: ++revision,
      refreshIntervalSeconds: 300,
    };
    await emit("credential-config-changed", config);
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["row:other"]);
  },
);

scenario(
  "focus movement, keydown and pointerdown cancel rather than delay restoration",
  async (concurrent) => {
    await mount(concurrent);
    for (const event of ["focusin", "keydown", "pointerdown"] as const) {
      await open("flash");
      await drainFrames();
      await back();
      const old = [...frames];
      const chosen = nodeFor(labelledButton("刷新"));
      if (event === "focusin") chosen.focus();
      else dispatch(documentEvents, event, { target: chosen });
      const active = g.document.activeElement;
      focusLog.length = 0;
      await invokeStale(old);
      await drainFrames();
      assert.equal(g.document.activeElement, active);
      assert.deepEqual(focusLog, []);
    }
  },
);

scenario(
  "new navigation owns focus, and a settings detour never restores a model",
  async (concurrent) => {
    await mount(concurrent);
    await open("flash");
    await drainFrames();
    await back();
    const old = [...frames];
    // No synthetic pointer/key event: this must be cancelled by navigation itself.
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onSettings(),
    );
    await flush();
    focusLog.length = 0;
    await invokeStale(old);
    assert.deepEqual(focusLog, []);
    await drainFrames();
    assert.deepEqual(focusLog, ["settings-panel:heading"]);
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
  },
);

scenario(
  "detail-settings detour and history use headings, not an old model entry",
  async (concurrent) => {
    await mount(concurrent);
    await open("pro");
    await drainFrames();
    await act(async () =>
      renderer.root.findByType(ModelDetailPanel).props.onSettings(),
    );
    await flush();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["settings-panel:heading"]);
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onHistory(),
    );
    await flush();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["history-panel:heading"]);
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["dashboard-panel:heading"]);
  },
);

scenario(
  "native-hidden, document-hidden and blur cancel without replay on show",
  async (concurrent) => {
    await mount(concurrent);
    for (const reason of ["native", "document", "blur"] as const) {
      await open("pro");
      await drainFrames();
      await back();
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
      focusLog.length = 0;
      await invokeStale(old);
      await drainFrames();
      g.document.visibilityState = "visible";
      documentFocused = true;
      dispatch(documentEvents, "visibilitychange");
      await emit("main-window-shown");
      await drainFrames();
      assert.deepEqual(focusLog, []);
    }
  },
);

scenario(
  "late initial true visibility cannot overwrite a newer hidden event",
  async (concurrent) => {
    const initial = deferred<boolean>();
    visibilityRead = () => initial.promise;
    await mount(concurrent);
    await emit("main-window-hidden");
    await act(async () => initial.resolve(true));
    await flush();
    // Programmatic synthetic activation while hidden probes App's visibility gate.
    await open("flash");
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, []);
    await emit("main-window-shown");
    await drainFrames();
    assert.deepEqual(
      focusLog,
      [],
      "Showing must not revive the discarded request",
    );
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["row:flash"]);
  },
);

scenario(
  "late initial false visibility cannot overwrite a newer shown event",
  async (concurrent) => {
    const initial = deferred<boolean>();
    visibilityRead = () => initial.promise;
    await mount(concurrent);
    await emit("main-window-shown");
    await act(async () => initial.resolve(false));
    await flush();
    await open("other");
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["detail-panel:heading"]);
    await back();
    focusLog.length = 0;
    await drainFrames();
    assert.deepEqual(focusLog, ["row:other"]);
  },
);

scenario(
  "unmount cancels queued callbacks without touching disconnected nodes",
  async (concurrent) => {
    await mount(concurrent);
    await open("flash");
    const old = [...frames];
    focusLog.length = 0;
    await act(async () => renderer.unmount());
    renderer = null;
    await flush();
    await invokeStale(old);
    assert.deepEqual(focusLog, []);
    assert.equal(g.document.activeElement, body);
  },
);
