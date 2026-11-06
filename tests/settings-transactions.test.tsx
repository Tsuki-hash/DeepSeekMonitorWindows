import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { useSettingsState } from "../src/settings-state";
import { usageSessionCleanup } from "../src/usage-session-cleanup";
import {
  applyReadConfig,
  getCommitRevision,
  getCommittedConfig,
  getValidatedBalance,
  setCommittedConfig,
} from "../src/config-store";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { historyCache } from "../src/history-cache";
import { useLeaveGuard } from "../src/leave-guard";
import { USAGE_SYNC_RECONCILE_MS } from "../src/usage-sync-reconcile";

// Synthetic values only. No credentials are written to storage, fixtures, or logs.
// The renderer honors the StrictMode wrapper but does not replay StrictEffects.
// Explicit unmount/remount tests below are not a substitute for real createRoot
// DOM/WebView2 replay. Focus assertions inspect ref calls, not native activeElement.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
let frameId = 0;
const frames = new Map<number, () => void>();
const timeouts = new Map<number, { callback: () => void; delay: number }>();
const focus: string[] = [];
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
g.window = {
  setInterval: () => ++frameId,
  clearInterval: noop,
  setTimeout: (callback, delay) => {
    const id = ++frameId;
    timeouts.set(id, { callback, delay });
    return id;
  },
  clearTimeout: (id) => timeouts.delete(id),
  requestAnimationFrame: (fn) => {
    const id = ++frameId;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id) => frames.delete(id),
  addEventListener: noop,
  removeEventListener: noop,
};
g.document = {
  documentElement: {
    getAttribute: (key) => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value),
    style: { getPropertyValue: () => "", setProperty: noop },
  },
  addEventListener: noop,
  removeEventListener: noop,
  visibilityState: "visible",
  activeElement: null,
};
g.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
g.HTMLElement = class {};
g.__settingsListeners = new Map();
let calls = [];
let handlers = {};
let fixtureRevision = 0;
let fixtureSyncGeneration = 0;
let quitIssued = 0;
let quitAcknowledged = 0;
const syncStatus = (requestId = null, active = false, kind = "web") => ({
  generation: ++fixtureSyncGeneration,
  requestId,
  active,
  kind,
});
const capturedPayload = (config, status = syncStatus("old-captured")) => ({
  ...status,
  active: false,
  config,
});
const baseConfig = (over = {}) => ({
  configRevision: ++fixtureRevision,
  apiKeyRevision: fixtureRevision,
  usageTokenRevision: fixtureRevision,
  apiKeyConfigured: true,
  apiKeyPreview: "sk-…test",
  usageTokenConfigured: true,
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: false,
  autostart: false,
  configPath: "SYNTHETIC_ONLY",
  ...over,
});
const defaultAlerts = () => ({
  options: {
    enabled: false,
    lowBalanceEnabled: true,
    lowBalanceCny: 10,
    monthlyBudgetEnabled: false,
    monthlyBudgetCny: 100,
    quietHours: true,
  },
  balanceState: "disabled",
  budgetState: "disabled",
  balanceCheckedAt: null,
  budgetCheckedAt: null,
  lastNotificationAt: null,
  quietNow: false,
  error: null,
});
let config = baseConfig(),
  alerts = defaultAlerts();
const balance = {
  isAvailable: true,
  currency: "CNY",
  totalBalance: "100",
  grantedBalance: "0",
  toppedUpBalance: "100",
};
g.__settingsIpc = async (command, args) => {
  calls.push({ command, args });
  if (handlers[command]) return handlers[command](args);
  switch (command) {
    case "get_pending_quit_intent":
      return quitIssued > quitAcknowledged ? String(quitIssued) : null;
    case "acknowledge_quit_intent":
      quitAcknowledged = Math.max(quitAcknowledged, Number(args.intent));
      return null;
    case "get_app_config":
      return { ...config };
    case "get_usage_sync_status":
      return syncStatus();
    case "start_usage_sync":
      return { ...syncStatus(args.requestId, true), synced: false };
    case "save_api_key":
      config = baseConfig();
      return { config, balance };
    case "save_usage_token":
      config = baseConfig();
      return config;
    case "fetch_balance":
      return balance;
    case "fetch_usage":
      return { models: [], rawModels: [], days: [], monthCost: 0 };
    case "is_main_window_visible":
      return true;
    case "begin_tray_balance_session":
      return 1;
    case "update_tray_balance":
      return true;
    case "get_alert_status":
      return structuredClone(alerts);
    case "save_alert_options":
      alerts.options = args.options;
      return structuredClone(alerts);
    case "get_desktop_options":
      return { alwaysOnTop: false, shortcutEnabled: false, error: null };
    default:
      return null;
  }
};
let state;
function Probe() {
  state = useSettingsState();
  return null;
}
let renderer;
const flush = async () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
const nodeMock = (element) => {
  const name = element.type === "summary" ? "data-summary" : "usage-target";
  const node = {
    scrollTo: noop,
    scrollIntoView: noop,
    setAttribute: noop,
    focus: () => {
      focus.push(name);
      g.document.activeElement = node;
    },
    querySelector: (selector = "") => {
      // R29: App now locates the real settings targets through its stage ref;
      // the stronger lifecycle/cancellation fixture lives in the directed suite.
      const target = selector.match(/data-settings-focus="(\w+)"/);
      const disclosure = selector.includes("data-settings-disclosure");
      if (target || disclosure) {
        const attribute = target
          ? "data-settings-focus"
          : "data-settings-disclosure";
        const value = target?.[1] ?? "dataNotices";
        const matches = () =>
          renderer?.root.findAllByProps({ [attribute]: value }) ?? [];
        if (matches().length === 0) return null;
        const selected = {
          get isConnected() {
            return matches().length > 0;
          },
          open: false,
          closest: () => null,
          getClientRects: () => (matches().length ? [{}] : []),
          scrollIntoView: noop,
          focus: () => {
            focus.push(
              value === "usageToken" ? "usage-target" : "data-summary",
            );
            g.document.activeElement = selected;
          },
        };
        return selected;
      }
      return {
        setAttribute: noop,
        focus: () => focus.push("generic-heading"),
      };
    },
  };
  return node;
};
const mount = async (element, concurrent) => {
  await act(async () => {
    renderer = Renderer.create(<React.StrictMode>{element}</React.StrictMode>, {
      createNodeMock: nodeMock,
      unstable_isConcurrent: concurrent,
      unstable_strictMode: true,
    });
  });
  await flush();
};
const textOf = (node) =>
  typeof node === "string"
    ? node
    : (node?.children?.map(textOf).join("") ?? "");
const button = (label) =>
  renderer.root.findAllByType("button").find((node) => textOf(node) === label);
const input = (label) => renderer.root.findByProps({ "aria-label": label });
const click = async (node) => {
  assert.ok(node);
  await act(async () => node.props.onClick());
  await flush();
};
const change = async (label, value) => {
  await act(async () => input(label).props.onChange({ target: { value } }));
  await flush();
};
const emit = async (name, payload) => {
  if (name === "quit-requested") quitIssued += 1;
  await act(async () => {
    for (const fn of g.__settingsListeners.get(name) ?? []) fn({ payload });
  });
  await flush();
};
const drainFrames = async () => {
  await act(async () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      fn();
    }
  });
  await flush();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const finish = async (pending, value) => {
  await act(async () => pending.resolve(value));
  await flush();
};
const panel = (name) =>
  renderer.root.findAllByProps({ "data-testid": `${name}-panel` }).length;
const prompt = () =>
  renderer.root.findAllByProps({ role: "alertdialog" }).length;
const openSettings = async (concurrent) => {
  await mount(<App />, concurrent);
  await click(input("设置"));
};
const manual = async () => click(button("方式二：手动粘贴 token"));
const leave = async (decision = "保存并离开") => {
  await click(input("返回主面板"));
  await click(button(decision));
};
const toggleAlerts = async () => {
  const toggle = renderer.root
    .findAllByType("label")
    .find((node) => textOf(node) === "启用提醒")
    .findByType("input");
  await act(async () => toggle.props.onChange({ target: { checked: true } }));
  await flush();
};
const submitted = (command) =>
  calls.filter((entry) => entry.command === command);
function scenario(name, body) {
  for (const concurrent of [false, true])
    test(`${name} (${concurrent ? "concurrent" : "legacy"}, StrictMode)`, async () => {
      calls = [];
      quitAcknowledged = quitIssued;
      handlers = {};
      config = baseConfig();
      alerts = defaultAlerts();
      setCommittedConfig(null);
      storage.clear();
      focus.length = 0;
      frames.clear();
      timeouts.clear();
      g.__settingsListen = undefined;
      try {
        await body(concurrent);
        assert.equal(
          [...storage.values()].some((value) =>
            /DRAFT|TOKEN|SYNTHETIC_K/.test(value),
          ),
          false,
        );
      } finally {
        if (renderer) {
          await act(async () => renderer.unmount());
          renderer = null;
        }
        await flush();
      }
    });
}

scenario(
  "R07: key save preserves B and ABA edits, stays on settings",
  async (concurrent) => {
    for (const edits of [["DRAFT_B"], ["DRAFT_B", "DRAFT_A"], ["DRAFT_A"]]) {
      const pending = deferred();
      handlers.save_api_key = () => pending.promise;
      await openSettings(concurrent);
      await change("API Key", "DRAFT_A");
      await leave();
      for (const edit of edits) await change("API Key", edit);
      await finish(pending, { config: baseConfig(), balance });
      assert.equal(panel("settings"), 1);
      assert.equal(input("API Key").props.value, edits.at(-1));
      assert.equal(prompt(), 1);
      await act(async () => renderer.unmount());
      renderer = null;
    }
    assert.equal(submitted("save_api_key").length, 3);
  },
);
scenario("R07: token save preserves newer token", async (concurrent) => {
  const pending = deferred();
  handlers.save_usage_token = () => pending.promise;
  await openSettings(concurrent);
  await manual();
  await change("用量 Token", "TOKEN_A");
  await leave();
  await change("用量 Token", "TOKEN_B");
  await finish(pending, baseConfig());
  assert.equal(panel("settings"), 1);
  assert.equal(input("用量 Token").props.value, "TOKEN_B");
});
scenario(
  "R07: new participant during save is not implicitly submitted",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await manual();
    await change("API Key", "DRAFT_A");
    await leave();
    await change("用量 Token", "TOKEN_B");
    await toggleAlerts();
    await finish(pending, { config: baseConfig(), balance });
    assert.equal(panel("settings"), 1);
    assert.equal(submitted("save_usage_token").length, 0);
    assert.equal(submitted("save_alert_options").length, 0);
  },
);
scenario(
  "R07: page transaction captures token and alert versions before first await",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await manual();
    await change("API Key", "DRAFT_A");
    await change("用量 Token", "TOKEN_A");
    await toggleAlerts();
    await leave();
    await change("用量 Token", "TOKEN_B");
    await finish(pending, { config: baseConfig(), balance });
    assert.deepEqual(
      submitted("save_usage_token").map((entry) => entry.args.usageToken),
      ["TOKEN_A"],
    );
    assert.equal(input("用量 Token").props.value, "TOKEN_B");
    assert.equal(panel("settings"), 1);
  },
);
scenario(
  "R07: all initially dirty participants save and then leave",
  async (concurrent) => {
    await openSettings(concurrent);
    await manual();
    await change("API Key", "DRAFT_A");
    await change("用量 Token", "TOKEN_A");
    await toggleAlerts();
    await leave();
    assert.equal(panel("dashboard"), 1);
    for (const command of [
      "save_api_key",
      "save_usage_token",
      "save_alert_options",
    ])
      assert.equal(submitted(command).length, 1);
  },
);
scenario(
  "R07: partial failure keeps failed token and does not repeat successful key",
  async (concurrent) => {
    handlers.save_usage_token = () =>
      Promise.reject(new Error("Synthetic failure"));
    await openSettings(concurrent);
    await manual();
    await change("API Key", "DRAFT_A");
    await change("用量 Token", "TOKEN_A");
    await leave();
    assert.equal(input("API Key").props.value, "");
    assert.equal(input("用量 Token").props.value, "TOKEN_A");
    handlers.save_usage_token = () => baseConfig();
    await click(button("保存并离开"));
    assert.equal(panel("dashboard"), 1);
    assert.equal(submitted("save_api_key").length, 1);
  },
);
scenario(
  "R07: cancel keeps page after slow success and double click does not resubmit",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_A");
    await leave();
    await click(button("保存中…"));
    await click(button("留在此页"));
    await finish(pending, { config: baseConfig(), balance });
    assert.equal(panel("settings"), 1);
    assert.equal(prompt(), 0);
    assert.equal(submitted("save_api_key").length, 1);
  },
);
scenario(
  "R08: discard all drafts removes blocker across navigation, tray exit, and remount",
  async (concurrent) => {
    await openSettings(concurrent);
    await manual();
    await change("API Key", "DRAFT_A");
    await change("用量 Token", "TOKEN_A");
    await toggleAlerts();
    await leave("放弃修改并离开");
    assert.equal(panel("dashboard"), 1);
    await click(button("历史"));
    assert.equal(prompt(), 0);
    assert.equal(renderer.root.findAllByType(HistoryPanel).length, 1);
    await act(async () =>
      renderer.root.findByType(HistoryPanel).props.onBack(),
    );
    await flush();
    await emit("quit-requested", null);
    assert.equal(prompt(), 0);
    assert.equal(submitted("confirm_quit").length, 1);
    await click(input("设置"));
    await manual();
    assert.equal(input("API Key").props.value, "");
    assert.equal(input("用量 Token").props.value, "");
    assert.equal(submitted("save_api_key").length, 0);
    assert.equal(submitted("save_usage_token").length, 0);
  },
);
scenario(
  "R08: old disposer cannot unregister a newer owner",
  async (concurrent) => {
    let guard;
    function GuardProbe() {
      guard = useLeaveGuard();
      return null;
    }
    await mount(<GuardProbe />, concurrent);
    const old = {
      dirty: true,
      subject: "old",
      save: async () => true,
      discard: noop,
    };
    const next = { ...old, subject: "new" };
    const dispose = guard.register(old);
    const disposeNext = guard.register(next);
    dispose();
    assert.equal(guard.blocker.current, next);
    disposeNext();
    assert.equal(guard.blocker.current, null);
  },
);
scenario(
  "R09: forget response and duplicate events preserve new same-text generations",
  async (concurrent) => {
    const pending = deferred();
    handlers.forget_usage_session = () => pending.promise;
    await openSettings(concurrent);
    await manual();
    await change("用量 Token", "TOKEN_A");
    await click(button("退出并忘记账户"));
    await click(button("确认清除"));
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    await change("用量 Token", "TOKEN_B");
    await change("用量 Token", "TOKEN_A");
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    await finish(pending, baseConfig({ usageTokenConfigured: false }));
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    assert.equal(input("用量 Token").props.value, "TOKEN_A");
    await click(input("返回主面板"));
    assert.equal(prompt(), 1);
  },
);
scenario(
  "R09: unowned events do not clear candidates; unchanged forget clears once",
  async (concurrent) => {
    const pending = deferred();
    handlers.forget_usage_session = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("TOKEN_A"));
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    assert.equal(state.usageToken, "TOKEN_A");
    await act(async () => state.forgetUsageSession());
    await finish(pending, baseConfig({ usageTokenConfigured: false }));
    assert.equal(state.usageToken, "");
    await act(async () => state.setUsageToken("TOKEN_A"));
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    assert.equal(state.usageToken, "TOKEN_A");
  },
);
scenario(
  "R19: failed forget retries retain results across remount without consuming its new draft",
  async (concurrent) => {
    const pending = deferred();
    handlers.forget_usage_session = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("TOKEN_A"));
    await act(async () => state.forgetUsageSession());
    await act(async () => pending.reject(new Error("Synthetic failure")));
    await flush();
    assert.equal(state.busy, false);
    assert.equal(state.usageToken, "TOKEN_A");
    const retry = deferred();
    handlers.forget_usage_session = () => retry.promise;
    await act(async () => state.forgetUsageSession());
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("TOKEN_A"));
    await finish(retry, baseConfig({ usageTokenConfigured: false }));
    assert.equal(state.usageToken, "TOKEN_A");
    assert.match(state.usageStatus, /已清除监控 Token 和应用内网页登录数据/);
    assert.equal(state.busy, false);
  },
);
scenario("R14: ordinary settings takes heading focus", async (concurrent) => {
  await openSettings(concurrent);
  await drainFrames();
  assert.deepEqual(focus, ["generic-heading"]);
});
scenario(
  "R14: Token deep link owns focus without generic heading stealing it",
  async (concurrent) => {
    await mount(<App />, concurrent);
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onHistory(),
    );
    await flush();
    await drainFrames();
    focus.length = 0;
    await act(async () =>
      renderer.root.findByType(HistoryPanel).props.onConfigureUsage(),
    );
    await flush();
    await drainFrames();
    assert.deepEqual(focus, ["usage-target"]);
    assert.ok(g.document.activeElement);
  },
);
scenario(
  "R14: account and detail data links focus expanded summary",
  async (concurrent) => {
    await mount(<App />, concurrent);
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onDataStatus(),
    );
    await flush();
    await drainFrames();
    assert.deepEqual(focus, ["data-summary"]);
    await click(input("返回主面板"));
    await drainFrames();
    focus.length = 0;
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onDetail("flash"),
    );
    await flush();
    await drainFrames();
    focus.length = 0;
    await act(async () =>
      renderer.root.findByType(ModelDetailPanel).props.onDataStatus(),
    );
    await flush();
    await drainFrames();
    assert.deepEqual(focus, ["data-summary"]);
  },
);
scenario(
  "R14: dismissed target cancels stale focus RAF",
  async (concurrent) => {
    await mount(<App />, concurrent);
    await act(async () =>
      renderer.root.findByType(DashboardPanel).props.onDataStatus(),
    );
    await flush();
    await click(input("返回主面板"));
    await drainFrames();
    assert.deepEqual(focus, ["generic-heading"]);
  },
);
scenario(
  "R07: alert edits during credential save keep their new revision",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_A");
    await toggleAlerts();
    await leave();
    await change("余额提醒线", "20");
    await finish(pending, { config: baseConfig(), balance });
    assert.equal(panel("settings"), 1);
    assert.equal(input("余额提醒线").props.value, "20");
    assert.equal(
      submitted("save_alert_options")[0].args.options.lowBalanceCny,
      10,
    );
    await click(button("保存并离开"));
    assert.equal(panel("dashboard"), 1);
    assert.equal(
      submitted("save_alert_options")[1].args.options.lowBalanceCny,
      20,
    );
  },
);
scenario(
  "R07: synchronous edit and leave before an effect cannot bypass guard",
  async (concurrent) => {
    await openSettings(concurrent);
    await act(async () => {
      input("API Key").props.onChange({ target: { value: "DRAFT_A" } });
      input("返回主面板").props.onClick();
    });
    await flush();
    assert.equal(panel("settings"), 1);
    assert.equal(prompt(), 1);
  },
);
scenario(
  "R07: latest tray intent cannot bypass new draft on old save success",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_A");
    await leave();
    await emit("quit-requested", null);
    await change("API Key", "DRAFT_B");
    await finish(pending, { config: baseConfig(), balance });
    assert.equal(panel("settings"), 1);
    assert.equal(submitted("confirm_quit").length, 0);
    assert.equal(input("API Key").props.value, "DRAFT_B");
    assert.equal(prompt(), 1);
  },
);
scenario(
  "R07: latest tray intent is fulfilled once when every draft is clean",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_A");
    await leave();
    await emit("quit-requested", null);
    await finish(pending, { config: baseConfig(), balance });
    assert.equal(submitted("confirm_quit").length, 1);
    assert.equal(prompt(), 0);
  },
);
scenario(
  "R08: key-only and token-only discards never resubmit on later navigation",
  async (concurrent) => {
    for (const label of ["API Key", "用量 Token"]) {
      await openSettings(concurrent);
      if (label === "用量 Token") await manual();
      await change(label, "DRAFT_A");
      await leave("放弃修改并离开");
      await click(button("历史"));
      assert.equal(prompt(), 0);
      assert.equal(renderer.root.findAllByType(HistoryPanel).length, 1);
      await act(async () => renderer.unmount());
      renderer = null;
    }
    assert.equal(
      submitted("save_api_key").length + submitted("save_usage_token").length,
      0,
    );
  },
);
scenario(
  "R09: forget A to event to same A preserves new input, not just unequal B",
  async (concurrent) => {
    const pending = deferred();
    handlers.forget_usage_session = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("TOKEN_A"));
    await act(async () => state.forgetUsageSession());
    await emit(
      "usage-token-cleared",
      baseConfig({ usageTokenConfigured: false }),
    );
    await act(async () => state.setUsageToken("TOKEN_A"));
    await finish(pending, baseConfig({ usageTokenConfigured: false }));
    assert.equal(state.usageToken, "TOKEN_A");
    assert.equal(state.config.usageTokenConfigured, false);
  },
);
scenario(
  "R07: cancelled and restarted alert transaction reuses in-flight save",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_alert_options = () => pending.promise;
    await openSettings(concurrent);
    await toggleAlerts();
    await leave();
    await click(button("留在此页"));
    await leave();
    assert.equal(submitted("save_alert_options").length, 1);
    await finish(pending, {
      ...defaultAlerts(),
      options: { ...defaultAlerts().options, enabled: true },
    });
    assert.equal(panel("dashboard"), 1);
    assert.equal(submitted("save_alert_options").length, 1);
  },
);

