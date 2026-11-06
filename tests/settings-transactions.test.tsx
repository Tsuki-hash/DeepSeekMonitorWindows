import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { useSettingsState } from "../src/settings-state";
import {
  getCommittedConfig,
  getValidatedBalance,
  setCommittedConfig,
} from "../src/config-store";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { historyCache } from "../src/history-cache";
import { useLeaveGuard } from "../src/leave-guard";
import { LocalSourceSettings } from "../src/components/LocalSourceSettings";
import { LocalBackgroundSettings } from "../src/components/LocalBackgroundSettings";
import { LocalArchiveCapture } from "../src/components/LocalArchiveCapture";
import { LocalUsagePanel } from "../src/components/LocalUsagePanel";

// Synthetic values only. No credentials are written to storage, fixtures, or logs.
// The renderer honors the StrictMode wrapper but does not replay StrictEffects.
// Explicit unmount/remount tests below are not a substitute for real createRoot
// DOM/WebView2 replay. Focus assertions inspect ref calls, not native activeElement.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
let frameId = 0;
const frames = new Map<number, () => void>();
const focus: string[] = [];
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
g.window = {
  setInterval: () => ++frameId,
  clearInterval: noop,
  setTimeout: () => ++frameId,
  clearTimeout: noop,
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
    case "get_app_config":
      return { ...config };
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
    case "get_local_usage":
      return { enabled: false, snapshot: null, busy: false, lastError: null };
    case "get_local_sources":
      return { includeDefault: true, homes: [] };
    case "get_local_background":
      return {
        enabled: false,
        effective: false,
        state: "disabled",
        watchedRoots: 0,
        lastAttempt: null,
        lastSuccess: null,
        error: null,
        watchWarning: null,
      };
    case "get_local_retention_enabled":
      return false;
    case "get_local_retention_capacity":
      return {
        entries: 0,
        maxEntries: 128,
        bytes: 0,
        maxBytes: 8388608,
        remainingEntries: 128,
      };
    case "is_main_window_visible":
      return true;
    case "begin_tray_balance_session":
      return 1;
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
    querySelector: () => ({
      setAttribute: noop,
      focus: () => focus.push("generic-heading"),
    }),
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
      handlers = {};
      config = baseConfig();
      alerts = defaultAlerts();
      setCommittedConfig(null);
      storage.clear();
      focus.length = 0;
      frames.clear();
      try {
        await body(concurrent);
        assert.equal(
          [...storage.values()].some((value) => /DRAFT|TOKEN/.test(value)),
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
  "R09: failed forget is retryable and old response cannot affect remount",
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
    await emit("usage-token-captured", captured);
    await finish(pending, cleared);
    await emit("usage-token-cleared", cleared);
    await emit("usage-token-captured", captured);
    assert.equal(getCommittedConfig(), captured);
    assert.equal(state.usageToken, "TOKEN_C");
    assert.equal(state.config.usageTokenConfigured, true);
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
    await emit("usage-token-captured", captured);
    const pending = deferred();
    handlers.start_usage_sync = () => pending.promise;
    await act(async () => state.startUsageSync());
    await emit("usage-token-captured", captured);
    assert.equal(state.usageSyncing, true);
    await finish(pending, false);
    assert.equal(state.usageSyncing, true);
  },
);

// N04: native settings work can complete after IPC timeout. Events invalidate
// reads; they never certify a save, own a draft, or resurrect a stopped scan.
const localCheckbox = (label) =>
  renderer.root
    .findAllByType("label")
    .find((node) => textOf(node).includes(label))
    .findByType("input");
const checked = async (label, value) => {
  await act(async () =>
    localCheckbox(label).props.onChange({ target: { checked: value } }),
  );
  await flush();
};

scenario(
  "N04: source events update baseline without erasing timeout-era draft",
  async (concurrent) => {
    let sources = { includeDefault: true, homes: [] };
    handlers.get_local_sources = () => sources;
    const pending = deferred();
    handlers.save_local_sources = () => pending.promise;
    let save, result;
    let saved = 0;
    await mount(
      <LocalSourceSettings
        onSaved={() => saved++}
        onSaveRequested={(fn) => {
          save = fn;
        }}
      />,
      concurrent,
    );
    await change("额外主目录", "D:\\AgentA");
    await act(async () => {
      result = save();
    });
    await act(async () =>
      pending.reject(new Error("Synthetic settings timeout")),
    );
    await flush();
    assert.equal(await result, false);
    await change("额外主目录", "D:\\AgentB");
    sources = { includeDefault: true, homes: ["D:\\AgentA"] };
    await emit("local-settings-changed", 1);
    assert.equal(input("额外主目录").props.value, "D:\\AgentB");
    assert.equal(button("保存目录").props.disabled, false);
    assert.equal(saved, 0);
    assert.equal(textOf(renderer.toJSON()).includes("目录已保存"), false);
  },
);

scenario(
  "N04: source save cannot certify B/ABA edits while its response is pending",
  async (concurrent) => {
    let sources = { includeDefault: true, homes: [] };
    handlers.get_local_sources = () => sources;
    const pending = deferred();
    handlers.save_local_sources = () => pending.promise;
    let save, result;
    let saved = 0;
    await mount(
      <LocalSourceSettings
        onSaved={() => saved++}
        onSaveRequested={(fn) => {
          save = fn;
        }}
      />,
      concurrent,
    );
    await change("额外主目录", "D:\\AgentA");
    await act(async () => {
      result = save();
    });
    await change("额外主目录", "D:\\AgentB");
    await change("额外主目录", "D:\\AgentA");
    sources = { includeDefault: true, homes: ["D:\\AgentA"] };
    await emit("local-settings-changed", 1);
    await finish(pending, sources);
    assert.equal(await result, false);
    assert.equal(saved, 0);
    assert.equal(textOf(renderer.toJSON()).includes("目录已保存"), false);
  },
);

scenario(
  "N04: newest source read wins; duplicate or old events do not loop",
  async (concurrent) => {
    await mount(<LocalSourceSettings onSaved={noop} />, concurrent);
    const older = deferred(),
      newer = deferred();
    let count = 0;
    handlers.get_local_sources = () =>
      ++count === 1 ? older.promise : newer.promise;
    await emit("local-settings-changed", 2);
    await emit("local-settings-changed", 3);
    await finish(newer, { includeDefault: true, homes: ["D:\\Newest"] });
    await finish(older, { includeDefault: true, homes: ["D:\\Older"] });
    assert.equal(input("额外主目录").props.value, "D:\\Newest");
    await emit("local-settings-changed", 3);
    await emit("local-settings-changed", 2);
    await emit("local-settings-changed", "invalid");
    assert.equal(count, 2);
    await act(async () => renderer.unmount());
    renderer = null;
    await emit("local-settings-changed", 4);
    assert.equal(count, 2);
  },
);

scenario(
  "N04: confirmed source save keeps its success state without remount",
  async (concurrent) => {
    let sources = { includeDefault: true, homes: [] };
    handlers.get_local_sources = () => sources;
    handlers.save_local_sources = ({ options }) => {
      sources = options;
      return sources;
    };
    let save, result;
    let saved = 0;
    await mount(
      <LocalSourceSettings
        onSaved={() => saved++}
        onSaveRequested={(fn) => {
          save = fn;
        }}
      />,
      concurrent,
    );
    await change("额外主目录", "D:\\AgentA");
    await act(async () => {
      result = save();
    });
    await flush();
    assert.equal(await result, true);
    assert.equal(saved, 1);
    assert.equal(textOf(renderer.toJSON()).includes("目录已保存"), true);
    assert.equal(input("额外主目录").props.value, "D:\\AgentA");
  },
);

scenario(
  "N04: retention late completion converges and refreshes N05 capacity without success toast",
  async (concurrent) => {
    let enabled = false;
    handlers.get_local_retention_enabled = () => enabled;
    handlers.set_local_retention_enabled = () =>
      Promise.reject(new Error("Synthetic retention timeout"));
    await mount(
      <LocalArchiveCapture
        collectedAt={null}
        scope={{ kind: "all" }}
        disabled
        onOpen={noop}
      />,
      concurrent,
    );
    await checked("自动留存已读取会话", true);
    const reads = submitted("get_local_retention_capacity").length;
    enabled = true;
    await emit("local-settings-changed", 1);
    assert.equal(localCheckbox("自动留存已读取会话").props.checked, true);
    assert.equal(localCheckbox("自动留存已读取会话").props.disabled, false);
    assert.ok(submitted("get_local_retention_capacity").length > reads);
    assert.equal(
      textOf(renderer.toJSON()).includes("已开启，下次成功采集时自动留存"),
      false,
    );
  },
);

scenario(
  "N04: failed background stop converges and offers false-only persistence retry",
  async (concurrent) => {
    let enabled = true;
    handlers.get_local_background = () => ({
      enabled,
      effective: enabled,
      state: "watching",
      watchedRoots: 1,
    });
    handlers.set_local_background = () => {
      enabled = false;
      return Promise.reject(new Error("Synthetic stop persistence failure"));
    };
    await mount(
      <LocalBackgroundSettings localEnabled onMode={noop} />,
      concurrent,
    );
    await checked("收起后继续采集", false);
    assert.equal(localCheckbox("收起后继续采集").props.checked, false);
    assert.equal(
      textOf(renderer.toJSON()).includes("后台采集已关闭，已有留存保留"),
      false,
    );
    await click(button("重新保存后台关闭状态"));
    assert.equal(submitted("set_local_background").at(-1).args.enabled, false);
  },
);

scenario(
  "N04: failed stop rejects an old scan and never requires enabling to retry",
  async (concurrent) => {
    let status = {
      enabled: true,
      snapshot: null,
      generation: 1,
      busy: false,
      settingsPending: false,
      lastError: null,
    };
    handlers.get_local_usage = () => status;
    const scan = deferred();
    handlers.scan_local_usage = () => scan.promise;
    handlers.set_local_usage_enabled = () => {
      status = {
        ...status,
        enabled: false,
        generation: 2,
        lastError: "Synthetic stop persistence failure",
      };
      return Promise.reject(new Error(status.lastError));
    };
    await mount(<LocalUsagePanel onBack={noop} />, concurrent);
    await click(button("关闭本地统计"));
    assert.ok(button("开启本地统计"));
    await finish(scan, {
      rows: [],
      collectedAt: Date.now(),
      engineVersion: "synthetic",
      period: "month",
    });
    assert.equal(
      renderer.root.findByType(LocalArchiveCapture).props.collectedAt,
      null,
    );
    await click(button("重新保存关闭状态"));
    assert.equal(
      submitted("set_local_usage_enabled").at(-1).args.enabled,
      false,
    );
  },
);

scenario(
  "N04: pending enable converges on completion and ignores older generation",
  async (concurrent) => {
    let status = {
      enabled: false,
      snapshot: null,
      generation: 1,
      busy: false,
      settingsPending: false,
    };
    handlers.get_local_usage = () => status;
    handlers.is_main_window_visible = () => false;
    handlers.set_local_usage_enabled = () => {
      status = { ...status, generation: 2, busy: true, settingsPending: true };
      return Promise.reject(new Error("Synthetic enable timeout"));
    };
    await mount(<LocalUsagePanel onBack={noop} />, concurrent);
    await click(button("开启本地统计"));
    assert.equal(button("设置处理中…").props.disabled, true);
    status = { ...status, enabled: true, busy: false, settingsPending: false };
    await emit("local-settings-changed", 2);
    assert.ok(button("关闭本地统计"));
    status = { ...status, enabled: false, generation: 1 };
    await emit("local-settings-changed", 3);
    assert.ok(button("关闭本地统计"));
    assert.equal(button("开启本地统计"), undefined);
  },
);

scenario(
  "N04: pending stop survives remount and retries false without a fresh error",
  async (concurrent) => {
    handlers.get_local_usage = () => ({
      enabled: false,
      snapshot: null,
      generation: 3,
      busy: false,
      settingsPending: false,
      stopSavePending: true,
      lastError: null,
    });
    handlers.set_local_usage_enabled = () => ({ enabled: false });
    await mount(<LocalUsagePanel onBack={noop} />, concurrent);
    assert.ok(button("重新保存关闭状态"));
    await click(button("重新保存关闭状态"));
    assert.equal(
      submitted("set_local_usage_enabled").at(-1).args.enabled,
      false,
    );
    await act(async () => renderer.unmount());
    renderer = null;
    handlers.get_local_background = () => ({
      enabled: false,
      effective: false,
      stopSavePending: true,
      state: "disabled",
      watchedRoots: 0,
    });
    handlers.set_local_background = () => ({ enabled: false });
    await mount(
      <LocalBackgroundSettings localEnabled={false} onMode={noop} />,
      concurrent,
    );
    await click(button("重新保存后台关闭状态"));
    assert.equal(submitted("set_local_background").at(-1).args.enabled, false);
  },
);

scenario(
  "N04: App completion refresh cannot be overwritten by an older local read",
  async (concurrent) => {
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
    });
    await mount(<App />, concurrent);
    assert.equal(panel("onboarding"), 1);
    const older = deferred(),
      newer = deferred();
    let count = 0;
    handlers.get_local_usage = () =>
      ++count === 1 ? older.promise : newer.promise;
    await emit("local-settings-changed", 1);
    await emit("local-settings-changed", 2);
    await finish(newer, { enabled: true, snapshot: null, generation: 2 });
    assert.equal(panel("onboarding"), 0);
    await finish(older, { enabled: false, snapshot: null, generation: 1 });
    assert.equal(panel("onboarding"), 0);
  },
);
