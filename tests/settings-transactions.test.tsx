import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { useSettingsState } from "../src/settings-state";
import { setCommittedConfig } from "../src/config-store";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { ModelDetailPanel } from "../src/components/ModelDetailPanel";
import { useLeaveGuard } from "../src/leave-guard";

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
const baseConfig = (over = {}) => ({
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
      return { config: baseConfig(), balance };
    case "save_usage_token":
      return baseConfig();
    case "fetch_balance":
      return balance;
    case "fetch_usage":
      return { models: [], rawModels: [], days: [], monthCost: 0 };
    case "get_local_usage":
      return { enabled: false, snapshot: null, busy: false, lastError: null };
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
const hookHandlers = {
  onBalanceLoaded: noop,
  onBalanceCleared: noop,
  onUsageLoaded: noop,
  onUsageCleared: noop,
  onRefreshIntervalChanged: noop,
  onAutoRefreshChanged: noop,
};
let state;
function Probe() {
  state = useSettingsState(hookHandlers);
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