const startKeySave = async () => {
  await act(async () => {
    button("验证并保存").props.onClick();
  });
  await flush();
};
const dashboard = () => renderer.root.findByType(DashboardPanel).props;
const nextCredentialConfig = (kind, configured) => {
  const previous = getCommittedConfig() ?? config;
  const next = { ...previous, configRevision: ++fixtureRevision };
  next[`${kind}Revision`] = next.configRevision;
  next[`${kind}Configured`] = configured;
  if (kind === "apiKey" && !configured) next.apiKeyPreview = null;
  return next;
};

scenario(
  "N05: ordinary Key clear converges after settings unmount, including tray",
  async (concurrent) => {
    const pending = deferred();
    handlers.clear_api_key = () => pending.promise;
    await openSettings(concurrent);
    await click(button("清除 Key"));
    await click(input("返回主面板"));
    assert.equal(panel("dashboard"), 1);
    const cleared = nextCredentialConfig("apiKey", false);
    config = cleared;
    await finish(pending, cleared);
    assert.equal(getCommittedConfig().apiKeyConfigured, false);
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().balanceState, "nokey");
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
    const callsBeforeDuplicate = submitted("fetch_balance").length;
    await emit("credential-config-changed", cleared);
    assert.equal(submitted("fetch_balance").length, callsBeforeDuplicate);
    assert.equal(dashboard().balance, null);
  },
);

scenario(
  "N05: ordinary Token clear after unmount invalidates history and late usage",
  async (concurrent) => {
    const pending = deferred();
    handlers.clear_usage_token = () => pending.promise;
    await mount(<App />, concurrent);
    const oldFetch = deferred();
    handlers.fetch_usage = () => oldFetch.promise;
    await act(async () => {
      dashboard().onRefresh();
    });
    await flush();
    await click(input("设置"));
    const epoch = historyCache.epoch();
    await click(button("清除 Token"));
    await click(input("返回主面板"));
    const cleared = nextCredentialConfig("usageToken", false);
    config = cleared;
    await finish(pending, cleared);
    assert.ok(historyCache.epoch() > epoch);
    assert.equal(dashboard().usage, null);
    assert.equal(dashboard().usageState, "nokey");
    await finish(oldFetch, {
      models: [],
      rawModels: [],
      days: [],
      monthCost: 999,
    });
    assert.equal(dashboard().usage, null);
    assert.equal(dashboard().usageState, "nokey");
  },
);

scenario(
  "N05: saved Key survives discard/unmount without consuming the new page draft",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_B");
    await startKeySave();
    await leave("放弃修改并离开");
    await click(input("设置"));
    await change("API Key", "DRAFT_C");
    const saved = nextCredentialConfig("apiKey", true);
    config = saved;
    await finish(pending, {
      config: saved,
      balance: { ...balance, totalBalance: "222" },
    });
    assert.equal(input("API Key").props.value, "DRAFT_C");
    assert.equal(getValidatedBalance().balance.totalBalance, "222");
    await leave("放弃修改并离开");
    assert.equal(dashboard().balance.totalBalance, "222");
    assert.equal(submitted("save_api_key").length, 1);
  },
);

scenario(
  "N05: old Key completion cannot replace a newer page commit or resurrect after clear",
  async (concurrent) => {
    const first = deferred();
    const second = deferred();
    handlers.save_api_key = () => first.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_B");
    await startKeySave();
    const oldConfig = nextCredentialConfig("apiKey", true);
    await leave("放弃修改并离开");
    await click(input("设置"));
    handlers.save_api_key = () => second.promise;
    await change("API Key", "DRAFT_C");
    await startKeySave();
    const newest = nextCredentialConfig("apiKey", true);
    config = newest;
    await finish(second, {
      config: newest,
      balance: { ...balance, totalBalance: "333" },
    });
    await finish(first, {
      config: oldConfig,
      balance: { ...balance, totalBalance: "222" },
    });
    assert.equal(getCommittedConfig(), newest);
    assert.equal(getValidatedBalance().balance.totalBalance, "333");
    const cleared = nextCredentialConfig("apiKey", false);
    config = cleared;
    await emit("credential-config-changed", cleared);
    await emit("credential-config-changed", oldConfig);
    await click(input("返回主面板"));
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().balanceState, "nokey");
  },
);

scenario(
  "N05: failed save after leaving preserves previous account snapshot",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    const previous = getCommittedConfig();
    await change("API Key", "DRAFT_B");
    await startKeySave();
    await leave("放弃修改并离开");
    await act(async () =>
      pending.reject(new Error("Synthetic validation failure")),
    );
    await flush();
    assert.equal(getCommittedConfig(), previous);
    assert.equal(dashboard().balance.totalBalance, "100");
  },
);

scenario(
  "N05: captured/cleared/forget responses in reverse order retain newest Token and draft",
  async (concurrent) => {
    const pending = deferred();
    handlers.forget_usage_session = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.forgetUsageSession());
    const cleared = nextCredentialConfig("usageToken", false);
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("TOKEN_C"));
    const captured = nextCredentialConfig("usageToken", true);
    await emit("usage-token-captured", capturedPayload(captured));
    await finish(pending, cleared);
    await emit("usage-token-cleared", cleared);
    await emit("usage-token-captured", capturedPayload(captured));
    assert.equal(getCommittedConfig(), captured);
    assert.equal(state.usageToken, "TOKEN_C");
    assert.equal(state.config.usageTokenConfigured, true);
    assert.match(state.usageStatus, /^用量 Token 已配置。此前的/);
    assert.match(state.usageStatus, /后续新登录或保存的账户不在该次清理范围内/);
  },
);

scenario(
  "N05: old balance fetch after clear cannot restore dashboard or tray",
  async (concurrent) => {
    await mount(<App />, concurrent);
    const oldFetch = deferred();
    handlers.fetch_balance = () => oldFetch.promise;
    await act(async () => {
      dashboard().onRefresh();
    });
    await flush();
    const cleared = nextCredentialConfig("apiKey", false);
    config = cleared;
    await emit("credential-config-changed", cleared);
    await finish(oldFetch, { ...balance, totalBalance: "999" });
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().balanceState, "nokey");
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
  },
);

scenario(
  "N05: Token save response after discard leaves global state configured without consuming new draft",
  async (concurrent) => {
    config = baseConfig({ usageTokenConfigured: false });
    const pending = deferred();
    handlers.save_usage_token = () => pending.promise;
    await openSettings(concurrent);
    await manual();
    await change("用量 Token", "TOKEN_B");
    await leave();
    await click(button("放弃修改并离开"));
    await click(input("设置"));
    await manual();
    await change("用量 Token", "TOKEN_C");
    const saved = nextCredentialConfig("usageToken", true);
    config = saved;
    await finish(pending, saved);
    assert.equal(input("用量 Token").props.value, "TOKEN_C");
    assert.equal(getCommittedConfig().usageTokenConfigured, true);
    await leave("放弃修改并离开");
    assert.equal(dashboard().usageState, "ok");
    assert.equal(submitted("save_usage_token").length, 1);
  },
);

scenario(
  "N05: failed ordinary clear after unmount retains configured Key and balance",
  async (concurrent) => {
    const pending = deferred();
    handlers.clear_api_key = () => pending.promise;
    await openSettings(concurrent);
    await click(button("清除 Key"));
    await click(input("返回主面板"));
    await act(async () => pending.reject(new Error("Synthetic write failure")));
    await flush();
    assert.equal(getCommittedConfig().apiKeyConfigured, true);
    assert.equal(dashboard().balance.totalBalance, "100");
  },
);

scenario(
  "N05: newer 401 after save event cannot be undone by the late verification receipt",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_B");
    await startKeySave();
    const saved = nextCredentialConfig("apiKey", true);
    config = saved;
    handlers.fetch_balance = () =>
      Promise.reject({
        message: "Synthetic revoked credential",
        code: "credentials_invalid",
      });
    await emit("credential-config-changed", saved);
    await finish(pending, {
      config: saved,
      balance: { ...balance, totalBalance: "222" },
    });
    await click(input("返回主面板"));
    assert.equal(dashboard().balance, null);
    assert.equal(getValidatedBalance(), null);
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
  },
);

scenario(
  "N05: newer balance fetch wins over the older verification balance for the same Key",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_B");
    await startKeySave();
    const saved = nextCredentialConfig("apiKey", true);
    config = saved;
    handlers.fetch_balance = () => ({ ...balance, totalBalance: "444" });
    await emit("credential-config-changed", saved);
    await finish(pending, {
      config: saved,
      balance: { ...balance, totalBalance: "222" },
    });
    await click(input("返回主面板"));
    assert.equal(dashboard().balance.totalBalance, "444");
    assert.equal(submitted("update_tray_balance").at(-1).args.total, "444");
  },
);

scenario(
  "N05: preference failure after unmount never changes committed scheduler settings",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_auto_refresh_enabled = () => pending.promise;
    await mount(<Probe />, concurrent);
    const previous = getCommittedConfig();
    await act(async () => state.saveAutoRefreshEnabled(true));
    assert.equal(
      state.autoRefresh,
      true,
      "only the mounted control is optimistic",
    );
    assert.equal(getCommittedConfig(), previous);
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    await act(async () =>
      pending.reject(new Error("Synthetic preference failure")),
    );
    await flush();
    assert.equal(getCommittedConfig().autoRefreshEnabled, false);
    assert.equal(state.autoRefresh, false);
  },
);

