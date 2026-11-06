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

// R29/R30: real App + SettingsPanel, synthetic refs/events/RAF/IPC only. The mock
// records open/scrollIntoView/focus, including child refs if reintroduced.
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
    return !this.isConnected || Boolean(this.host.props.disabled);
  }
  get open() {
    return this.isConnected && (this.opened || Boolean(this.host.props.open));
  }
  set open(value: boolean) {
    if (!this.isConnected) return;
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
    if (!this.isConnected) return;
    this.attributes.set(name, value);
  }
  scrollTo() {}
  scrollIntoView() {
    if (!this.isConnected) return;
    scrollLog.push(this.label);
  }
  contains(node: FocusNode) {
    return (
      this.isConnected &&
      node.isConnected &&
      this.host.findAll((host: any) => host === node.host).length > 0
    );
  }
  querySelector(selector: string) {
    return this.isConnected ? select(selector, this.host) : null;
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
function select(selector: string, root: any) {
  const candidates = root.findAll((node: any) => typeof node.type === "string");
  const directed = selector.match(/data-settings-focus=["'](\w+)["']/);
  const disclosure = selector.match(/data-settings-disclosure=["'](\w+)["']/);
  const model = selector.match(/data-usage-model=["'](\w+)["']/);
  const host = directed
    ? candidates.find(
        (node: any) => node.props["data-settings-focus"] === directed[1],
      )
    : disclosure
      ? candidates.find(
          (node: any) =>
            node.props["data-settings-disclosure"] === disclosure[1],
        )
      : model
        ? candidates.find(
            (node: any) =>
              node.type === "button" &&
              node.props["data-usage-model"] === model[1],
          )
        : selector === "button"
          ? candidates.find((node: any) => node.type === "button")
          : candidates.find((node: any) => node.type === "h1");
  return host ? nodeFor(host) : null;
}
// R30: bind once at ref attachment, while the committed host still has these
// props. ReactTestInstance identity survives updates; props object identity does
// not. Never re-resolve an old ref by selector: an identical replacement belongs
// to a different mount. This observes synthetic operations, not native DOM.
function refMock(element: any) {
  const matches = hosts().filter(
    (node) => node.type === element.type && node.props === element.props,
  );
  assert.equal(
    matches.length,
    1,
    "A ref must bind to one committed host, never a silent no-op or alias",
  );
  return nodeFor(matches[0]);
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
async function mountTree(element: React.ReactElement, concurrent: boolean) {
  await act(async () => {
    // Publish the renderer before any host ref attaches, including legacy mode.
    // Ref attachment occurs after the renderer has committed the current tree.
    renderer = Renderer.create(null, {
      unstable_isConcurrent: concurrent,
      createNodeMock: refMock,
    } as any);
    renderer.update(<React.StrictMode>{element}</React.StrictMode>);
  });
  await flush();
}
async function mount(concurrent: boolean) {
  await mountTree(<App />, concurrent);
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

type RefSnapshot = {
  revision: number;
  root: FocusNode;
  disclosure: FocusNode;
  target: FocusNode;
  usage: FocusNode;
  props: unknown[];
};
const refKeys = ["root", "disclosure", "target", "usage"] as const;
function RefLifetimeProbe({
  record,
}: {
  record: (value: RefSnapshot) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const disclosure = React.useRef<HTMLDetailsElement>(null);
  const target = React.useRef<HTMLElement>(null);
  const usage = React.useRef<HTMLDivElement>(null);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (mounted) setRevision(1);
    });
    return () => {
      mounted = false;
    };
  }, []);
  React.useLayoutEffect(() => {
    const refs = {
      root: root.current as unknown as FocusNode,
      disclosure: disclosure.current as unknown as FocusNode,
      target: target.current as unknown as FocusNode,
      usage: usage.current as unknown as FocusNode,
    };
    record({
      revision,
      ...refs,
      props: refKeys.map((key) => refs[key].host.props),
    });
  }, [record, revision]);
  return (
    <div
      ref={root}
      className="stage mode-settings"
      data-fixture-revision={revision}
    >
      <details
        ref={disclosure}
        data-settings-disclosure="dataNotices"
        data-fixture-revision={revision}
      >
        <summary
          ref={target}
          data-settings-focus="dataNotices"
          data-fixture-revision={revision}
        >
          Synthetic disclosure
        </summary>
        <button type="button">Synthetic action</button>
      </details>
      <div
        ref={usage}
        data-settings-focus="usageToken"
        data-fixture-revision={revision}
        tabIndex={-1}
      />
    </div>
  );
}
function assertRefUpdate(snapshots: RefSnapshot[]) {
  const first = snapshots.find((snapshot) => snapshot.revision === 0);
  const updated = snapshots.find((snapshot) => snapshot.revision === 1);
  assert.ok(first, "The probe must capture its first committed refs");
  assert.ok(updated, "The probe must commit its asynchronous state update");
  for (const [index, key] of refKeys.entries()) {
    assert.equal(
      first[key],
      updated[key],
      "A retained host keeps its ref node",
    );
    assert.notEqual(first.props[index], updated.props[index]);
    assert.equal(first[key].isConnected, true);
    assert.equal(first[key].host.props["data-fixture-revision"], 1);
  }
  assert.equal(
    first.root.querySelector('[data-settings-focus="dataNotices"]'),
    first.target,
  );
  assert.equal(first.root.contains(first.target), true);
  return first;
}
function exerciseRefs(snapshot: RefSnapshot) {
  snapshot.disclosure.open = true;
  snapshot.target.scrollIntoView();
  snapshot.target.focus();
  snapshot.usage.scrollIntoView();
  snapshot.usage.focus();
}
for (const concurrent of [false, true]) {
  test(`R30 ref fixture (${concurrent ? "concurrent" : "legacy"}): updates stay observable and remounts stay isolated`, async () => {
    frames.clear();
    cancelledFrames.clear();
    clearLogs();
    nodes = new Map();
    g.document.activeElement = body;
    const snapshots: RefSnapshot[] = [];
    const record = (snapshot: RefSnapshot) => snapshots.push(snapshot);
    try {
      await mountTree(<RefLifetimeProbe record={record} />, concurrent);
      const original = assertRefUpdate(snapshots);
      clearLogs();
      // Deliberately duplicate the same late child operation. A broken mock
      // would silently erase both calls after the asynchronous props change.
      for (let i = 0; i < 2; i++) {
        g.window.requestAnimationFrame(() => exerciseRefs(original));
      }
      await drainFrames();
      const actions = ["settings:dataNotices", "settings:usageToken"];
      assert.deepEqual(focusLog, [...actions, ...actions]);
      assert.deepEqual(scrollLog, [...actions, ...actions]);
      assert.deepEqual(openLog, [
        "disclosure:dataNotices",
        "disclosure:dataNotices",
      ]);
      assert.equal(g.document.activeElement, original.usage);
      assert.equal(original.disclosure.open, true);

      await call(() => renderer.update(null));
      for (const key of refKeys) assert.equal(original[key].isConnected, false);
      clearLogs();
      exerciseRefs(original);
      assertUntouched();
      assert.equal(original.root.querySelector("button"), null);

      const nextStart = snapshots.length;
      await call(() =>
        renderer.update(
          <React.StrictMode>
            <RefLifetimeProbe record={record} />
          </React.StrictMode>,
        ),
      );
      const replacement = assertRefUpdate(snapshots.slice(nextStart));
      for (const key of refKeys) {
        assert.notEqual(original[key], replacement[key]);
        assert.equal(original[key].isConnected, false);
      }
      clearLogs();
      exerciseRefs(original);
      assertUntouched();
      assert.equal(original.root.querySelector("button"), null);
      assert.equal(original.root.contains(replacement.target), false);
      assert.equal(replacement.root.contains(original.target), false);
      assert.equal(replacement.disclosure.open, false);
      assert.equal(g.document.activeElement, body);
      exerciseRefs(replacement);
      assert.deepEqual(focusLog, actions);
      assert.deepEqual(scrollLog, actions);
      assert.deepEqual(openLog, ["disclosure:dataNotices"]);
      assert.equal(g.document.activeElement, replacement.usage);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      renderer = null;
      await flush();
      frames.clear();
      clearLogs();
    }
  });
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