scenario(
  "N05: old preference failure cannot roll back a newer committed preference",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_refresh_interval = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.saveRefreshInterval(300));
    const newer = {
      ...getCommittedConfig(),
      configRevision: ++fixtureRevision,
      refreshIntervalSeconds: 1800,
    };
    await act(async () => {
      setCommittedConfig(newer);
    });
    await act(async () =>
      pending.reject(new Error("Synthetic preference failure")),
    );
    await flush();
    assert.equal(state.refresh, 1800);
    assert.equal(getCommittedConfig().refreshIntervalSeconds, 1800);
  },
);

scenario(
  "N05: verification receipt cannot cancel the newer in-flight balance rejection",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_api_key = () => pending.promise;
    await openSettings(concurrent);
    await change("API Key", "DRAFT_B");
    await startKeySave();
    const saved = nextCredentialConfig("apiKey", true);
    config = saved;
    const freshFetch = deferred();
    handlers.fetch_balance = () => freshFetch.promise;
    await emit("credential-config-changed", saved);
    await finish(pending, {
      config: saved,
      balance: { ...balance, totalBalance: "222" },
    });
    await act(async () =>
      freshFetch.reject({
        message: "Synthetic revoked credential",
        code: "credentials_invalid",
      }),
    );
    await flush();
    await click(input("返回主面板"));
    assert.equal(dashboard().balance, null);
    assert.equal(getValidatedBalance(), null);
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
  },
);

scenario(
  "N05: duplicate captured commit cannot end a newer login attempt",
  async (concurrent) => {
    await mount(<Probe />, concurrent);
    const captured = nextCredentialConfig("usageToken", true);
    await emit("usage-token-captured", capturedPayload(captured));
    const pending = deferred();
    handlers.start_usage_sync = () => pending.promise;
    await act(async () => state.startUsageSync());
    await emit("usage-token-captured", capturedPayload(captured));
    assert.equal(state.usageSyncing, true);
    await finish(pending, {
      ...syncStatus(submitted("start_usage_sync").at(-1).args.requestId, true),
      synced: false,
    });
    assert.equal(state.usageSyncing, true);
  },
);

// DeepSeek-only scope: navigation and configuration must never initialize the
// removed local collection, retention or cleanup paths, including legacy events.
const assertNoLocalIpc = () => {
  assert.deepEqual(
    calls.filter(({ command }) => /local_|retention|archive/.test(command)),
    [],
  );
  assert.equal(
    (g.__settingsListeners.get("local-settings-changed") ?? new Set()).size,
    0,
  );
};

scenario(
  "DeepSeek-only: account, history, settings and tray close remain available",
  async (concurrent) => {
    await mount(<App />, concurrent);
    assert.equal(panel("dashboard"), 1);
    assert.equal(panel("onboarding"), 0);
    const navigation = renderer.root.findByProps({ "aria-label": "主导航" });
    assert.deepEqual(
      navigation
        .findAllByType("button")
        .filter((node) => !node.props["aria-label"])
        .map(textOf),
      ["账户", "历史"],
    );
    assert.ok(submitted("fetch_balance").length > 0);
    assert.ok(submitted("fetch_usage").length > 0);
    assert.ok(submitted("update_tray_balance").length > 0);
    await click(button("历史"));
    assert.equal(panel("history"), 1);
    assert.equal(button("历史").props["aria-current"], "page");
    assert.equal(textOf(renderer.toJSON()).includes("项目与会话"), false);
    await click(button("账户"));
    assert.equal(panel("dashboard"), 1);
    await click(input("设置"));
    assert.equal(panel("settings"), 1);
    assert.ok(submitted("get_desktop_options").length > 0);
    assert.ok(submitted("get_alert_status").length > 0);
    await click(input("返回主面板"));
    await emit("local-settings-changed", 1);
    await click(input("关闭"));
    assert.equal(submitted("hide_main_window").length, 1);
    assertNoLocalIpc();
  },
);

scenario(
  "DeepSeek-only: first configuration waits only for account config and opens platform settings",
  async (concurrent) => {
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
    });
    const pending = deferred();
    handlers.get_app_config = () => pending.promise;
    await mount(<App />, concurrent);
    assert.equal(panel("onboarding"), 0);
    await finish(pending, config);
    assert.equal(panel("onboarding"), 1);
    const tasks = renderer.root.findAllByProps({
      className: "onboarding-task",
    });
    assert.equal(tasks.length, 2);
    assert.ok(tasks.some((node) => textOf(node).includes("只看余额")));
    await click(tasks.find((node) => textOf(node).includes("平台消费与历史")));
    assert.equal(panel("settings"), 1);
    await drainFrames();
    assert.ok(focus.includes("usage-target"));
    await click(input("返回主面板"));
    assert.equal(panel("onboarding"), 0);
    assertNoLocalIpc();
  },
);

scenario(
  "DeepSeek-only: dismissing first configuration leaves the account panel usable",
  async (concurrent) => {
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
    });
    await mount(<App />, concurrent);
    assert.equal(panel("onboarding"), 1);
    await click(button("我已了解，先不配置"));
    assert.equal(panel("dashboard"), 1);
    assert.equal(panel("onboarding"), 0);
    await click(button("历史"));
    await click(button("账户"));
    assert.equal(panel("onboarding"), 0);
    assertNoLocalIpc();
  },
);

scenario(
  "N09: settings only displays the accepted snapshot on an equal-version conflict",
  async (concurrent) => {
    const trusted = config;
    setCommittedConfig(trusted);
    handlers.get_app_config = () => ({ ...trusted, apiKeyConfigured: false });
    await mount(<Probe />, concurrent);
    assert.equal(getCommittedConfig(), trusted);
    assert.equal(state.config, trusted);
    assert.match(state.status, /配置版本/);
  },
);

scenario(
  "N09: unavailable disk snapshot clears dashboard data and disables settings preferences",
  async (concurrent) => {
    await mount(<App />, concurrent);
    const unavailable = baseConfig({
      apiKeyConfigured: false,
      apiKeyPreview: null,
      usageTokenConfigured: false,
      configReadError: "Synthetic unreadable configuration",
    });
    config = unavailable;
    await emit("credential-config-changed", unavailable);
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().usage, null);
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    assert.equal(state.refresh, null);
    assert.equal(state.autoRefresh, null);
    assert.equal(state.autostart, null);
    assert.equal(state.config, unavailable);
  },
);

scenario(
  "N10: manual failure stops old web progress immediately and ignores its late start",
  async (concurrent) => {
    const web = deferred();
    const manualSave = deferred();
    handlers.start_usage_sync = () => web.promise;
    handlers.save_usage_token = () => manualSave.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    const oldRequest = submitted("start_usage_sync").at(-1).args.requestId;
    await act(async () => state.setUsageToken("SYNTHETIC_INVALID_TOKEN"));
    let saving;
    await act(async () => {
      saving = state.saveUsageToken();
    });
    assert.equal(state.usageSyncing, false);
    await finish(web, { ...syncStatus(oldRequest, true), synced: false });
    assert.equal(state.usageSyncing, false);
    await act(async () =>
      manualSave.reject(new Error("Synthetic verification failed")),
    );
    assert.equal(await saving, false);
    assert.equal(state.busy, false);
    assert.equal(state.usageSyncing, false);
    assert.equal(state.config.usageTokenConfigured, true);
    assert.equal(state.usageToken, "SYNTHETIC_INVALID_TOKEN");
  },
);

scenario(
  "N10: first delayed capture and ended events cannot stop a new session after remount",
  async (concurrent) => {
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    const firstRequest = submitted("start_usage_sync").at(-1).args.requestId;
    const oldSession = syncStatus(firstRequest, false);
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    const waitingStatus = state.usageStatus;
    const captured = nextCredentialConfig("usageToken", true);
    await emit("usage-token-captured", capturedPayload(captured, oldSession));
    await emit("usage-sync-ended", oldSession);
    assert.equal(getCommittedConfig(), captured);
    assert.equal(state.usageSyncing, true);
    assert.equal(state.usageStatus, waitingStatus);
  },
);

scenario(
  "N10: old manual failure and old cancel reply leave newer web progress intact",
  async (concurrent) => {
    const pending = deferred();
    handlers.save_usage_token = () => pending.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN"));
    let saving;
    await act(async () => {
      saving = state.saveUsageToken();
    });
    const manualRequest = submitted("save_usage_token").at(-1).args.requestId;
    await act(async () => state.startUsageSync());
    await emit("usage-sync-ended", syncStatus(manualRequest, false, "manual"));
    await act(async () => pending.reject(new Error("Synthetic old failure")));
    assert.equal(await saving, false);
    assert.equal(state.usageSyncing, true);
    const cancel = deferred();
    handlers.cancel_usage_sync = () => cancel.promise;
    await act(async () => state.cancelUsageSync());
    const cancelled = submitted("cancel_usage_sync").at(-1).args;
    await act(async () => state.startUsageSync());
    await finish(cancel, { ...cancelled, active: false, kind: "web" });
    assert.equal(state.usageSyncing, true);
  },
);

scenario(
  "N10: cancel no-op after capture re-reads saved state instead of claiming old Token unchanged",
  async (concurrent) => {
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    const request = submitted("start_usage_sync").at(-1).args.requestId;
    const saved = nextCredentialConfig("usageToken", true);
    config = saved;
    handlers.cancel_usage_sync = () => null;
    handlers.get_usage_sync_status = () => syncStatus(request, false);
    await act(async () => state.cancelUsageSync());
    await flush();
    assert.deepEqual(getCommittedConfig(), saved);
    assert.equal(state.usageSyncing, false);
    assert.doesNotMatch(state.usageStatus, /原 Token 未更改|已取消/);
  },
);

scenario(
  "N10: remount status read crossing terminal event re-reads instead of reviving login",
  async (concurrent) => {
    const reading = deferred();
    const first = syncStatus("previous-page", true);
    const terminal = { ...first, active: false };
    let reads = 0;
    handlers.get_usage_sync_status = () =>
      ++reads === 1 ? reading.promise : terminal;
    await mount(<Probe />, concurrent);
    await emit("usage-sync-ended", terminal);
    await finish(reading, first);
    assert.equal(reads, 2);
    assert.equal(state.usageSyncing, false);
  },
);

for (const [command, action, value, field] of [
  ["save_refresh_interval", "saveRefreshInterval", 300, "refresh"],
  ["save_auto_refresh_enabled", "saveAutoRefreshEnabled", true, "autoRefresh"],
  ["save_autostart", "saveAutostart", true, "autostart"],
]) {
  for (const succeeds of [false, true]) {
    scenario(
      `N09: late ${command} ${succeeds ? "success" : "failure"} cannot re-enable untrusted controls`,
      async (concurrent) => {
        const pending = deferred();
        handlers[command] = () => pending.promise;
        await mount(<Probe />, concurrent);
        const oldSuccess = baseConfig();
        await act(async () => state[action](value));
        const unavailable = baseConfig({
          apiKeyConfigured: false,
          apiKeyPreview: null,
          usageTokenConfigured: false,
          configReadError: "Synthetic unreadable configuration",
        });
        await act(async () => setCommittedConfig(unavailable));
        assert.equal(state[field], null);
        if (succeeds) await finish(pending, oldSuccess);
        else
          await act(async () =>
            pending.reject(new Error("Synthetic disk failure")),
          );
        await flush();
        assert.equal(state.refresh, null);
        assert.equal(state.autoRefresh, null);
        assert.equal(state.autostart, null);
        assert.equal(getCommittedConfig(), unavailable);
      },
    );
  }
}

// R14-02: the deferred IPC boundary deliberately leaves old starts unresolved.
// Rust SyncSession tests cover backend admission/commit permutations; these
// tests verify the real hook sends their identities and preserves UI ownership.
for (const [command, action] of [
  ["clear_usage_token", "clearUsageToken"],
  ["forget_usage_session", "forgetUsageSession"],
]) {
  scenario(
    `R14-02: ${command} revokes pending starts across remount and lets new explicit login reuse retained intent`,
    async (concurrent) => {
      const oldWeb = deferred();
      const oldManual = deferred();
      const clearing = deferred();
      handlers.start_usage_sync = () => oldWeb.promise;
      handlers.save_usage_token = () => oldManual.promise;
      handlers[command] = () => clearing.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      const webRequest = submitted("start_usage_sync").at(-1).args.requestId;
      await act(async () => state.setUsageToken("SYNTHETIC_MANUAL_TOKEN"));
      let saving;
      await act(async () => {
        saving = state.saveUsageToken();
      });
      const manualArgs = submitted("save_usage_token").at(-1).args;
      assert.ok(manualArgs.supersededRequestIds.includes(webRequest));
      await act(async () => renderer.unmount());
      renderer = null;
      await mount(<Probe />, concurrent);
      await act(async () => state[action]());
      const clearArgs = submitted(command).at(-1).args;
      assert.ok(clearArgs.cancelledRequestIds.includes(webRequest));
      assert.ok(clearArgs.cancelledRequestIds.includes(manualArgs.requestId));

      // Even if a fresh login is requested directly after remount, it waits
      // for the older clear. Forget's busy/notice also survives the remount.
      await act(async () => renderer.unmount());
      renderer = null;
      await mount(<Probe />, concurrent);
      const nextWeb = deferred();
      handlers.start_usage_sync = () => nextWeb.promise;
      const callsBeforeNew = submitted("start_usage_sync").length;
      await act(async () => state.startUsageSync());
      assert.equal(submitted("start_usage_sync").length, callsBeforeNew);
      const cleared = nextCredentialConfig("usageToken", false);
      config = cleared;
      await finish(clearing, cleared);
      assert.equal(submitted("start_usage_sync").length, callsBeforeNew + 1);
      const nextRequest = submitted("start_usage_sync").at(-1).args.requestId;
      assert.equal(clearArgs.cancelledRequestIds.includes(nextRequest), false);
      assert.equal(getCommittedConfig().usageTokenConfigured, false);
      assert.equal(state.usageSyncing, true);

      // Old starts rejected by Rust can finish in either order, but may not end
      // the new owner or restore the cleared global configuration.
      await act(async () =>
        oldManual.reject(new Error("Synthetic superseded manual request")),
      );
      await act(async () =>
        oldWeb.reject(new Error("Synthetic cancelled queued login")),
      );
      assert.equal(await saving, false);
      await emit("usage-sync-ended", syncStatus(webRequest, false));
      assert.equal(state.usageSyncing, true);
      assert.equal(getCommittedConfig().usageTokenConfigured, false);
      const newStatus = syncStatus(nextRequest, true);
      await finish(nextWeb, { ...newStatus, synced: false });
      const captured = nextCredentialConfig("usageToken", true);
      config = captured;
      await emit("usage-token-captured", capturedPayload(captured, newStatus));
      assert.equal(state.usageSyncing, false);
      assert.equal(getCommittedConfig(), captured);
      assert.match(state.usageStatus, /已配置/);
    },
  );
}

for (const manualSucceeds of [false, true]) {
  scenario(
    `R14-02: manual replacement ${manualSucceeds ? "success" : "failure"} revokes a web start before backend admission`,
    async (concurrent) => {
      const oldWeb = deferred();
      const manual = deferred();
      handlers.start_usage_sync = () => oldWeb.promise;
      handlers.save_usage_token = () => manual.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      const oldRequest = submitted("start_usage_sync").at(-1).args.requestId;
      await act(async () => state.setUsageToken("SYNTHETIC_NEW_TOKEN"));
      let saving;
      await act(async () => {
        saving = state.saveUsageToken();
      });
      const replacement = submitted("save_usage_token").at(-1).args;
      assert.ok(replacement.supersededRequestIds.includes(oldRequest));
      const before = getCommittedConfig();
      if (manualSucceeds) {
        config = nextCredentialConfig("usageToken", true);
        await finish(manual, config);
      } else {
        await act(async () =>
          manual.reject(new Error("Synthetic manual verification failure")),
        );
      }
      assert.equal(await saving, manualSucceeds);
      const displayed = state.usageStatus;
      await act(async () =>
        oldWeb.reject(
          new Error("Synthetic stale start rejected before cache scan"),
        ),
      );
      await emit("usage-sync-ended", syncStatus(oldRequest, false));
      assert.equal(state.usageSyncing, false);
      assert.equal(state.usageStatus, displayed);
      assert.equal(getCommittedConfig(), manualSucceeds ? config : before);
    },
  );
}

scenario(
  "R14-02: failed Token clear reports the error and does not claim success",
  async (concurrent) => {
    const oldWeb = deferred();
    const clearing = deferred();
    handlers.start_usage_sync = () => oldWeb.promise;
    handlers.clear_usage_token = () => clearing.promise;
    await mount(<Probe />, concurrent);
    const before = getCommittedConfig();
    await act(async () => state.startUsageSync());
    const oldRequest = submitted("start_usage_sync").at(-1).args.requestId;
    await act(async () => state.clearUsageToken());
    assert.ok(
      submitted("clear_usage_token")
        .at(-1)
        .args.cancelledRequestIds.includes(oldRequest),
    );
    await act(async () =>
      clearing.reject(new Error("Synthetic clear disk failure")),
    );
    await act(async () =>
      oldWeb.reject(new Error("Synthetic cancelled queued request")),
    );
    assert.equal(getCommittedConfig(), before);
    assert.equal(state.busy, false);
    assert.equal(state.usageSyncing, false);
    assert.match(state.usageStatus, /Synthetic clear disk failure/);
    assert.doesNotMatch(state.usageStatus, /已清除/);
    handlers.start_usage_sync = (args) => ({
      ...syncStatus(args.requestId, true),
      synced: false,
    });
    await act(async () => state.startUsageSync());
    assert.equal(state.usageSyncing, true);
  },
);

// Synthetic reference backend for the Key IPC contract. Revisions are created
// at commit time, never preassigned to make an old request look stale. The Rust
// command regressions separately exercise the real admission and disk helpers.
function keyBackend() {
  const revoked = new Set();
  let owner = null;
  let persisted = "SYNTHETIC_K0";
  const validations = [];
  return {
    validations,
    get persisted() {
      return persisted;
    },
    enter(args) {
      assert.equal(typeof args.requestId, "string");
      assert.ok(Array.isArray(args.supersededRequestIds));
      if (revoked.has(args.requestId) || owner === args.requestId)
        throw new Error("Synthetic cancelled Key request before validation");
      for (const id of args.supersededRequestIds) revoked.add(id);
      if (owner) revoked.add(owner);
      owner = args.requestId;
      validations.push(args.apiKey);
    },
    save(args) {
      if (owner !== args.requestId || revoked.has(args.requestId))
        throw new Error("Synthetic cancelled Key commit");
      owner = null;
      persisted = args.apiKey;
      config = nextCredentialConfig("apiKey", true);
      return { config, balance: { ...balance, totalBalance: "333" } };
    },
    fail(args) {
      if (owner === args.requestId) owner = null;
      throw new Error("Synthetic new Key verification failure");
    },
    clear(args, fails = false) {
      assert.ok(Array.isArray(args.cancelledRequestIds));
      for (const id of args.cancelledRequestIds) revoked.add(id);
      if (owner) revoked.add(owner);
      owner = null;
      if (fails) throw new Error("Synthetic Key clear disk failure");
      persisted = null;
      config = nextCredentialConfig("apiKey", false);
      return config;
    },
  };
}

scenario(
  "R15-02: discard and remount clear rejects unpolled Key save before validation or a new disk revision",
  async (concurrent) => {
    const backend = keyBackend();
    const admission = deferred();
    handlers.save_api_key = async (args) => {
      await admission.promise;
      backend.enter(args);
      return backend.save(args);
    };
    handlers.clear_api_key = (args) => backend.clear(args);
    await openSettings(concurrent);
    await change("API Key", "SYNTHETIC_K1");
    await startKeySave();
    const old = submitted("save_api_key").at(-1).args;
    await leave("放弃修改并离开");
    await click(input("设置"));
    await click(button("清除 Key"));
    const clear = submitted("clear_api_key").at(-1).args;
    assert.ok(clear.cancelledRequestIds.includes(old.requestId));
    const cleared = getCommittedConfig();
    assert.equal(backend.persisted, null);
    await finish(admission, undefined);
    assert.deepEqual(backend.validations, []);
    assert.equal(backend.persisted, null);
    assert.equal(getCommittedConfig(), cleared);
    assert.equal(input("API Key").props.value, "");
    await click(input("返回主面板"));
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().balanceState, "nokey");
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
  },
);

for (const entered of [false, true]) {
  for (const succeeds of [false, true]) {
    for (const oldRepliesFirst of [false, true]) {
      scenario(
        `R15-02: Key replacement ${succeeds ? "succeeds" : "fails"}, old ${entered ? "validating" : "unpolled"}, ${oldRepliesFirst ? "old" : "new"} replies first`,
        async (concurrent) => {
          const backend = keyBackend();
          const oldAdmission = deferred();
          const oldValidation = deferred();
          const newValidation = deferred();
          handlers.save_api_key = async (args) => {
            if (args.apiKey === "SYNTHETIC_K1") {
              if (!entered) await oldAdmission.promise;
              backend.enter(args);
              await oldValidation.promise;
              return backend.save(args);
            }
            backend.enter(args);
            await newValidation.promise;
            return succeeds ? backend.save(args) : backend.fail(args);
          };
          await openSettings(concurrent);
          const original = getCommittedConfig();
          await change("API Key", "SYNTHETIC_K1");
          await startKeySave();
          const first = submitted("save_api_key").at(-1).args;
          await leave("放弃修改并离开");
          await click(input("设置"));
          await change("API Key", "SYNTHETIC_K2");
          await startKeySave();
          const next = submitted("save_api_key").at(-1).args;
          assert.ok(next.supersededRequestIds.includes(first.requestId));
          const releaseOld = async () => {
            await finish(oldAdmission, undefined);
            await finish(oldValidation, undefined);
          };
          if (oldRepliesFirst) {
            await releaseOld();
            assert.equal(backend.persisted, "SYNTHETIC_K0");
            assert.equal(button("验证并保存").props.disabled, true);
          }
          await finish(newValidation, undefined);
          const committed = getCommittedConfig();
          if (!oldRepliesFirst) await releaseOld();
          assert.equal(
            backend.persisted,
            succeeds ? "SYNTHETIC_K2" : "SYNTHETIC_K0",
          );
          assert.equal(getCommittedConfig(), succeeds ? committed : original);
          assert.deepEqual(
            backend.validations,
            entered ? ["SYNTHETIC_K1", "SYNTHETIC_K2"] : ["SYNTHETIC_K2"],
          );
          assert.equal(
            input("API Key").props.value,
            succeeds ? "" : "SYNTHETIC_K2",
          );
          assert.equal(button("验证并保存").props.disabled, succeeds);
          if (!succeeds)
            assert.match(
              textOf(renderer.toJSON()),
              /Synthetic new Key verification failure/,
            );
          if (succeeds) await click(input("返回主面板"));
          else await leave("放弃修改并离开");
          assert.equal(
            dashboard().balance.totalBalance,
            succeeds ? "333" : "100",
          );
        },
      );
    }
  }
}

scenario(
  "R15-02: new Key after remount waits for clear and becomes the authoritative account",
  async (concurrent) => {
    const backend = keyBackend();
    const clearing = deferred();
    handlers.clear_api_key = async (args) => {
      await clearing.promise;
      return backend.clear(args);
    };
    handlers.save_api_key = async (args) => {
      backend.enter(args);
      return backend.save(args);
    };
    await openSettings(concurrent);
    await click(button("清除 Key"));
    const clearArgs = submitted("clear_api_key").at(-1).args;
    await click(input("返回主面板"));
    await click(input("设置"));
    await change("API Key", "SYNTHETIC_K3");
    await startKeySave();
    assert.equal(submitted("save_api_key").length, 0);
    assert.equal(backend.persisted, "SYNTHETIC_K0");
    await finish(clearing, undefined);
    const saveArgs = submitted("save_api_key").at(-1).args;
    assert.equal(
      clearArgs.cancelledRequestIds.includes(saveArgs.requestId),
      false,
    );
    assert.equal(backend.persisted, "SYNTHETIC_K3");
    assert.equal(getCommittedConfig().apiKeyConfigured, true);
    assert.equal(input("API Key").props.value, "");
    await click(input("返回主面板"));
    assert.equal(dashboard().balance.totalBalance, "333");
  },
);

scenario(
  "R15-02: failed Key clear preserves the account and error while old save stays revoked",
  async (concurrent) => {
    const backend = keyBackend();
    const admission = deferred();
    handlers.save_api_key = async (args) => {
      await admission.promise;
      backend.enter(args);
      return backend.save(args);
    };
    handlers.clear_api_key = (args) => backend.clear(args, true);
    await openSettings(concurrent);
    const original = getCommittedConfig();
    await change("API Key", "SYNTHETIC_K1");
    await startKeySave();
    await leave("放弃修改并离开");
    await click(input("设置"));
    await click(button("清除 Key"));
    await finish(admission, undefined);
    assert.equal(backend.persisted, "SYNTHETIC_K0");
    assert.equal(getCommittedConfig(), original);
    assert.deepEqual(backend.validations, []);
    assert.match(textOf(renderer.toJSON()), /Synthetic Key clear disk failure/);
    assert.equal(button("清除 Key").props.disabled, false);
    handlers.save_api_key = async (args) => {
      backend.enter(args);
      return backend.save(args);
    };
    await change("API Key", "SYNTHETIC_K3");
    await startKeySave();
    assert.equal(backend.persisted, "SYNTHETIC_K3");
    assert.equal(getCommittedConfig().apiKeyConfigured, true);
  },
);

// These cases enter actual store subscriber broadcasts, not just an equal-
// revision idempotent read. Native hide/position persistence is still a Windows
// acceptance check; the event below models its public, non-secret config reply.
scenario(
  "R16-01: first accepted snapshot repairs a mount read failure with no candidate owner",
  async (concurrent) => {
    handlers.get_app_config = () =>
      Promise.reject(new Error("Synthetic initial read failure"));
    await mount(<Probe />, concurrent);
    assert.equal(state.status, "Synthetic initial read failure");
    assert.equal(getCommittedConfig(), null);
    await act(async () => applyReadConfig(config, getCommitRevision()));
    assert.match(state.status, /已配置/);
    assert.equal(state.config, config);
  },
);

scenario(
  "R16-01: bad configuration still permits clipboard draft preparation without hiding the root error",
  async (concurrent) => {
    config = { ...config, configReadError: "Synthetic root read error" };
    const descriptor = Object.getOwnPropertyDescriptor(g, "navigator");
    Object.defineProperty(g, "navigator", {
      configurable: true,
      value: { clipboard: { readText: async () => "SYNTHETIC_K1" } },
    });
    try {
      await mount(<Probe />, concurrent);
      await act(async () => state.pasteApiKey());
      assert.equal(state.apiKey, "SYNTHETIC_K1");
      assert.equal(state.status, "Synthetic root read error");
      assert.equal(submitted("save_api_key").length, 0);
    } finally {
      if (descriptor) Object.defineProperty(g, "navigator", descriptor);
      else delete g.navigator;
    }
  },
);

for (const failBeforeRead of [false, true]) {
  scenario(
    `R16-01: first store GET preserves ${failBeforeRead ? "failed" : "pending"} candidate feedback`,
    async (concurrent) => {
      const initial = deferred();
      const saving = deferred();
      handlers.get_app_config = () => initial.promise;
      handlers.save_api_key = () => saving.promise;
      await mount(<App />, concurrent);
      await click(input("设置"));
      assert.equal(getCommittedConfig(), null);
      await change("API Key", "SYNTHETIC_K1");
      await startKeySave();
      const fail = async () => {
        await act(async () =>
          saving.reject(new Error("Synthetic K1 rejected")),
        );
        await flush();
      };
      if (failBeforeRead) await fail();
      config = { ...config, refreshIntervalSeconds: 1800, autostart: true };
      await finish(initial, config);
      assert.equal(getCommittedConfig(), config);
      assert.equal(input("API Key").props.value, "SYNTHETIC_K1");
      assert.match(
        textOf(renderer.toJSON()),
        failBeforeRead ? /Synthetic K1 rejected/ : /正在验证 API Key…/,
      );
      if (!failBeforeRead) await fail();
      assert.match(textOf(renderer.toJSON()), /Synthetic K1 rejected/);
    },
  );
}

scenario(
  "R16-01: accepted higher reads and preference/Token broadcasts keep errors and synchronize controls",
  async (concurrent) => {
    handlers.save_api_key = () =>
      Promise.reject(new Error("Synthetic K1 rejected"));
    await mount(<Probe />, concurrent);
    await act(async () => state.setApiKey("SYNTHETIC_K1"));
    await act(async () => state.saveApiKey());
    const savedKeyRevision = state.config.apiKeyRevision;
    for (const read of [true, false]) {
      config = {
        ...config,
        configRevision: ++fixtureRevision,
        usageTokenRevision: fixtureRevision,
        usageTokenConfigured: false,
        refreshIntervalSeconds: 1800,
        autoRefreshEnabled: true,
        autostart: true,
      };
      await act(async () => {
        assert.equal(
          read
            ? applyReadConfig(config, getCommitRevision())
            : setCommittedConfig(config),
          true,
        );
      });
      assert.equal(state.config, config);
      assert.equal(state.config.apiKeyRevision, savedKeyRevision);
      assert.equal(state.refresh, 1800);
      assert.equal(state.autoRefresh, true);
      assert.equal(state.autostart, true);
      assert.equal(state.usageStatus, "未配置用量 Token");
      assert.equal(state.apiKey, "SYNTHETIC_K1");
      assert.equal(state.status, "Synthetic K1 rejected");
    }
  },
);

for (const readFails of [false, true]) {
  scenario(
    `R16-01: late mount ${readFails ? "failure" : "snapshot"} after an ordinary commit preserves a failed candidate until explicit retry`,
    async (concurrent) => {
      const stale = config;
      setCommittedConfig(stale);
      const read = deferred();
      handlers.get_app_config = () => read.promise;
      handlers.save_api_key = () =>
        Promise.reject(new Error("Synthetic K1 rejected"));
      await mount(<Probe />, concurrent);
      await act(async () => state.setApiKey("SYNTHETIC_K1"));
      await act(async () => state.saveApiKey());
      config = {
        ...config,
        configRevision: ++fixtureRevision,
        refreshIntervalSeconds: 1800,
      };
      await act(async () => setCommittedConfig(config));
      await act(async () => {
        if (readFails) read.reject(new Error("Synthetic obsolete GET failure"));
        else read.resolve(stale);
      });
      await flush();
      assert.equal(getCommittedConfig(), config);
      assert.equal(state.refresh, 1800);
      assert.equal(state.status, "Synthetic K1 rejected");
      assert.equal(state.apiKey, "SYNTHETIC_K1");
      const retry = deferred();
      handlers.save_api_key = () => retry.promise;
      let result;
      await act(async () => {
        result = state.saveApiKey();
      });
      assert.equal(state.status, "正在验证 API Key…");
      config = nextCredentialConfig("apiKey", true);
      await finish(retry, { config, balance });
      assert.equal(await result, true);
      assert.match(state.status, /验证通过/);
      assert.equal(state.apiKey, "");
      assert.equal(submitted("save_api_key").length, 2);
    },
  );
}

scenario(
  "R16-01: hidden window position event and theme rerender keep candidate feedback",
  async (concurrent) => {
    handlers.save_api_key = () =>
      Promise.reject(new Error("Synthetic K1 rejected"));
    await openSettings(concurrent);
    await change("API Key", "SYNTHETIC_K1");
    await startKeySave();
    const before = getCommittedConfig();
    config = { ...before, configRevision: ++fixtureRevision };
    await emit("credential-config-changed", config);
    await emit("main-window-hidden");
    assert.equal(getCommittedConfig(), config);
    assert.equal(getCommittedConfig().apiKeyRevision, before.apiKeyRevision);
    await emit("main-window-shown");
    const theme = renderer.root
      .findAllByType("label")
      .find((node) => textOf(node).includes("浅色皮肤"));
    await act(async () =>
      theme.findByType("input").props.onChange({ target: { checked: false } }),
    );
    await flush();
    assert.equal(panel("settings"), 1);
    assert.equal(input("API Key").props.value, "SYNTHETIC_K1");
    assert.match(textOf(renderer.toJSON()), /Synthetic K1 rejected/);
    assert.equal(submitted("save_api_key").length, 1);
  },
);

scenario(
  "R16-01: success and clear receipts survive ordinary commits, while edit and real Key changes retire them",
  async (concurrent) => {
    await mount(<Probe />, concurrent);
    await act(async () => state.setApiKey("SYNTHETIC_K1"));
    await act(async () => state.saveApiKey());
    assert.match(state.status, /验证通过/);
    config = { ...config, configRevision: ++fixtureRevision };
    await act(async () => setCommittedConfig(config));
    assert.match(state.status, /验证通过/);
    await act(async () => state.setApiKey("SYNTHETIC_K2"));
    assert.doesNotMatch(state.status, /验证通过/);
    handlers.clear_api_key = () =>
      (config = nextCredentialConfig("apiKey", false));
    await act(async () => state.clearApiKey());
    await flush();
    assert.equal(state.status, "已清除 API Key");
    assert.equal(state.apiKey, "");
    config = { ...config, configRevision: ++fixtureRevision };
    await act(async () => setCommittedConfig(config));
    assert.equal(state.status, "已清除 API Key");
    config = nextCredentialConfig("apiKey", true);
    await act(async () => setCommittedConfig(config));
    assert.match(state.status, /已配置/);
    assert.doesNotMatch(state.status, /已清除/);
    await act(async () => renderer.unmount());
    renderer = null;
    handlers.get_app_config = () => new Promise(() => {});
    await mount(<Probe />, concurrent);
    assert.match(state.status, /已配置/);
    assert.equal(state.apiKey, "");
  },
);

scenario(
  "R16-01: current save receipt survives its early commit event and a later Token snapshot",
  async (concurrent) => {
    const saving = deferred();
    handlers.save_api_key = () => saving.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setApiKey("SYNTHETIC_K1"));
    let result;
    await act(async () => {
      result = state.saveApiKey();
    });
    const receipt = nextCredentialConfig("apiKey", true);
    await act(async () => setCommittedConfig(receipt));
    config = {
      ...receipt,
      configRevision: ++fixtureRevision,
      usageTokenRevision: fixtureRevision,
    };
    await act(async () => setCommittedConfig(config));
    await finish(saving, { config: receipt, balance });
    assert.equal(await result, true);
    assert.equal(getCommittedConfig(), config);
    assert.match(state.status, /验证通过/);
    assert.equal(state.apiKey, "");
  },
);

scenario(
  "R16-01: real read error revokes account display and late candidate failure cannot hide it or revive on recovery",
  async (concurrent) => {
    const saving = deferred();
    handlers.save_api_key = () => saving.promise;
    await openSettings(concurrent);
    await change("API Key", "SYNTHETIC_K1");
    await startKeySave();
    const trusted = config;
    config = {
      ...config,
      configRevision: ++fixtureRevision,
      configReadError: "Synthetic root read error",
    };
    await emit("credential-config-changed", config);
    await act(async () =>
      saving.reject(new Error("Synthetic late candidate failure")),
    );
    await flush();
    assert.match(textOf(renderer.toJSON()), /Synthetic root read error/);
    assert.doesNotMatch(
      textOf(renderer.toJSON()),
      /Synthetic late candidate failure/,
    );
    assert.equal(input("API Key").props.value, "SYNTHETIC_K1");
    assert.equal(submitted("update_tray_balance").at(-1).args.total, null);
    config = { ...trusted, configRevision: ++fixtureRevision };
    await emit("credential-config-changed", config);
    assert.doesNotMatch(
      textOf(renderer.toJSON()),
      /Synthetic root read error|Synthetic late candidate failure/,
    );
    assert.equal(input("API Key").props.value, "SYNTHETIC_K1");
  },
);

// R17: deferred clipboard and IPC results intentionally resolve out of order.
// These are regression definitions, not Windows clipboard/WebView2 evidence.
const withTokenClipboard = async (readText, body) => {
  const descriptor = Object.getOwnPropertyDescriptor(g, "navigator");
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: { clipboard: { readText } },
  });
  try {
    await body();
  } finally {
    if (descriptor) Object.defineProperty(g, "navigator", descriptor);
    else delete g.navigator;
  }
};
const beginTokenPaste = async () => {
  await act(async () => {
    state.pasteUsageToken();
  });
};

for (const clipboardFails of [false, true]) {
  scenario(
    `R17: late clipboard ${clipboardFails ? "failure" : "success"} cannot overwrite typed or ABA Token edits`,
    async (concurrent) => {
      const clipboard = deferred();
      await withTokenClipboard(
        () => clipboard.promise,
        async () => {
          await mount(<Probe />, concurrent);
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
          await beginTokenPaste();
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_B"));
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
          const displayed = state.usageStatus;
          await act(async () => {
            if (clipboardFails)
              clipboard.reject(new Error("Synthetic clipboard failure"));
            else clipboard.resolve("SYNTHETIC_OLD_CLIPBOARD_TOKEN");
          });
          await flush();
          assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
          assert.equal(state.usageStatus, displayed);
          assert.equal(submitted("save_usage_token").length, 0);
        },
      );
    },
  );
}

for (const olderFails of [false, true]) {
  scenario(
    `R17: later Token paste owns feedback when older clipboard ${olderFails ? "rejects" : "resolves"} last`,
    async (concurrent) => {
      const older = deferred();
      const newer = deferred();
      let reads = 0;
      await withTokenClipboard(
        () => (++reads === 1 ? older.promise : newer.promise),
        async () => {
          await mount(<Probe />, concurrent);
          await beginTokenPaste();
          await beginTokenPaste();
          await finish(newer, "  SYNTHETIC_NEW_CLIPBOARD_TOKEN  ");
          assert.equal(state.usageToken, "SYNTHETIC_NEW_CLIPBOARD_TOKEN");
          assert.equal(state.usageStatus, "已从剪贴板读取");
          await act(async () => {
            if (olderFails)
              older.reject(new Error("Synthetic older clipboard failure"));
            else older.resolve("SYNTHETIC_OLD_CLIPBOARD_TOKEN");
          });
          await flush();
          assert.equal(state.usageToken, "SYNTHETIC_NEW_CLIPBOARD_TOKEN");
          assert.equal(state.usageStatus, "已从剪贴板读取");
        },
      );
    },
  );
}

for (const [command, action] of [
  ["clear_usage_token", "clearUsageToken"],
  ["forget_usage_session", "forgetUsageSession"],
]) {
  for (const clipboardFirst of [false, true]) {
    scenario(
      `R17: ${command} revokes older clipboard before or after its receipt (${clipboardFirst})`,
      async (concurrent) => {
        const clipboard = deferred();
        const clearing = deferred();
        handlers[command] = () => clearing.promise;
        await withTokenClipboard(
          () => clipboard.promise,
          async () => {
            await mount(<Probe />, concurrent);
            await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
            await beginTokenPaste();
            await act(async () => state[action]());
            const cleared = nextCredentialConfig("usageToken", false);
            if (clipboardFirst) {
              await finish(clipboard, "SYNTHETIC_OLD_CLIPBOARD_TOKEN");
              assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
            }
            await finish(clearing, cleared);
            const displayed = state.usageStatus;
            if (!clipboardFirst)
              await finish(clipboard, "SYNTHETIC_OLD_CLIPBOARD_TOKEN");
            assert.equal(state.usageToken, "");
            assert.equal(state.usageStatus, displayed);
            assert.match(displayed, /已清除/);
            assert.equal(getCommittedConfig().usageTokenConfigured, false);
            assert.equal(submitted("save_usage_token").length, 0);
            assert.equal(submitted("start_usage_sync").length, 0);
          },
        );
      },
    );
  }
  scenario(
    `R17: explicit paste after ${command} stays current across its older receipt`,
    async (concurrent) => {
      const clipboard = deferred();
      const clearing = deferred();
      handlers[command] = () => clearing.promise;
      await withTokenClipboard(
        () => clipboard.promise,
        async () => {
          await mount(<Probe />, concurrent);
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
          await act(async () => state[action]());
          await beginTokenPaste();
          await finish(clearing, nextCredentialConfig("usageToken", false));
          await finish(clipboard, "SYNTHETIC_EXPLICIT_NEW_TOKEN");
          assert.equal(state.usageToken, "SYNTHETIC_EXPLICIT_NEW_TOKEN");
          if (command === "forget_usage_session") {
            assert.match(state.usageStatus, /^已从剪贴板读取。/);
            assert.match(
              state.usageStatus,
              /已清除监控 Token 和应用内网页登录数据/,
            );
          } else assert.equal(state.usageStatus, "已从剪贴板读取");
          assert.equal(getCommittedConfig().usageTokenConfigured, false);
          assert.equal(submitted("save_usage_token").length, 0);
        },
      );
    },
  );
}

for (const succeeds of [false, true]) {
  scenario(
    `R17: Token save ${succeeds ? "success" : "failure"} belongs to submitted generation, not newer ABA draft`,
    async (concurrent) => {
      const saving = deferred();
      handlers.save_usage_token = () => saving.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
      let result;
      await act(async () => {
        result = state.saveUsageToken();
      });
      await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_B"));
      await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
      const displayed = state.usageStatus;
      if (succeeds) {
        const receipt = nextCredentialConfig("usageToken", true);
        await finish(saving, receipt);
        assert.equal(getCommittedConfig(), receipt);
      } else {
        await act(async () =>
          saving.reject(new Error("Synthetic obsolete Token rejection")),
        );
      }
      await flush();
      assert.equal(await result, succeeds);
      assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
      assert.equal(state.usageStatus, displayed);
      assert.equal(state.busy, false);
    },
  );
  scenario(
    `R17: Token save revokes an older clipboard even when verification ${succeeds ? "succeeds" : "fails"}`,
    async (concurrent) => {
      const clipboard = deferred();
      const saving = deferred();
      handlers.save_usage_token = () => saving.promise;
      await withTokenClipboard(
        () => clipboard.promise,
        async () => {
          await mount(<Probe />, concurrent);
          await act(async () =>
            state.setUsageToken("SYNTHETIC_SUBMITTED_TOKEN"),
          );
          await beginTokenPaste();
          let result;
          await act(async () => {
            result = state.saveUsageToken();
          });
          if (succeeds)
            await finish(saving, nextCredentialConfig("usageToken", true));
          else
            await act(async () =>
              saving.reject(new Error("Synthetic current Token rejection")),
            );
          const displayed = state.usageStatus;
          await finish(clipboard, "SYNTHETIC_OBSOLETE_CLIPBOARD_TOKEN");
          assert.equal(await result, succeeds);
          assert.equal(
            state.usageToken,
            succeeds ? "" : "SYNTHETIC_SUBMITTED_TOKEN",
          );
          assert.equal(state.usageStatus, displayed);
          assert.match(
            displayed,
            succeeds ? /验证通过/ : /Synthetic current Token rejection/,
          );
          assert.equal(submitted("save_usage_token").length, 1);
        },
      );
    },
  );
}

scenario(
  "R17: Token success clears on edit while unrelated committed reads retain candidate rejection",
  async (concurrent) => {
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
    await act(async () => state.saveUsageToken());
    assert.equal(state.usageStatus, "验证通过并已保存");
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_B"));
    assert.doesNotMatch(state.usageStatus, /验证通过/);
    handlers.save_usage_token = () =>
      Promise.reject(new Error("Synthetic current Token rejection"));
    await act(async () => state.saveUsageToken());
    const before = getCommittedConfig();
    config = {
      ...before,
      configRevision: ++fixtureRevision,
      refreshIntervalSeconds: 1800,
    };
    await act(async () => setCommittedConfig(config));
    assert.equal(state.refresh, 1800);
    assert.equal(state.usageStatus, "Synthetic current Token rejection");
    config = {
      ...config,
      configRevision: ++fixtureRevision,
      apiKeyRevision: fixtureRevision,
    };
    await act(async () => applyReadConfig(config, getCommitRevision()));
    assert.equal(state.usageStatus, "Synthetic current Token rejection");
    assert.equal(state.usageToken, "SYNTHETIC_TOKEN_B");
    config = nextCredentialConfig("usageToken", false);
    await act(async () => setCommittedConfig(config));
    assert.equal(state.usageStatus, "未配置用量 Token");
    assert.equal(state.usageToken, "SYNTHETIC_TOKEN_B");
  },
);

scenario(
  "R17: early Token commit and later Key snapshot do not swallow the current save receipt",
  async (concurrent) => {
    const saving = deferred();
    handlers.save_usage_token = () => saving.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
    let result;
    await act(async () => {
      result = state.saveUsageToken();
    });
    const receipt = nextCredentialConfig("usageToken", true);
    await act(async () => setCommittedConfig(receipt));
    config = {
      ...receipt,
      configRevision: ++fixtureRevision,
      apiKeyRevision: fixtureRevision,
    };
    await act(async () => setCommittedConfig(config));
    await finish(saving, receipt);
    assert.equal(await result, true);
    assert.equal(getCommittedConfig(), config);
    assert.equal(state.usageStatus, "验证通过并已保存");
    assert.equal(state.usageToken, "");
  },
);

scenario(
  "R17: late clipboard after discard and remount cannot restore credentials or cross page ownership",
  async (concurrent) => {
    const clipboard = deferred();
    await withTokenClipboard(
      () => clipboard.promise,
      async () => {
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        await beginTokenPaste();
        let blocker;
        state.registerCredentialBlocker((value) => {
          blocker = value;
        });
        await act(async () => blocker.discard());
        assert.equal(state.usageToken, "");
        await act(async () => renderer.unmount());
        renderer = null;
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_NEW_PAGE_TOKEN"));
        const displayed = state.usageStatus;
        await finish(clipboard, "SYNTHETIC_OLD_PAGE_TOKEN");
        assert.equal(state.usageToken, "SYNTHETIC_NEW_PAGE_TOKEN");
        assert.equal(state.usageStatus, displayed);
        assert.equal(submitted("save_usage_token").length, 0);
      },
    );
  },
);

scenario(
  "R17: editing a candidate retires web feedback without cancelling the owned login or its committed result",
  async (concurrent) => {
    let session;
    handlers.start_usage_sync = (args) => {
      session = syncStatus(args.requestId, true);
      return { ...session, synced: false };
    };
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    await act(async () => state.setUsageToken("SYNTHETIC_NEW_DRAFT_TOKEN"));
    assert.equal(state.usageSyncing, true);
    const captured = nextCredentialConfig("usageToken", true);
    await emit("usage-token-captured", capturedPayload(captured, session));
    assert.equal(getCommittedConfig(), captured);
    assert.equal(state.usageSyncing, false);
    assert.equal(state.usageToken, "SYNTHETIC_NEW_DRAFT_TOKEN");
    assert.equal(submitted("cancel_usage_sync").length, 0);
  },
);

scenario(
  "R17: a repeated Token save reuses IPC but revokes the intervening clipboard intent",
  async (concurrent) => {
    const clipboard = deferred();
    const saving = deferred();
    handlers.save_usage_token = () => saving.promise;
    await withTokenClipboard(
      () => clipboard.promise,
      async () => {
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        let first, repeated;
        await act(async () => {
          first = state.saveUsageToken();
        });
        await beginTokenPaste();
        await act(async () => {
          repeated = state.saveUsageToken();
        });
        assert.equal(first, repeated);
        assert.equal(submitted("save_usage_token").length, 1);
        await finish(saving, nextCredentialConfig("usageToken", true));
        await finish(clipboard, "SYNTHETIC_OBSOLETE_CLIPBOARD_TOKEN");
        assert.equal(await repeated, true);
        assert.equal(state.usageToken, "");
        assert.equal(state.usageStatus, "验证通过并已保存");
      },
    );
  },
);

scenario(
  "R17: an explicit new paste keeps its draft ownership across an older save receipt",
  async (concurrent) => {
    const clipboard = deferred();
    const saving = deferred();
    handlers.save_usage_token = () => saving.promise;
    await withTokenClipboard(
      () => clipboard.promise,
      async () => {
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        let result;
        await act(async () => {
          result = state.saveUsageToken();
        });
        await beginTokenPaste();
        await finish(saving, nextCredentialConfig("usageToken", true));
        assert.equal(await result, true);
        assert.doesNotMatch(state.usageStatus, /验证通过/);
        await finish(clipboard, "SYNTHETIC_NEW_CLIPBOARD_TOKEN");
        assert.equal(state.usageToken, "SYNTHETIC_NEW_CLIPBOARD_TOKEN");
        assert.equal(state.usageStatus, "已从剪贴板读取");
        assert.equal(submitted("save_usage_token").length, 1);
      },
    );
  },
);

scenario(
  "R17: first accepted configuration cannot erase a failed Token candidate",
  async (concurrent) => {
    const reading = deferred();
    handlers.get_app_config = () => reading.promise;
    handlers.save_usage_token = () =>
      Promise.reject(new Error("Synthetic first Token rejection"));
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
    await act(async () => state.saveUsageToken());
    assert.equal(getCommittedConfig(), null);
    await finish(reading, config);
    assert.equal(state.usageStatus, "Synthetic first Token rejection");
    assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
  },
);

scenario(
  "R17: discard invalidates an unresolved Token clipboard without requiring unmount",
  async (concurrent) => {
    const clipboard = deferred();
    await withTokenClipboard(
      () => clipboard.promise,
      async () => {
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        await beginTokenPaste();
        let blocker;
        state.registerCredentialBlocker((value) => {
          blocker = value;
        });
        await act(async () => blocker.discard());
        const displayed = state.usageStatus;
        await finish(clipboard, "SYNTHETIC_OBSOLETE_CLIPBOARD_TOKEN");
        assert.equal(state.usageToken, "");
        assert.equal(state.usageStatus, displayed);
        assert.equal(blocker.dirty, false);
      },
    );
  },
);

for (const [command, action] of [
  ["save_usage_token", "saveUsageToken"],
  ["clear_usage_token", "clearUsageToken"],
  ["forget_usage_session", "forgetUsageSession"],
]) {
  scenario(
    `R17: ${command} receipt cannot consume a draft under a newer root read error`,
    async (concurrent) => {
      const pending = deferred();
      handlers[command] = () => pending.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
      await act(async () => {
        state[action]();
      });
      const receipt = nextCredentialConfig(
        "usageToken",
        command === "save_usage_token",
      );
      const unavailable = {
        ...receipt,
        configRevision: ++fixtureRevision,
        configReadError: "Synthetic root read error",
      };
      await act(async () => setCommittedConfig(unavailable));
      await finish(pending, receipt);
      assert.equal(getCommittedConfig(), unavailable);
      assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
      assert.equal(state.usageStatus, "Synthetic root read error");
      assert.equal(state.busy, false);
    },
  );
}

for (const edits of ["none", "B", "ABA"]) {
  for (const succeeds of [false, true]) {
    scenario(
      `R18: forget cleanup ${succeeds ? "success" : "failure"} is independent of ${edits} draft edits`,
      async (concurrent) => {
        const forgetting = deferred();
        handlers.forget_usage_session = () => forgetting.promise;
        await mount(<Probe />, concurrent);
        await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        await act(async () => state.forgetUsageSession());
        const cleared = nextCredentialConfig("usageToken", false);
        await emit("usage-token-cleared", cleared);
        if (edits !== "none")
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_B"));
        if (edits === "ABA")
          await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
        assert.match(state.usageStatus, /监控 Token 已清除/);
        assert.match(state.usageStatus, /正在清理网页登录数据/);
        if (succeeds) await finish(forgetting, cleared);
        else
          await act(async () =>
            forgetting.reject(
              new Error("Synthetic browser-data deletion failure"),
            ),
          );
        await flush();
        assert.equal(getCommittedConfig().usageTokenConfigured, false);
        const expectedDraft =
          succeeds && edits === "none"
            ? ""
            : edits === "B"
              ? "SYNTHETIC_TOKEN_B"
              : "SYNTHETIC_TOKEN_A";
        assert.equal(state.usageToken, expectedDraft);
        assert.match(
          state.usageStatus,
          succeeds
            ? /已清除监控 Token 和应用内网页登录数据/
            : /监控 Token 已清除；网页登录数据清理尚未确认完成/,
        );
        if (!succeeds) {
          assert.match(
            state.usageStatus,
            /Synthetic browser-data deletion failure/,
          );
          assert.match(state.usageStatus, /重试/);
          const failure = state.usageStatus;
          await act(async () => state.setUsageToken("SYNTHETIC_LATER_TOKEN"));
          await act(async () =>
            setCommittedConfig({
              ...cleared,
              configRevision: ++fixtureRevision,
              refreshIntervalSeconds: 300,
            }),
          );
          assert.equal(state.usageStatus, failure);
        }
        let blocker;
        state.registerCredentialBlocker((value) => {
          blocker = value;
        });
        assert.equal(blocker.dirty, !succeeds || edits !== "none");
        assert.equal(state.busy, false);
        assert.equal(submitted("save_usage_token").length, 0);
        assert.equal(submitted("forget_usage_session").length, 1);
      },
    );
  }
}

scenario(
  "R18: forget failure before Token commit does not claim Token or browser data was removed",
  async (concurrent) => {
    handlers.forget_usage_session = () =>
      Promise.reject(new Error("Synthetic Token disk failure"));
    await mount(<Probe />, concurrent);
    const previous = getCommittedConfig();
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
    await act(async () => state.forgetUsageSession());
    await flush();
    assert.equal(getCommittedConfig(), previous);
    assert.equal(state.usageToken, "SYNTHETIC_TOKEN_A");
    assert.match(state.usageStatus, /^尚未确认监控 Token 已清除/);
    assert.match(state.usageStatus, /Synthetic Token disk failure/);
    assert.equal(state.busy, false);
  },
);

scenario(
  "R18: cleanup timeout stays unconfirmed until an explicit retry and ignores unowned completion events",
  async (concurrent) => {
    const forgetting = deferred();
    handlers.forget_usage_session = () => forgetting.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.forgetUsageSession());
    const cleared = nextCredentialConfig("usageToken", false);
    await emit("usage-token-cleared", cleared);
    await act(async () => state.setUsageToken("SYNTHETIC_NEW_TOKEN"));
    await act(async () =>
      forgetting.reject(
        new Error(
          "监控 Token 已清除，网页登录数据仍在清理；完成前无法重新同步",
        ),
      ),
    );
    await flush();
    const failed = state.usageStatus;
    await emit("browsing-data-cleared", null);
    await emit("usage-token-cleared", cleared);
    assert.equal(state.usageStatus, failed);
    assert.match(failed, /尚未确认完成/);
    assert.equal(submitted("forget_usage_session").length, 1);
    const retry = deferred();
    handlers.forget_usage_session = () => retry.promise;
    await act(async () => state.forgetUsageSession());
    assert.equal(submitted("forget_usage_session").length, 2);
    assert.match(state.usageStatus, /正在清理网页登录数据/);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_B"));
    await act(async () => state.setUsageToken("SYNTHETIC_NEW_TOKEN"));
    await emit("browsing-data-cleared", null);
    await emit("usage-token-cleared", cleared);
    assert.match(state.usageStatus, /正在清理网页登录数据/);
    await finish(retry, nextCredentialConfig("usageToken", false));
    const completed = state.usageStatus;
    await emit("browsing-data-cleared", null);
    await emit("usage-token-cleared", cleared);
    assert.equal(state.usageStatus, completed);
    assert.match(completed, /已清除监控 Token 和应用内网页登录数据/);
    assert.equal(state.usageToken, "SYNTHETIC_NEW_TOKEN");
    let blocker;
    state.registerCredentialBlocker((value) => {
      blocker = value;
    });
    assert.equal(blocker.dirty, true);
    assert.equal(state.busy, false);
    assert.equal(submitted("save_usage_token").length, 0);
  },
);

for (const newer of ["save", "login"]) {
  for (const oldFails of [false, true]) {
    scenario(
      `R18: old forget ${oldFails ? "failure" : "success"} keeps its attribution after newer ${newer}`,
      async (concurrent) => {
        const forgetting = deferred();
        const replacement = deferred();
        handlers.forget_usage_session = () => forgetting.promise;
        handlers.save_usage_token = () => replacement.promise;
        handlers.start_usage_sync = () => replacement.promise;
        await mount(<Probe />, concurrent);
        await act(async () => state.forgetUsageSession());
        const cleared = nextCredentialConfig("usageToken", false);
        await emit("usage-token-cleared", cleared);
        await act(async () => state.setUsageToken("SYNTHETIC_NEW_TOKEN"));
        let result;
        await act(async () => {
          if (newer === "save") result = state.saveUsageToken();
          else state.startUsageSync();
        });
        if (oldFails)
          await act(async () =>
            forgetting.reject(new Error("Synthetic previous cleanup failure")),
          );
        else await finish(forgetting, cleared);
        await flush();
        assert.match(
          state.usageStatus,
          newer === "save" ? /^正在验证候选 Token/ : /^正在打开登录窗口/,
        );
        assert.match(state.usageStatus, /此前的“退出并忘记账户”/);
        assert.equal(state.usageToken, "SYNTHETIC_NEW_TOKEN");
        if (oldFails)
          assert.match(state.usageStatus, /Synthetic previous cleanup failure/);
        const current = nextCredentialConfig("usageToken", true);
        if (newer === "save") {
          await finish(replacement, current);
          assert.equal(await result, true);
          assert.equal(state.usageToken, "");
          assert.match(state.usageStatus, /^验证通过并已保存。/);
        } else {
          const requestId = submitted("start_usage_sync").at(-1).args.requestId;
          const active = syncStatus(requestId, true);
          await finish(replacement, { ...active, synced: false });
          assert.equal(state.usageSyncing, true);
          assert.match(state.usageStatus, /^等待网页登录/);
          await emit("usage-token-captured", capturedPayload(current, active));
          assert.equal(state.usageSyncing, false);
          assert.equal(state.usageToken, "SYNTHETIC_NEW_TOKEN");
          assert.match(state.usageStatus, /^用量 Token 已配置。/);
        }
        const displayed = state.usageStatus;
        await emit("usage-token-cleared", cleared);
        await emit("browsing-data-cleared", null);
        assert.equal(getCommittedConfig(), current);
        assert.equal(state.usageStatus, displayed);
        assert.equal(submitted("forget_usage_session").length, 1);
      },
    );
  }
}

for (const oldFails of [false, true]) {
  scenario(
    `R18: forget ${oldFails ? "failure" : "receipt"} arriving after a newer committed account is historical only`,
    async (concurrent) => {
      const forgetting = deferred();
      handlers.forget_usage_session = () => forgetting.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.forgetUsageSession());
      const cleared = nextCredentialConfig("usageToken", false);
      await emit("usage-token-cleared", cleared);
      await act(async () => state.setUsageToken("SYNTHETIC_NEW_ACCOUNT_DRAFT"));
      const current = nextCredentialConfig("usageToken", true);
      await emit("usage-token-captured", capturedPayload(current));
      if (oldFails)
        await act(async () =>
          forgetting.reject(
            new Error("Synthetic older account cleanup failure"),
          ),
        );
      else await finish(forgetting, cleared);
      await flush();
      assert.equal(getCommittedConfig(), current);
      assert.equal(state.usageToken, "SYNTHETIC_NEW_ACCOUNT_DRAFT");
      assert.match(state.usageStatus, /^用量 Token 已配置。此前的/);
      assert.match(
        state.usageStatus,
        oldFails
          ? /Synthetic older account cleanup failure/
          : /后续新登录或保存的账户不在该次清理范围内/,
      );
      assert.equal(submitted("save_usage_token").length, 0);
      assert.equal(submitted("forget_usage_session").length, 1);
    },
  );
}

scenario(
  "R19: old forget failure after remount is visible without attaching to the new page draft",
  async (concurrent) => {
    const forgetting = deferred();
    handlers.forget_usage_session = () => forgetting.promise;
    await mount(<Probe />, concurrent);
    await act(async () => state.forgetUsageSession());
    config = nextCredentialConfig("usageToken", false);
    await emit("usage-token-cleared", config);
    await act(async () => renderer.unmount());
    renderer = null;
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_NEW_PAGE_TOKEN"));
    assert.match(state.usageStatus, /正在清理网页登录数据/);
    assert.equal(state.busy, true);
    await act(async () =>
      forgetting.reject(new Error("Synthetic unmounted cleanup failure")),
    );
    await flush();
    assert.match(
      state.usageStatus,
      /监控 Token 已清除；网页登录数据清理尚未确认完成/,
    );
    assert.match(state.usageStatus, /Synthetic unmounted cleanup failure/);
    assert.equal(state.usageToken, "SYNTHETIC_NEW_PAGE_TOKEN");
    assert.equal(state.busy, false);
  },
);

// R19: exercise actual App navigation with no dirty draft. The settings page can
// leave immediately while WebView2 is pending; its privacy result must not leave.
for (const timing of ["before-leave", "while-away", "after-remount"]) {
  for (const outcome of ["failure", "timeout", "success"]) {
    for (const edits of ["none", "B", "ABA"]) {
      scenario(
        `R19: no-draft navigation retains cleanup ${outcome} ${timing} and protects ${edits} on the new page`,
        async (concurrent) => {
          const forgetting = deferred();
          handlers.forget_usage_session = () => forgetting.promise;
          await openSettings(concurrent);
          await click(button("退出并忘记账户"));
          await click(button("确认清除"));
          const owner = usageSessionCleanup.snapshot.owner;
          const cleared = nextCredentialConfig("usageToken", false);
          config = cleared;
          await emit("usage-token-cleared", cleared);
          const error =
            outcome === "timeout"
              ? "监控 Token 已清除，网页登录数据仍在清理；完成前无法重新同步"
              : "Synthetic R19 WebView2 failure";
          const settle = async () => {
            if (outcome === "success") await finish(forgetting, cleared);
            else {
              await act(async () => forgetting.reject(new Error(error)));
              await flush();
            }
          };
          if (timing === "before-leave") await settle();
          await click(input("返回主面板"));
          assert.equal(prompt(), 0);
          assert.equal(panel("dashboard"), 1);
          if (timing === "while-away") await settle();
          await click(input("设置"));
          assert.equal(usageSessionCleanup.snapshot.owner, owner);
          if (timing === "after-remount") {
            assert.match(textOf(renderer.toJSON()), /正在清理网页登录数据/);
            assert.equal(button("退出并忘记账户").props.disabled, true);
          }
          await manual();
          assert.equal(input("用量 Token").props.value, "");
          if (edits !== "none")
            await change("用量 Token", "SYNTHETIC_NEW_PAGE_TOKEN_B");
          if (edits === "ABA") {
            await change("用量 Token", "SYNTHETIC_NEW_PAGE_TOKEN_A");
            await change("用量 Token", "SYNTHETIC_NEW_PAGE_TOKEN_B");
          }
          if (timing === "after-remount") await settle();
          const text = textOf(renderer.toJSON());
          if (outcome === "success")
            assert.match(text, /已清除监控 Token 和应用内网页登录数据/);
          else {
            assert.match(
              text,
              /监控 Token 已清除；网页登录数据清理尚未确认完成/,
            );
            assert.ok(text.includes(error));
            assert.match(text, /重试/);
          }
          assert.equal(
            input("用量 Token").props.value,
            edits === "none" ? "" : "SYNTHETIC_NEW_PAGE_TOKEN_B",
          );
          assert.equal(button("退出并忘记账户").props.disabled, false);
          const status = usageSessionCleanup.snapshot;
          await emit("browsing-data-cleared", null);
          await emit("usage-token-cleared", cleared);
          assert.equal(usageSessionCleanup.snapshot, status);
          assert.equal(submitted("forget_usage_session").length, 1);
          assert.equal(submitted("save_usage_token").length, 0);
          await click(input("返回主面板"));
          assert.equal(prompt(), edits === "none" ? 0 : 1);
        },
      );
    }
  }
}

scenario(
  "R19: pending cleanup survives repeated clean navigation without duplicate IPC or a false success event",
  async (concurrent) => {
    const forgetting = deferred();
    handlers.forget_usage_session = () => forgetting.promise;
    await openSettings(concurrent);
    await click(button("退出并忘记账户"));
    await click(button("确认清除"));
    const owner = usageSessionCleanup.snapshot.owner;
    // The Token commit arrives with SettingsPanel absent: App must still apply it.
    await click(input("返回主面板"));
    config = nextCredentialConfig("usageToken", false);
    await emit("usage-token-cleared", config);
    for (let visit = 0; visit < 2; visit++) {
      await click(input("设置"));
      assert.match(
        textOf(renderer.toJSON()),
        /监控 Token 已清除；正在清理网页登录数据/,
      );
      assert.equal(button("退出并忘记账户").props.disabled, true);
      assert.equal(usageSessionCleanup.snapshot.owner, owner);
      await emit("browsing-data-cleared", null);
      assert.equal(usageSessionCleanup.snapshot.phase, "pending");
      await click(input("返回主面板"));
      assert.equal(prompt(), 0);
    }
    await finish(forgetting, config);
    await click(input("设置"));
    assert.match(
      textOf(renderer.toJSON()),
      /已清除监控 Token 和应用内网页登录数据/,
    );
    assert.equal(submitted("forget_usage_session").length, 1);
  },
);

for (const newer of ["save", "login"]) {
  for (const oldFails of [false, true]) {
    scenario(
      `R19: remounted ${newer} keeps previous cleanup ${oldFails ? "failure" : "success"} historical and never retries it`,
      async (concurrent) => {
        const forgetting = deferred();
        const replacement = deferred();
        handlers.forget_usage_session = () => forgetting.promise;
        handlers.save_usage_token = () => replacement.promise;
        handlers.start_usage_sync = () => replacement.promise;
        await mount(<Probe />, concurrent);
        await act(async () => state.forgetUsageSession());
        const cleared = nextCredentialConfig("usageToken", false);
        config = cleared;
        await emit("usage-token-cleared", cleared);
        await act(async () => renderer.unmount());
        renderer = null;
        await mount(<Probe />, concurrent);
        await act(async () =>
          state.setUsageToken("SYNTHETIC_NEW_ACCOUNT_TOKEN"),
        );
        let saved;
        await act(async () => {
          if (newer === "save") saved = state.saveUsageToken();
          else state.startUsageSync();
        });
        assert.match(state.usageStatus, /此前的“退出并忘记账户”仍在等待/);
        if (oldFails) {
          await act(async () =>
            forgetting.reject(
              new Error("Synthetic R19 previous cleanup failure"),
            ),
          );
          await flush();
        } else await finish(forgetting, cleared);
        assert.equal(state.usageToken, "SYNTHETIC_NEW_ACCOUNT_TOKEN");
        assert.match(state.usageStatus, /此前的“退出并忘记账户”/);
        const current = nextCredentialConfig("usageToken", true);
        config = current;
        if (newer === "save") {
          await finish(replacement, current);
          assert.equal(await saved, true);
          assert.equal(state.usageToken, "");
        } else {
          const requestId = submitted("start_usage_sync").at(-1).args.requestId;
          const active = syncStatus(requestId, true);
          await finish(replacement, { ...active, synced: false });
          await emit("usage-token-captured", capturedPayload(current, active));
          assert.equal(state.usageToken, "SYNTHETIC_NEW_ACCOUNT_TOKEN");
        }
        await act(async () => renderer.unmount());
        renderer = null;
        await mount(<Probe />, concurrent);
        assert.match(state.usageStatus, /^用量 Token 已配置。此前的/);
        assert.match(
          state.usageStatus,
          oldFails
            ? /Synthetic R19 previous cleanup failure/
            : /后续新登录或保存的账户不在该次清理范围内/,
        );
        await emit("usage-token-cleared", cleared);
        await emit("browsing-data-cleared", null);
        assert.equal(getCommittedConfig(), current);
        assert.equal(submitted("forget_usage_session").length, 1);
        assert.equal(state.busy, false);
      },
    );
  }
}

for (const failsWhileAway of [false, true]) {
  scenario(
    `R19: explicit retry after remounted timeout owns a new operation and ignores old receipts (${failsWhileAway})`,
    async (concurrent) => {
      const forgetting = deferred();
      handlers.forget_usage_session = () => forgetting.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.forgetUsageSession());
      const old = usageSessionCleanup.snapshot.owner;
      const cleared = nextCredentialConfig("usageToken", false);
      config = cleared;
      await emit("usage-token-cleared", cleared);
      await act(async () => renderer.unmount());
      renderer = null;
      if (!failsWhileAway) await mount(<Probe />, concurrent);
      await act(async () =>
        forgetting.reject(
          new Error(
            "监控 Token 已清除，网页登录数据仍在清理；完成前无法重新同步",
          ),
        ),
      );
      await flush();
      if (failsWhileAway) await mount(<Probe />, concurrent);
      assert.match(state.usageStatus, /尚未确认完成/);
      await emit("browsing-data-cleared", null);
      assert.equal(submitted("forget_usage_session").length, 1);
      const retry = deferred();
      handlers.forget_usage_session = () => retry.promise;
      await act(async () => state.forgetUsageSession());
      const owner = usageSessionCleanup.snapshot.owner;
      assert.ok(owner.generation > old.generation);
      await act(async () => state.forgetUsageSession());
      assert.equal(submitted("forget_usage_session").length, 2);
      await act(async () => renderer.unmount());
      renderer = null;
      await mount(<Probe />, concurrent);
      await act(async () =>
        state.setUsageToken("SYNTHETIC_RETRY_NEW_PAGE_TOKEN"),
      );
      await act(async () => {
        assert.equal(usageSessionCleanup.finish(old, null), false);
        assert.equal(
          usageSessionCleanup.finish(old, "Synthetic stale failure"),
          false,
        );
      });
      await emit("usage-token-cleared", cleared);
      await emit("browsing-data-cleared", null);
      assert.equal(usageSessionCleanup.snapshot.owner, owner);
      assert.match(state.usageStatus, /正在清理网页登录数据/);
      assert.equal(state.busy, true);
      await finish(retry, nextCredentialConfig("usageToken", false));
      assert.match(state.usageStatus, /已清除监控 Token 和应用内网页登录数据/);
      assert.equal(state.usageToken, "SYNTHETIC_RETRY_NEW_PAGE_TOKEN");
      assert.equal(state.busy, false);
    },
  );
}

// This is a fresh in-memory frontend with only the durable backend marker. The
// fixture intentionally reuses process-local revisions, which are not identity
// evidence after restart, and never asks the renderer to auto-run cleanup.
for (const newerAccount of [false, true]) {
  scenario(
    `R19: fresh app restores durable incomplete cleanup without deleting a newer account (${newerAccount})`,
    async (concurrent) => {
      config = baseConfig({
        usageTokenConfigured: newerAccount,
        usageCleanupUnconfirmed: "9007199254740993",
      });
      await openSettings(concurrent);
      assert.match(textOf(renderer.toJSON()), /应用重新打开后无法确认/);
      assert.match(textOf(renderer.toJSON()), /不代表当前账户已退出/);
      assert.equal(usageSessionCleanup.snapshot.phase, "unconfirmed");
      assert.equal(button("退出并忘记账户").props.disabled, false);
      await manual();
      await change("用量 Token", "SYNTHETIC_RESTART_DRAFT_A");
      await change("用量 Token", "SYNTHETIC_RESTART_DRAFT_B");
      await change("用量 Token", "SYNTHETIC_RESTART_DRAFT_A");
      await emit("browsing-data-cleared", null);
      assert.equal(
        input("用量 Token").props.value,
        "SYNTHETIC_RESTART_DRAFT_A",
      );
      assert.match(textOf(renderer.toJSON()), /应用重新打开后无法确认/);
      assert.equal(submitted("forget_usage_session").length, 0);
      await leave("放弃修改并离开");
      await click(input("设置"));
      assert.match(textOf(renderer.toJSON()), /应用重新打开后无法确认/);
      const retry = deferred();
      handlers.forget_usage_session = () => retry.promise;
      await click(button("退出并忘记账户"));
      assert.equal(submitted("forget_usage_session").length, 0);
      await click(button("确认清除"));
      assert.equal(submitted("forget_usage_session").length, 1);
      const cleared = nextCredentialConfig("usageToken", false);
      const marked = {
        ...cleared,
        usageCleanupUnconfirmed: "9007199254740994",
      };
      config = marked;
      await emit("usage-token-cleared", marked);
      assert.match(textOf(renderer.toJSON()), /正在清理网页登录数据/);
      // Backend confirmation persistence is not a browser-success receipt in UI.
      const confirmed = {
        ...marked,
        configRevision: ++fixtureRevision,
        usageCleanupUnconfirmed: null,
      };
      config = confirmed;
      await emit("credential-config-changed", confirmed);
      assert.equal(usageSessionCleanup.snapshot.phase, "pending");
      await finish(retry, marked);
      assert.equal(getCommittedConfig(), confirmed);
      assert.match(
        textOf(renderer.toJSON()),
        /已清除监控 Token 和应用内网页登录数据/,
      );
    },
  );
}

for (const decision of ["保存并离开", "放弃修改并离开"]) {
  scenario(
    `R19: dirty navigation ${decision} retains earlier privacy failure after reopening`,
    async (concurrent) => {
      const forgetting = deferred();
      const saving = deferred();
      handlers.forget_usage_session = () => forgetting.promise;
      handlers.save_usage_token = () => saving.promise;
      await openSettings(concurrent);
      await click(button("退出并忘记账户"));
      await click(button("确认清除"));
      const cleared = nextCredentialConfig("usageToken", false);
      config = cleared;
      await emit("usage-token-cleared", cleared);
      await manual();
      await change("用量 Token", "SYNTHETIC_NAVIGATION_NEW_ACCOUNT");
      await leave(decision);
      if (decision === "保存并离开") {
        assert.equal(prompt(), 1);
        assert.equal(submitted("save_usage_token").length, 0);
      } else assert.equal(panel("dashboard"), 1);
      await act(async () =>
        forgetting.reject(
          new Error("Synthetic R19 navigation cleanup failure"),
        ),
      );
      await flush();
      if (decision === "保存并离开") {
        assert.equal(submitted("save_usage_token").length, 1);
        config = nextCredentialConfig("usageToken", true);
        await finish(saving, config);
        assert.equal(panel("dashboard"), 1);
      }
      await click(input("设置"));
      assert.match(
        textOf(renderer.toJSON()),
        /Synthetic R19 navigation cleanup failure/,
      );
      if (decision === "保存并离开")
        assert.match(textOf(renderer.toJSON()), /此前的“退出并忘记账户”/);
      else
        assert.match(
          textOf(renderer.toJSON()),
          /监控 Token 已清除；网页登录数据清理尚未确认完成/,
        );
      await manual();
      assert.equal(input("用量 Token").props.value, "");
      assert.equal(submitted("forget_usage_session").length, 1);
    },
  );
}

for (const eventFirst of [false, true]) {
  scenario(
    `R17: cancel receipt and terminal event preserve cancellation feedback in either delivery order (${eventFirst})`,
    async (concurrent) => {
      const cancelling = deferred();
      let session;
      handlers.start_usage_sync = (args) => {
        session = syncStatus(args.requestId, true);
        return { ...session, synced: false };
      };
      handlers.cancel_usage_sync = () => cancelling.promise;
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      await act(async () => state.cancelUsageSync());
      const ended = { ...session, active: false };
      if (eventFirst) await emit("usage-sync-ended", ended);
      await finish(cancelling, ended);
      if (!eventFirst) await emit("usage-sync-ended", ended);
      assert.equal(state.usageSyncing, false);
      assert.equal(state.usageStatus, "已取消同步，原 Token 未更改");
      assert.equal(state.showManualPaste, false);
    },
  );
}

scenario(
  "R17: explicit save after a failed clear never reuses the revoked same-draft request",
  async (concurrent) => {
    const oldSave = deferred();
    const newSave = deferred();
    let saves = 0;
    handlers.save_usage_token = () =>
      ++saves === 1 ? oldSave.promise : newSave.promise;
    handlers.clear_usage_token = () =>
      Promise.reject(new Error("Synthetic clear failure"));
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_TOKEN_A"));
    let oldResult, newResult;
    await act(async () => {
      oldResult = state.saveUsageToken();
    });
    const previous = submitted("save_usage_token").at(-1).args.requestId;
    await act(async () => state.clearUsageToken());
    await flush();
    assert.equal(state.usageStatus, "Synthetic clear failure");
    await act(async () => {
      newResult = state.saveUsageToken();
    });
    assert.equal(submitted("save_usage_token").length, 2);
    assert.ok(
      submitted("save_usage_token")
        .at(-1)
        .args.supersededRequestIds.includes(previous),
    );
    await finish(newSave, nextCredentialConfig("usageToken", true));
    assert.equal(await newResult, true);
    await act(async () =>
      oldSave.reject(new Error("Synthetic revoked old request")),
    );
    assert.equal(await oldResult, false);
    assert.equal(state.usageToken, "");
    assert.equal(state.usageStatus, "验证通过并已保存");
  },
);

scenario(
  "R17: response-only cached Token sync finishes feedback and re-reads configuration despite a duplicate ended event",
  async (concurrent) => {
    const reading = deferred();
    let reads = 0;
    handlers.get_app_config = () => (++reads === 1 ? config : reading.promise);
    let terminal;
    handlers.start_usage_sync = (args) => {
      terminal = syncStatus(args.requestId, false);
      return { ...terminal, synced: true };
    };
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_LOCAL_DRAFT_TOKEN"));
    await act(async () => state.startUsageSync());
    assert.equal(reads, 2);
    assert.equal(state.usageSyncing, false);
    await emit("usage-sync-ended", terminal);
    await finish(reading, config);
    assert.equal(state.usageStatus, "用量 Token 已配置");
    assert.equal(state.usageToken, "SYNTHETIC_LOCAL_DRAFT_TOKEN");
    assert.equal(state.showManualPaste, false);
    assert.equal(submitted("start_usage_sync").length, 1);
    assert.equal(submitted("save_usage_token").length, 0);
  },
);

scenario(
  "R17: a cached-sync fallback read cannot restore Token state after a newer clear",
  async (concurrent) => {
    const reading = deferred();
    let reads = 0;
    handlers.get_app_config = () => (++reads === 1 ? config : reading.promise);
    handlers.start_usage_sync = (args) => ({
      ...syncStatus(args.requestId, false),
      synced: true,
    });
    handlers.clear_usage_token = () =>
      nextCredentialConfig("usageToken", false);
    await mount(<Probe />, concurrent);
    const stale = getCommittedConfig();
    await act(async () => state.startUsageSync());
    await act(async () => state.clearUsageToken());
    await flush();
    const cleared = getCommittedConfig();
    await finish(reading, stale);
    assert.equal(getCommittedConfig(), cleared);
    assert.equal(state.config.usageTokenConfigured, false);
    assert.equal(state.usageStatus, "已清除用量 Token");
    assert.equal(submitted("start_usage_sync").length, 1);
    assert.equal(submitted("save_usage_token").length, 0);
  },
);

// R34: drive the real hook's timer, not an imitation of its ownership checks.
// These remain synthetic React/IPC tests, not Windows event-delivery validation.
const reconcileSync = async () => {
  const pending = [...timeouts].filter(
    ([, timer]) => timer.delay === USAGE_SYNC_RECONCILE_MS,
  );
  assert.equal(
    pending.length,
    1,
    "One settings reconciliation owns the next tick",
  );
  const [id, timer] = pending[0];
  timeouts.delete(id);
  await act(async () => timer.callback());
  await flush();
};
const nativeSyncFixture = () => {
  let snapshot = syncStatus();
  handlers.get_usage_sync_status = () => snapshot;
  handlers.start_usage_sync = (args) => {
    snapshot = syncStatus(args.requestId, true);
    return { ...snapshot, synced: false };
  };
  return {
    current: () => snapshot,
    end: () => {
      snapshot = { ...snapshot, active: false };
      return snapshot;
    },
  };
};

scenario(
  "R34 lost capture event reconciles terminal status and config without consuming drafts",
  async (concurrent) => {
    const native = nativeSyncFixture();
    await mount(<Probe />, concurrent);
    await act(async () => state.setUsageToken("SYNTHETIC_UNSUBMITTED_TOKEN"));
    await act(async () => state.startUsageSync());
    await flush();
    const saved = nextCredentialConfig("usageToken", true);
    config = saved;
    await act(async () => setCommittedConfig(saved)); // The generic config event arrived.
    assert.equal(state.usageSyncing, true);
    native.end(); // No capture or ended event is delivered.
    const before = submitted("get_app_config").length;
    await reconcileSync();
    assert.equal(state.usageSyncing, false);
    assert.equal(submitted("get_app_config").length, before + 1);
    assert.equal(state.config.usageTokenConfigured, true);
    assert.match(state.usageStatus, /同步已结束，当前配置已核对/);
    assert.equal(state.usageToken, "SYNTHETIC_UNSUBMITTED_TOKEN");
    assert.equal(submitted("start_usage_sync").length, 1);
    assert.equal(submitted("save_usage_token").length, 0);
    const status = state.usageStatus;
    await emit("usage-sync-ended", native.current());
    await emit("usage-sync-ended", native.current());
    assert.equal(
      state.usageStatus,
      status,
      "Duplicate late ended events do not turn reconciliation into failure",
    );
  },
);

scenario(
  "R34 unrelated configured changes cannot claim an active login succeeded",
  async (concurrent) => {
    const native = nativeSyncFixture();
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    await flush();
    config = nextCredentialConfig("usageToken", true);
    await act(async () => setCommittedConfig(config));
    await reconcileSync();
    assert.equal(state.usageSyncing, true);
    assert.match(state.usageStatus, /等待网页登录/);
    native.end(); // Lost close/timeout event, with no Token commit by this session.
    await reconcileSync();
    assert.equal(state.usageSyncing, false);
    assert.doesNotMatch(
      state.usageStatus,
      /验证通过|同步成功|同步完成|未获取到/,
    );
    assert.match(state.usageStatus, /同步已结束/);
  },
);

for (const phase of ["status", "config"] as const) {
  scenario(
    `R34 slow ${phase} read cannot finish or publish into a newer web login`,
    async (concurrent) => {
      const native = nativeSyncFixture();
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      await flush();
      const old = native.end();
      const delayed = deferred();
      const staleConfig = { ...config };
      if (phase === "status")
        handlers.get_usage_sync_status = () => delayed.promise;
      else handlers.get_app_config = () => delayed.promise;
      await reconcileSync();
      assert.equal(
        timeouts.size,
        0,
        "No parallel status loop while the previous read is pending",
      );
      await act(async () => state.startUsageSync());
      await flush();
      const waiting = state.usageStatus;
      const committed = getCommittedConfig();
      const configReads = submitted("get_app_config").length;
      await finish(delayed, phase === "status" ? old : staleConfig);
      assert.equal(state.usageSyncing, true);
      assert.equal(state.usageStatus, waiting);
      assert.equal(getCommittedConfig(), committed);
      if (phase === "status")
        assert.equal(submitted("get_app_config").length, configReads);
      handlers.get_usage_sync_status = () => native.current();
      handlers.get_app_config = () => config;
      await reconcileSync();
      assert.equal(state.usageSyncing, true);
    },
  );
}

scenario(
  "R34 cancel wins against an in-flight active status read",
  async (concurrent) => {
    const native = nativeSyncFixture();
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    await flush();
    const stale = native.current();
    const reading = deferred();
    handlers.get_usage_sync_status = () => reading.promise;
    await reconcileSync();
    handlers.cancel_usage_sync = () => native.end();
    await act(async () => state.cancelUsageSync());
    await flush();
    assert.equal(state.usageSyncing, false);
    const status = state.usageStatus;
    assert.match(status, /已取消同步/);
    await finish(reading, stale);
    assert.equal(state.usageSyncing, false);
    assert.equal(state.usageStatus, status);
    assert.equal(timeouts.size, 0);
  },
);

scenario(
  "R34 cancel no-op waits for the older status read then obtains a fresh terminal receipt",
  async (concurrent) => {
    const native = nativeSyncFixture();
    await mount(<Probe />, concurrent);
    await act(async () => state.startUsageSync());
    await flush();
    const stale = native.current();
    const reading = deferred();
    let reads = 0;
    handlers.get_usage_sync_status = () =>
      ++reads === 1 ? reading.promise : native.current();
    await reconcileSync();
    native.end();
    handlers.cancel_usage_sync = () => null;
    await act(async () => state.cancelUsageSync());
    await flush();
    assert.equal(
      reads,
      1,
      "Cancel must not issue a parallel read or reuse the old snapshot",
    );
    await finish(reading, stale);
    assert.equal(reads, 2);
    assert.equal(state.usageSyncing, false);
    assert.doesNotMatch(state.usageStatus, /已取消同步|原 Token 未更改/);
  },
);

for (const phase of ["status", "config"] as const) {
  scenario(
    `R34 failed terminal ${phase} read retries without another user action`,
    async (concurrent) => {
      const native = nativeSyncFixture();
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      await flush();
      native.end();
      const command =
        phase === "status" ? "get_usage_sync_status" : "get_app_config";
      handlers[command] = () =>
        Promise.reject(new Error(`Synthetic ${phase} read failure`));
      await reconcileSync();
      assert.equal(state.usageSyncing, true);
      assert.match(state.usageStatus, /核对失败，将自动重试/);
      handlers[command] = () =>
        phase === "status" ? native.current() : config;
      await reconcileSync();
      assert.equal(state.usageSyncing, false);
      assert.doesNotMatch(state.usageStatus, /核对失败/);
    },
  );
}

scenario(
  "R34 failed capture subscription recovers independently while status reconciliation remains available",
  async (concurrent) => {
    const attempts = new Map<string, number>();
    g.__settingsListen = (name, callback) => {
      attempts.set(name, (attempts.get(name) ?? 0) + 1);
      if (name === "usage-token-captured" && attempts.get(name) === 1)
        return Promise.reject(
          new Error("Synthetic capture subscription failure"),
        );
      const listeners = g.__settingsListeners.get(name) ?? new Set();
      g.__settingsListeners.set(name, listeners);
      listeners.add(callback);
      return Promise.resolve(() => listeners.delete(callback));
    };
    const native = nativeSyncFixture();
    await mount(<Probe />, concurrent);
    assert.match(state.usageStatus, /同步通知连接失败/);
    await act(async () => state.startUsageSync());
    await flush();
    native.end();
    await reconcileSync();
    assert.equal(attempts.get("usage-token-captured"), 2);
    assert.equal(attempts.get("usage-sync-started"), 1);
    assert.equal(attempts.get("usage-sync-ended"), 1);
    assert.equal(state.usageSyncing, false);
    assert.doesNotMatch(state.usageStatus, /连接失败/);
  },
);

for (const outcome of ["resolve", "reject"] as const) {
  scenario(
    `R34 unmount revokes a late status ${outcome} and remount restores native terminal state`,
    async (concurrent) => {
      const native = nativeSyncFixture();
      await mount(<Probe />, concurrent);
      await act(async () => state.startUsageSync());
      await flush();
      const reading = deferred();
      handlers.get_usage_sync_status = () => reading.promise;
      await reconcileSync();
      const configReads = submitted("get_app_config").length;
      await act(async () => renderer.unmount());
      renderer = null;
      native.end();
      if (outcome === "resolve") await finish(reading, native.current());
      else
        await act(async () =>
          reading.reject(new Error("Synthetic abandoned read failure")),
        );
      await flush();
      assert.equal(submitted("get_app_config").length, configReads);
      assert.equal(timeouts.size, 0);
      handlers.get_usage_sync_status = () => native.current();
      await mount(<Probe />, concurrent);
      assert.equal(state.usageSyncing, false);
    },
  );
}

for (const action of [
  "clearUsageToken",
  "forgetUsageSession",
  "edit",
] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    scenario(
      `R34 terminal config read late ${outcome} preserves ${action} and newer drafts`,
      async (concurrent) => {
        const native = nativeSyncFixture();
        await mount(<Probe />, concurrent);
        await act(async () => state.startUsageSync());
        await flush();
        const stale = { ...getCommittedConfig() };
        native.end();
        const reading = deferred();
        handlers.get_app_config = () => reading.promise;
        const readsBefore = submitted("get_app_config").length;
        await reconcileSync();
        assert.equal(submitted("get_app_config").length, readsBefore + 1);
        assert.equal(
          timeouts.size,
          0,
          "The terminal config read is already in flight",
        );

        const changing = deferred();
        const command =
          action === "clearUsageToken"
            ? "clear_usage_token"
            : "forget_usage_session";
        if (action !== "edit") {
          handlers[command] = () => changing.promise;
          await act(async () => state[action]());
          await flush();
          assert.equal(submitted(command).length, 1);
          assert.equal(state.usageSyncing, false);
        }
        // Both drafts are newer than the login and any clear/forget submission.
        await act(async () => {
          state.setApiKey("SYNTHETIC_NEW_KEY_DRAFT");
          state.setUsageToken("SYNTHETIC_NEW_TOKEN_DRAFT");
        });
        if (action !== "edit") {
          config = nextCredentialConfig("usageToken", false);
          await finish(changing, config);
          assert.equal(state.config.usageTokenConfigured, false);
          assert.ok(state.config.usageTokenRevision > stale.usageTokenRevision);
          if (action === "forgetUsageSession")
            assert.equal(usageSessionCleanup.snapshot.phase, "succeeded");
        }
        const committed = getCommittedConfig();
        const accountRevision = committed.usageTokenRevision;
        const keyRevision = committed.apiKeyRevision;
        const feedback = state.usageStatus;
        if (outcome === "resolve") await finish(reading, stale);
        else {
          await act(async () =>
            reading.reject(new Error("Synthetic old terminal config failure")),
          );
          await flush();
        }
        assert.equal(getCommittedConfig(), committed);
        assert.equal(state.config.usageTokenRevision, accountRevision);
        assert.equal(state.config.apiKeyRevision, keyRevision);
        assert.equal(state.usageToken, "SYNTHETIC_NEW_TOKEN_DRAFT");
        assert.equal(state.apiKey, "SYNTHETIC_NEW_KEY_DRAFT");
        assert.doesNotMatch(
          state.usageStatus,
          /同步已结束|同步已被替代|同步成功|验证通过/,
        );
        assert.equal(submitted("start_usage_sync").length, 1);
        assert.equal(submitted("save_usage_token").length, 0);
        assert.equal(submitted("save_api_key").length, 0);

        if (action !== "edit") {
          assert.equal(state.usageSyncing, false);
          assert.equal(
            state.usageStatus,
            feedback,
            "A revoked read cannot replace clear/forget feedback",
          );
          assert.equal(submitted(command).length, 1);
          assert.equal(timeouts.size, 0);
        } else if (outcome === "resolve") {
          assert.equal(state.usageSyncing, false);
          assert.equal(
            state.usageStatus,
            feedback,
            "The old login feedback does not own new edits",
          );
        } else {
          // Editing revokes draft feedback, not the still-owned status check.
          // A genuine read failure remains visible and retryable without saving drafts.
          assert.equal(state.usageSyncing, true);
          assert.ok(state.usageStatus.startsWith(feedback));
          assert.match(state.usageStatus, /核对失败，将自动重试/);
          handlers.get_app_config = () => config;
          await reconcileSync();
          assert.equal(state.usageSyncing, false);
          assert.equal(state.usageStatus, feedback);
          assert.equal(state.usageToken, "SYNTHETIC_NEW_TOKEN_DRAFT");
          assert.equal(state.apiKey, "SYNTHETIC_NEW_KEY_DRAFT");
          assert.equal(getCommittedConfig(), committed);
        }
      },
    );
  }
}
