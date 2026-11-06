import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { AlertSettings } from "../src/components/AlertSettings";
import { SettingsPanel } from "../src/components/SettingsPanel";
import {
  getCommittedConfig,
  getConfigSubscriptionReady,
  setCommittedConfig,
} from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";
import { historyCache } from "../src/history-cache";
import { todayStr } from "../src/format";

// Synthetic IPC and renderer checks only. They do not measure native Windows
// events, DOM layout, focus, scrolling, or StrictEffects replay in WebView2.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
let timerId = 0;
const intervals = new Map<number, () => void>();
const timeouts = new Map<number, () => void>();
const storage = new Map<string, string>();
const attrs = new Map<string, string>();
g.window = {
  setInterval: (fn) => {
    const id = ++timerId;
    intervals.set(id, fn);
    return id;
  },
  clearInterval: (id) => intervals.delete(id),
  setTimeout: (fn) => {
    const id = ++timerId;
    timeouts.set(id, fn);
    return id;
  },
  clearTimeout: (id) => timeouts.delete(id),
  requestAnimationFrame: () => ++timerId,
  cancelAnimationFrame: noop,
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
  createElement: () => ({ click: noop, remove: noop }),
  body: { appendChild: noop },
};
g.HTMLElement = class {};
g.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
g.__settingsListeners = new Map();
let revision = 0;
const baseConfig = (over = {}) => ({
  configRevision: ++revision,
  apiKeyRevision: revision,
  usageTokenRevision: revision,
  configReadError: null,
  apiKeyConfigured: true,
  apiKeyPreview: "sk-…synthetic",
  usageTokenConfigured: true,
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: false,
  autostart: false,
  configPath: "SYNTHETIC_ONLY",
  ...over,
});
const defaultAlerts = () => ({
  options: {
    enabled: true,
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
});
const balance = {
  isAvailable: true,
  currency: "CNY",
  totalBalance: "100",
  grantedBalance: "0",
  toppedUpBalance: "100",
};
const usage = { models: [], rawModels: [], days: [], monthCost: 0 };
let config = baseConfig();
let alerts = defaultAlerts();
let handlers = {};
let calls = [];
g.__settingsIpc = async (command, args) => {
  calls.push({ command, args });
  if (handlers[command]) return handlers[command](args);
  switch (command) {
    case "get_app_config":
      return { ...config };
    case "get_alert_status":
      return structuredClone(alerts);
    case "get_usage_sync_status":
      return { generation: 0, requestId: null, active: false, kind: "web" };
    case "fetch_balance":
      return balance;
    case "fetch_usage":
      return usage;
    case "begin_tray_balance_session":
      return 1;
    case "update_tray_balance":
      return true;
    case "is_main_window_visible":
      return true;
    case "get_desktop_options":
      return { alwaysOnTop: false, shortcutEnabled: false, error: null };
    default:
      return null;
  }
};
let renderer;
const textOf = (node) =>
  typeof node === "string"
    ? node
    : (node?.children?.map(textOf).join("") ?? "");
const text = () => textOf(renderer.toJSON());
const button = (label) =>
  renderer.root.findAllByType("button").find((node) => textOf(node) === label);
const input = (label) => renderer.root.findByProps({ "aria-label": label });
const dashboard = () => renderer.root.findByType(DashboardPanel).props;
const submitted = (command) =>
  calls.filter((entry) => entry.command === command);
const flush = async () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const mount = async (element, concurrent) => {
  await act(async () => {
    renderer = Renderer.create(<React.StrictMode>{element}</React.StrictMode>, {
      unstable_isConcurrent: concurrent,
      unstable_strictMode: true,
      createNodeMock: () => ({
        setAttribute: noop,
        focus: noop,
        scrollTo: noop,
        scrollIntoView: noop,
        querySelector: () => ({ setAttribute: noop, focus: noop }),
      }),
    });
  });
  await flush();
};
const click = async (node) => {
  assert.ok(node);
  // Do not return a pending click Promise to act; deferred IPC is controlled below.
  await act(async () => {
    node.props.onClick();
  });
  await flush();
};
const change = async (label, value) => {
  await act(async () => input(label).props.onChange({ target: { value } }));
  await flush();
};
const emit = async (name, payload = undefined) => {
  await act(async () => {
    for (const fn of g.__settingsListeners.get(name) ?? []) fn({ payload });
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
const poll = async () => {
  assert.ok(
    intervals.size,
    "Open reminder settings must schedule status reads",
  );
  await act(async () => {
    for (const fn of [...intervals.values()]) fn();
  });
  await flush();
};
const openAlerts = async (concurrent, props = {}) => {
  await mount(<AlertSettings {...props} />, concurrent);
  await act(async () =>
    renderer.root
      .findByProps({
        className: "settings-disclosure alert-settings",
      })
      .props.onToggle({
        currentTarget: { open: true },
      }),
  );
  await flush();
};
function scenario(name, body) {
  for (const concurrent of [false, true]) {
    test(`${name} (${concurrent ? "concurrent" : "legacy"}, StrictMode)`, async () => {
      handlers = {};
      calls = [];
      config = baseConfig();
      alerts = defaultAlerts();
      setCommittedConfig(null);
      invalidateUsageRequests();
      intervals.clear();
      timeouts.clear();
      storage.clear();
      attrs.clear();
      g.__settingsListen = undefined;
      try {
        await body(concurrent);
      } finally {
        if (renderer) await act(async () => renderer.unmount());
        renderer = null;
        await flush();
        g.__settingsListen = undefined;
      }
    });
  }
}

// R32: Registration is separate from callback delivery. Events emitted before
// accept() really are lost, rather than being delivered by an eager fake.
const accountEventNames = [
  "usage-token-captured",
  "usage-token-cleared",
  "credential-config-changed",
  "browsing-data-cleared",
];
const controlAccountListeners = () => {
  const registrations: {
    name: string;
    callback: (event: { payload: unknown }) => void;
    accept: () => void;
    reject: () => void;
    releases: number;
  }[] = [];
  g.__settingsListen = (name, callback) => {
    const handlers = g.__settingsListeners.get(name) ?? new Set();
    g.__settingsListeners.set(name, handlers);
    if (!accountEventNames.includes(name)) {
      handlers.add(callback);
      return Promise.resolve(() => handlers.delete(callback));
    }
    const pending = deferred();
    const entry = {
      name,
      callback,
      releases: 0,
      accept: () => {
        handlers.add(callback);
        pending.resolve(() => {
          entry.releases++;
          handlers.delete(callback);
        });
      },
      reject: () =>
        pending.reject(new Error(`synthetic ${name} registration failure`)),
    };
    registrations.push(entry);
    return pending.promise;
  };
  return registrations;
};
const accountUsage = (account, { month, year }) => {
  const model = {
    model: `${account}-model`,
    groupKey: null,
    totalTokens: 10,
    requestCount: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: 10,
    otherTokens: 0,
    cost: 1,
  };
  return {
    schemaVersion: 2,
    models: [],
    rawModels: [model],
    days: [
      {
        date: `${year}-${String(month).padStart(2, "0")}-01`,
        rawModels: [model],
      },
    ],
    monthCost: 1,
  };
};
const settleHistory = async () => {
  for (let i = 0; i < 12; i++) await flush();
};

for (const delayedName of accountEventNames) {
  scenario(
    `R32: ${delayedName} must be installed before the first config read or account IPC`,
    async (concurrent) => {
      const oldConfig = config;
      setCommittedConfig(oldConfig);
      const month = todayStr().slice(0, 7);
      const [year, number] = month.split("-").map(Number);
      await historyCache.get(month, async () =>
        accountUsage("A", { month: number, year }),
      );
      const registrations = controlAccountListeners();
      handlers.fetch_usage = (args) => accountUsage("B", args);
      await mount(<App />, concurrent);
      assert.equal(registrations.length, 4);
      await act(async () => {
        registrations
          .filter((entry) => entry.name !== delayedName)
          .forEach((entry) => entry.accept());
      });
      await flush();
      await click(button("历史"));
      assert.equal(getConfigSubscriptionReady(), false);
      assert.equal(submitted("get_app_config").length, 0);
      assert.equal(submitted("fetch_usage").length, 0);
      assert.equal(submitted("fetch_balance").length, 0);
      assert.equal(
        renderer.root.findByType(HistoryPanel).props.configReady,
        false,
      );
      assert.equal(text().includes("A-model"), false);
      // The backend changed before the missing listener exists. Only the read
      // after ALL subscriptions are installed can discover this snapshot.
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      await emit(
        delayedName,
        delayedName === "usage-token-captured" ? { config } : config,
      );
      await act(async () =>
        registrations.find((entry) => entry.name === delayedName).accept(),
      );
      await settleHistory();
      assert.equal(submitted("get_app_config").length, 1);
      assert.equal(getCommittedConfig().configRevision, config.configRevision);
      assert.equal(getConfigSubscriptionReady(), true);
      assert.ok(text().includes("B-model"));
      assert.equal(text().includes("A-model"), false);
    },
  );
}

for (const failedName of accountEventNames) {
  scenario(
    `R32: ${failedName} registration failure closes queries, releases listeners and safely retries`,
    async (concurrent) => {
      const registrations = controlAccountListeners();
      await mount(<App />, concurrent);
      const original = registrations.slice();
      await act(async () => {
        original.find((entry) => entry.name === failedName).reject();
      });
      await flush();
      assert.ok(text().includes("账户配置同步不可用"));
      assert.equal(getConfigSubscriptionReady(), false);
      await act(async () => {
        original
          .filter((entry) => entry.name !== failedName)
          .forEach((entry) => entry.accept());
      });
      await flush();
      for (const entry of original.filter((entry) => entry.name !== failedName))
        assert.equal(
          entry.releases,
          1,
          "late successful registrations must release after failure",
        );
      await click(button("历史"));
      assert.equal(submitted("get_app_config").length, 0);
      assert.equal(submitted("fetch_usage").length, 0);
      assert.equal(submitted("fetch_balance").length, 0);
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      handlers.fetch_usage = (args) => accountUsage("B", args);
      await click(button("重试账户同步"));
      const retry = registrations.slice(original.length);
      assert.equal(retry.length, 4);
      await act(async () => retry.forEach((entry) => entry.accept()));
      await settleHistory();
      assert.equal(getConfigSubscriptionReady(), true);
      assert.ok(text().includes("B-model"));
      const accepted = getCommittedConfig();
      const obsolete = baseConfig({ apiKeyPreview: "sk-…obsolete" });
      await act(async () => {
        original.forEach((entry) =>
          entry.callback({
            payload:
              entry.name === "usage-token-captured"
                ? { config: obsolete }
                : obsolete,
          }),
        );
      });
      await flush();
      assert.equal(
        getCommittedConfig(),
        accepted,
        "disposed callbacks cannot publish even a higher revision",
      );
      assert.equal(submitted("get_app_config").length, 1);
    },
  );
}

for (const late of ["success", "failure"]) {
  scenario(
    `R32: a newer config event survives the initial read's late ${late} without waiving reconciliation`,
    async (concurrent) => {
      const initial = deferred();
      const oldConfig = config;
      handlers.get_app_config = () => initial.promise;
      handlers.fetch_usage = (args) => accountUsage("B", args);
      await mount(<App />, concurrent);
      assert.equal(submitted("get_app_config").length, 1);
      assert.equal(submitted("fetch_usage").length, 0);
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      await emit("credential-config-changed", config);
      assert.equal(
        submitted("fetch_usage").length,
        0,
        "bootstrap stays closed until reconciliation settles",
      );
      await act(async () => {
        if (late === "success") initial.resolve(oldConfig);
        else initial.reject(new Error("obsolete read failure"));
      });
      await settleHistory();
      assert.equal(getCommittedConfig().configRevision, config.configRevision);
      if (late === "failure") {
        assert.equal(getConfigSubscriptionReady(), false);
        assert.ok(text().includes("账户配置同步不可用"));
        assert.equal(submitted("fetch_usage").length, 0);
        assert.equal(submitted("fetch_balance").length, 0);
        delete handlers.get_app_config;
        await click(button("重试账户同步"));
        await settleHistory();
      }
      assert.equal(getConfigSubscriptionReady(), true);
      await click(button("历史"));
      await settleHistory();
      assert.ok(text().includes("B-model"));
      assert.equal(text().includes("账户配置同步不可用"), false);
    },
  );
}

for (const source of ["event", "write receipt"]) {
  scenario(
    `R32: accepted delayed B ${source} cannot discard the initial read of newer C`,
    async (concurrent) => {
      const old = config;
      setCommittedConfig(old);
      const delayed = baseConfig({ apiKeyPreview: "sk-…B" });
      config = baseConfig({ apiKeyPreview: "sk-…C" });
      const reading = deferred();
      handlers.get_app_config = () => reading.promise;
      handlers.fetch_usage = (args) => accountUsage("C", args);
      await mount(<App />, concurrent);
      assert.equal(submitted("get_app_config").length, 1);
      if (source === "event") {
        await emit("credential-config-changed", delayed);
      } else {
        // The settings save response publishes through this same store entry,
        // even when the native change event was emitted before registration.
        await act(async () => setCommittedConfig(delayed));
      }
      assert.equal(getCommittedConfig().configRevision, delayed.configRevision);
      assert.equal(getConfigSubscriptionReady(), false);
      assert.equal(submitted("fetch_usage").length, 0);
      await act(async () => reading.resolve(config));
      await settleHistory();
      assert.equal(getCommittedConfig().configRevision, config.configRevision);
      assert.equal(getCommittedConfig().apiKeyPreview, "sk-…C");
      assert.equal(getConfigSubscriptionReady(), true);
      await click(button("历史"));
      await settleHistory();
      assert.ok(text().includes("C-model"));
      assert.equal(text().includes("B-model"), false);
    },
  );
}

for (const invalidRevision of [
  undefined,
  NaN,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  "3",
]) {
  for (const source of ["read", "event"]) {
    scenario(
      `R32: incomparable ${String(invalidRevision)} config version from ${source} fails closed and retries`,
      async (concurrent) => {
        const old = config;
        setCommittedConfig(old);
        const reading = deferred();
        handlers.get_app_config = () => reading.promise;
        await mount(<App />, concurrent);
        const invalid = {
          ...old,
          configRevision: invalidRevision,
          apiKeyPreview: "sk-…invalid",
        };
        if (source === "event")
          await emit("credential-config-changed", invalid);
        await act(async () =>
          reading.resolve(source === "read" ? invalid : old),
        );
        await flush();
        assert.equal(
          getCommittedConfig(),
          old,
          "an incomparable snapshot must never poison the store",
        );
        assert.equal(getConfigSubscriptionReady(), false);
        assert.ok(text().includes("账户配置同步不可用"));
        assert.equal(submitted("fetch_usage").length, 0);
        assert.equal(submitted("fetch_balance").length, 0);
        for (const name of accountEventNames)
          assert.equal(g.__settingsListeners.get(name)?.size ?? 0, 0);
        config = baseConfig({ apiKeyPreview: "sk-…recovered" });
        delete handlers.get_app_config;
        await click(button("重试账户同步"));
        await settleHistory();
        assert.equal(getConfigSubscriptionReady(), true);
        assert.equal(
          getCommittedConfig().configRevision,
          config.configRevision,
        );
      },
    );
  }
}

scenario(
  "R32: conflicting equal-version read cannot be masked by a concurrently accepted event",
  async (concurrent) => {
    setCommittedConfig(config);
    const reading = deferred();
    handlers.get_app_config = () => reading.promise;
    await mount(<App />, concurrent);
    const newer = baseConfig({ apiKeyPreview: "sk-…B" });
    await emit("credential-config-changed", newer);
    await act(async () =>
      reading.resolve({ ...newer, apiKeyPreview: "sk-…conflict" }),
    );
    await flush();
    assert.equal(getCommittedConfig(), newer);
    assert.equal(getConfigSubscriptionReady(), false);
    assert.ok(text().includes("账户配置同步不可用"));
    assert.equal(submitted("fetch_usage").length, 0);
    config = baseConfig({ apiKeyPreview: "sk-…C" });
    delete handlers.get_app_config;
    await click(button("重试账户同步"));
    await settleHistory();
    assert.equal(getConfigSubscriptionReady(), true);
    assert.equal(getCommittedConfig().configRevision, config.configRevision);
  },
);

for (const event of ["older", "duplicate"]) {
  scenario(
    `R32: an ${event} event cannot discard a newer post-registration snapshot`,
    async (concurrent) => {
      const old = config;
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      const observed = config;
      setCommittedConfig(observed);
      const reading = deferred();
      handlers.get_app_config = () => reading.promise;
      await mount(<App />, concurrent);
      assert.equal(submitted("get_app_config").length, 1);
      await emit(
        "credential-config-changed",
        event === "older" ? old : observed,
      );
      const current = baseConfig({ apiKeyPreview: "sk-…C" });
      await act(async () => reading.resolve(current));
      await settleHistory();
      assert.equal(getCommittedConfig().configRevision, current.configRevision);
      assert.equal(getConfigSubscriptionReady(), true);
    },
  );
}

scenario(
  "R32: failed initial reconciliation is recoverable and releases all account listeners",
  async (concurrent) => {
    const registrations = controlAccountListeners();
    handlers.get_app_config = () =>
      Promise.reject(new Error("synthetic initial read failure"));
    await mount(<App />, concurrent);
    await act(async () =>
      registrations.slice().forEach((entry) => entry.accept()),
    );
    await flush();
    assert.equal(getConfigSubscriptionReady(), false);
    assert.ok(text().includes("账户配置同步不可用"));
    assert.ok(registrations.every((entry) => entry.releases === 1));
    assert.equal(submitted("fetch_usage").length, 0);
    delete handlers.get_app_config;
    await click(button("重试账户同步"));
    await act(async () =>
      registrations.slice(4).forEach((entry) => entry.accept()),
    );
    await settleHistory();
    assert.equal(getConfigSubscriptionReady(), true);
    assert.equal(dashboard().usageState, "ok");
  },
);

scenario(
  "R32: unmount revokes late registrations and retained native callbacks",
  async (concurrent) => {
    const registrations = controlAccountListeners();
    await mount(<App />, concurrent);
    const before = getCommittedConfig();
    await act(async () => renderer.unmount());
    renderer = null;
    await act(async () => registrations.forEach((entry) => entry.accept()));
    await flush();
    assert.ok(registrations.every((entry) => entry.releases === 1));
    const obsolete = baseConfig();
    await act(async () =>
      registrations.forEach((entry) =>
        entry.callback({
          payload:
            entry.name === "usage-token-captured"
              ? { config: obsolete }
              : obsolete,
        }),
      ),
    );
    assert.equal(getCommittedConfig(), before);
    assert.equal(getConfigSubscriptionReady(), false);
    assert.equal(submitted("get_app_config").length, 0);
    assert.equal(submitted("fetch_usage").length, 0);
  },
);

for (const late of ["success", "failure"]) {
  scenario(
    `R32: an unmounted owner's initial read ${late} cannot alter its replacement`,
    async (concurrent) => {
      const initial = deferred();
      const oldConfig = config;
      handlers.get_app_config = () => initial.promise;
      await mount(<App />, concurrent);
      await act(async () => renderer.unmount());
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      delete handlers.get_app_config;
      await mount(<App />, concurrent);
      const accepted = getCommittedConfig();
      const before = calls.length;
      await act(async () => {
        if (late === "success") initial.resolve(oldConfig);
        else initial.reject(new Error("obsolete owner read failure"));
      });
      await flush();
      assert.equal(getCommittedConfig(), accepted);
      assert.equal(getConfigSubscriptionReady(), true);
      assert.equal(calls.length, before);
    },
  );
}

scenario(
  "R32: a live account change cannot merge A history with B continuation or export",
  async (concurrent) => {
    let account = "A";
    handlers.fetch_usage = (args) => accountUsage(account, args);
    const blobs: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      blobs.push(blob);
      return "blob:synthetic-r32-history";
    };
    URL.revokeObjectURL = noop;
    try {
      await mount(<App />, concurrent);
      await click(button("历史"));
      await click(button("全部"));
      await settleHistory();
      assert.ok(text().includes("A-model"));
      const oldExport = button("JSON").props.onClick;
      account = "B";
      config = baseConfig({ apiKeyPreview: "sk-…B" });
      await emit("credential-config-changed", config);
      await settleHistory();
      assert.ok(text().includes("B-model"));
      assert.equal(text().includes("A-model"), false);
      await act(async () => oldExport());
      assert.equal(blobs.length, 0);
      await click(button("继续加载更早月份 ›"));
      await settleHistory();
      await click(button("JSON"));
      assert.equal(blobs.length, 1);
      const result = JSON.parse(await blobs[0].text());
      assert.ok(result.sourceMonthlySnapshots.length > 12);
      assert.ok(result.daily.length > 0);
      assert.ok(result.daily.every((row) => row.model === "B-model"));
      assert.ok(
        result.sourceMonthlySnapshots.every(
          (month) =>
            month.models.length > 0 &&
            month.models.every((model) => model.model === "B-model"),
        ),
      );
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  },
);

scenario(
  "R32: losing config-event trust synchronously revokes loaded history and obsolete handlers",
  async (concurrent) => {
    const registrations = controlAccountListeners();
    handlers.fetch_usage = (args) => accountUsage("A", args);
    await mount(<App />, concurrent);
    await act(async () =>
      registrations.slice().forEach((entry) => entry.accept()),
    );
    await settleHistory();
    await click(button("历史"));
    await settleHistory();
    assert.ok(text().includes("A-model"));
    const oldRefresh = renderer.root.findByProps({
      "aria-label": "重新查询历史",
    }).props.onClick;
    const before = submitted("fetch_usage").length;
    const accepted = getCommittedConfig();
    await act(async () => {
      const changed = registrations.find(
        (entry) => entry.name === "credential-config-changed",
      );
      // Same version with different contents violates the backend snapshot
      // contract. A delivery callback failure must close, not keep stale data.
      changed.callback({
        payload: { ...accepted, apiKeyPreview: "inconsistent" },
      });
      oldRefresh();
    });
    await flush();
    assert.equal(getConfigSubscriptionReady(), false);
    assert.equal(submitted("fetch_usage").length, before);
    assert.equal(text().includes("A-model"), false);
    assert.ok(text().includes("账户配置同步不可用"));
    assert.ok(registrations.every((entry) => entry.releases === 1));
    config = baseConfig({ apiKeyPreview: "sk-…B" });
    handlers.fetch_usage = (args) => accountUsage("B", args);
    await click(button("重试账户同步"));
    await act(async () =>
      registrations.slice(4).forEach((entry) => entry.accept()),
    );
    await settleHistory();
    assert.ok(text().includes("B-model"));
    assert.equal(text().includes("A-model"), false);
  },
);

scenario(
  "R17: invalid balance refresh keeps the last trusted amount and timestamp until recovery",
  async (concurrent) => {
    const originalNow = Date.now;
    let now = 1_793_900_000_000;
    Date.now = () => now;
    try {
      const trusted = {
        ...balance,
        totalBalance: "12.34",
        toppedUpBalance: "12.34",
      };
      handlers.fetch_balance = () => trusted;
      await mount(<App />, concurrent);
      const acceptedConfig = getCommittedConfig();
      const successfulAt = dashboard().balanceUpdatedAt;
      assert.equal(dashboard().balanceState, "ok");
      assert.deepEqual(dashboard().balance, trusted);
      assert.equal(successfulAt, now);
      assert.equal(dashboard().balanceError, "");
      assert.equal(
        submitted("update_tray_balance").at(-1)?.args.total,
        "12.34",
      );
      assert.equal(submitted("update_tray_balance").at(-1)?.args.stale, false);

      now += 60_000;
      const invalidData = {
        code: "invalid_data",
        message: "synthetic invalid balance payload",
        retryable: false,
      };
      handlers.fetch_balance = () => Promise.reject(invalidData);
      const beforeFailure = submitted("fetch_balance").length;
      await click(input("刷新"));
      assert.equal(submitted("fetch_balance").length, beforeFailure + 1);
      // The retained-data UI uses ok + error; stale belongs to the tray payload,
      // not LoadState. A failed response must not replace the successful time.
      assert.equal(dashboard().balanceState, "ok");
      assert.deepEqual(dashboard().balance, trusted);
      assert.equal(dashboard().balanceUpdatedAt, successfulAt);
      assert.equal(dashboard().balanceError, invalidData.message);
      assert.ok(text().includes("12.34"));
      assert.ok(text().includes("更新失败"));
      assert.equal(
        submitted("update_tray_balance").at(-1)?.args.total,
        "12.34",
      );
      assert.equal(
        submitted("update_tray_balance").at(-1)?.args.currency,
        "CNY",
      );
      assert.equal(submitted("update_tray_balance").at(-1)?.args.stale, true);
      assert.equal(getCommittedConfig(), acceptedConfig);

      now += 60_000;
      const recovered = {
        ...trusted,
        totalBalance: "23.45",
        toppedUpBalance: "23.45",
      };
      handlers.fetch_balance = () => recovered;
      await click(input("刷新"));
      assert.equal(dashboard().balanceState, "ok");
      assert.deepEqual(dashboard().balance, recovered);
      assert.equal(dashboard().balanceUpdatedAt, now);
      assert.notEqual(dashboard().balanceUpdatedAt, successfulAt);
      assert.equal(dashboard().balanceError, "");
      assert.equal(text().includes("更新失败"), false);
      assert.equal(
        submitted("update_tray_balance").at(-1)?.args.total,
        "23.45",
      );
      assert.equal(submitted("update_tray_balance").at(-1)?.args.stale, false);
      assert.equal(getCommittedConfig(), acceptedConfig);
    } finally {
      Date.now = originalNow;
    }
  },
);

scenario(
  "R14-03: unreadable config owns both channels and recovers to trusted empty",
  async (concurrent) => {
    const pendingBalance = deferred(),
      pendingUsage = deferred();
    handlers.fetch_balance = () => pendingBalance.promise;
    handlers.fetch_usage = () => pendingUsage.promise;
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "合成配置 JSON 无法读取",
    });
    await mount(<App />, concurrent);
    assert.ok(text().includes("配置读取失败"));
    assert.ok(text().includes(config.configReadError));
    assert.equal(
      renderer.root.findAllByProps({ "data-testid": "onboarding-panel" })
        .length,
      0,
    );
    assert.equal(dashboard().balanceState, "error");
    assert.equal(dashboard().usageState, "error");
    await act(async () => {
      pendingBalance.resolve(balance);
      pendingUsage.resolve(usage);
    });
    await flush();
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().usage, null);
    assert.equal(dashboard().balanceError, config.configReadError);
    assert.equal(dashboard().usageError, config.configReadError);
    const before =
      submitted("fetch_balance").length + submitted("fetch_usage").length;
    await click(input("刷新"));
    await emit("main-window-shown");
    assert.equal(
      submitted("fetch_balance").length + submitted("fetch_usage").length,
      before,
    );
    assert.equal(submitted("update_tray_balance").at(-1)?.args.total, null);
    // Keep configured booleans AND credential revisions unchanged on recovery.
    config = { ...config, configRevision: ++revision, configReadError: null };
    await click(button("重新读取配置"));
    assert.equal(text().includes("配置读取失败"), false);
    assert.equal(
      renderer.root.findAllByProps({ "data-testid": "onboarding-panel" })
        .length,
      1,
    );
    assert.equal(dashboard().balanceState, "nokey");
    assert.equal(dashboard().usageState, "nokey");
    assert.equal(dashboard().balanceError, "");
    assert.equal(dashboard().usageError, "未配置用量 Token");
  },
);

scenario(
  "R31: App history waits for config and preserves read-error recovery instead of offering Token login",
  async (concurrent) => {
    const initialRead = deferred();
    handlers.get_app_config = () => initialRead.promise;
    await mount(<App />, concurrent);
    const before = submitted("fetch_usage").length;
    await click(button("历史"));
    let history = renderer.root.findByType(HistoryPanel);
    assert.equal(history.props.configReady, false);
    assert.equal(submitted("fetch_usage").length, before);
    assert.ok(text().includes("正在确认配置"));
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "SYNTHETIC root config read error",
    });
    await act(async () => initialRead.resolve(config));
    await flush();
    history = renderer.root.findByType(HistoryPanel);
    assert.equal(history.props.configReady, true);
    assert.equal(history.props.configReadError, config.configReadError);
    assert.ok(text().includes(config.configReadError));
    assert.equal(button("去设置页配置用量 Token"), undefined);
    assert.equal(button("去设置页重新同步 Token"), undefined);
    assert.equal(submitted("fetch_usage").length, before);
    handlers.get_app_config = async () => {
      throw new Error("SYNTHETIC reread failed");
    };
    await click(button("重新读取配置"));
    assert.ok(text().includes("配置仍无法读取"));
    assert.equal(submitted("fetch_usage").length, before);
    // Keep credential versions unchanged: trust recovery itself must restart
    // the history query, rather than depending on a new Token revision.
    config = {
      ...config,
      configRevision: ++revision,
      configReadError: null,
      usageTokenConfigured: true,
    };
    delete handlers.get_app_config;
    await click(button("重新读取配置"));
    assert.equal(text().includes("配置读取失败"), false);
    assert.ok(submitted("fetch_usage").length > before);
    assert.equal(
      renderer.root.findByType(HistoryPanel).props.configReadError,
      null,
    );
  },
);

scenario(
  "R14-03: revoke live data, ignore late failure, recover configured account",
  async (concurrent) => {
    await mount(<App />, concurrent);
    assert.equal(dashboard().balanceState, "ok");
    assert.equal(dashboard().usageState, "ok");
    const pending = deferred();
    handlers.fetch_balance = () => pending.promise;
    await click(input("刷新"));
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "合成配置无效 UTF-8",
    });
    await emit("credential-config-changed", config);
    await act(async () => pending.reject(new Error("迟到网络失败")));
    await flush();
    assert.equal(dashboard().balance, null);
    assert.equal(dashboard().usage, null);
    assert.equal(dashboard().balanceError, config.configReadError);
    assert.equal(dashboard().usageError, config.configReadError);
    assert.equal(submitted("update_tray_balance").at(-1)?.args.total, null);
    handlers.fetch_balance = () => balance;
    config = baseConfig();
    await click(button("重新读取配置"));
    assert.equal(dashboard().balanceState, "ok");
    assert.equal(dashboard().usageState, "ok");
    assert.equal(dashboard().balanceError, "");
    assert.equal(dashboard().usageError, "");
    assert.equal(
      renderer.root.findAllByProps({ "data-testid": "onboarding-panel" })
        .length,
      0,
    );
  },
);

scenario(
  "R14-03: unreadable-config action opens settings without onboarding",
  async (concurrent) => {
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "合成配置无权限",
    });
    await mount(<App />, concurrent);
    await click(button("打开设置"));
    assert.equal(
      renderer.root.findAllByProps({ "data-testid": "settings-panel" }).length,
      1,
    );
    assert.ok(text().includes("合成配置无权限"));
  },
);

for (const configured of [false, true]) {
  scenario(
    `R15-07: settings rereads repaired ${configured ? "configured" : "empty"} config without submitting drafts`,
    async (concurrent) => {
      config = baseConfig({
        apiKeyConfigured: false,
        usageTokenConfigured: false,
        configReadError: "synthetic unreadable config",
      });
      await mount(<App />, concurrent);
      await click(button("打开设置"));
      await change("API Key", "SYNTHETIC_UNSAVED_KEY");
      await click(button("方式二：手动粘贴 token"));
      await change("用量 Token", "SYNTHETIC_UNSAVED_TOKEN");
      await change("余额提醒线", "22");
      const beforeReads = submitted("get_app_config").length;
      const beforeBalance = submitted("fetch_balance").length;
      const beforeUsage = submitted("fetch_usage").length;
      const keyRevision = config.apiKeyRevision;
      const tokenRevision = config.usageTokenRevision;
      config = {
        ...config,
        configRevision: ++revision,
        configReadError: null,
        // Empty recovery deliberately keeps both credential revisions the same.
        apiKeyRevision: configured ? revision : keyRevision,
        usageTokenRevision: configured ? revision : tokenRevision,
        apiKeyConfigured: configured,
        usageTokenConfigured: configured,
      };
      await click(button("重新读取配置"));
      assert.equal(submitted("get_app_config").length, beforeReads + 1);
      const settings = renderer.root.findByType(SettingsPanel).props;
      assert.equal(settings.balanceState, configured ? "ok" : "nokey");
      assert.equal(settings.usageState, configured ? "ok" : "nokey");
      assert.equal(settings.balanceError, "");
      assert.equal(settings.usageError, configured ? "" : "未配置用量 Token");
      assert.equal(text().includes("synthetic unreadable config"), false);
      assert.equal(
        submitted("fetch_balance").length,
        beforeBalance + Number(configured),
      );
      // 一次 `fetchCurrentUsage` 会发两次 `fetch_usage`：本月一次，
      // 近 7 日图表需要时再补一次上月（见 usage-api.ts 的上月分支）。
      // 恢复为已配置账户时因此是 +2，不是 +1。
      assert.equal(
        submitted("fetch_usage").length,
        beforeUsage + (configured ? 2 : 0),
      );
      assert.equal(input("API Key").props.value, "SYNTHETIC_UNSAVED_KEY");
      assert.equal(input("用量 Token").props.value, "SYNTHETIC_UNSAVED_TOKEN");
      assert.equal(input("余额提醒线").props.value, "22");
      assert.equal(submitted("save_api_key").length, 0);
      assert.equal(submitted("save_usage_token").length, 0);
      assert.equal(submitted("save_alert_options").length, 0);
      if (!configured) {
        assert.equal(getCommittedConfig()?.apiKeyRevision, keyRevision);
        assert.equal(getCommittedConfig()?.usageTokenRevision, tokenRevision);
      }
    },
  );
}

scenario(
  "R15-07: one retry owner preserves bad config and releases after read rejection",
  async (concurrent) => {
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "synthetic config remains unreadable",
    });
    await mount(<App />, concurrent);
    await click(button("打开设置"));
    await change("API Key", "SYNTHETIC_DRAFT");
    const beforeReads = submitted("get_app_config").length;
    const beforeFetches =
      submitted("fetch_balance").length + submitted("fetch_usage").length;
    const firstRead = deferred();
    handlers.get_app_config = () => firstRead.promise;
    const retry = button("重新读取配置").props.onClick;
    await act(async () => {
      retry();
      retry();
    });
    await flush();
    assert.equal(submitted("get_app_config").length, beforeReads + 1);
    assert.equal(button("读取中…").props.disabled, true);
    await act(async () => firstRead.resolve({ ...config }));
    await flush();
    assert.ok(text().includes(config.configReadError));
    assert.equal(button("重新读取配置").props.disabled, false);
    assert.equal(
      submitted("fetch_balance").length + submitted("fetch_usage").length,
      beforeFetches,
    );
    handlers.get_app_config = () =>
      Promise.reject(new Error("synthetic IPC read failure"));
    await click(button("重新读取配置"));
    assert.equal(button("重新读取配置").props.disabled, false);
    assert.ok(text().includes(config.configReadError));
    assert.ok(text().includes("重新读取配置失败，请重试"));
    assert.equal(input("API Key").props.value, "SYNTHETIC_DRAFT");
    assert.equal(submitted("save_api_key").length, 0);
    assert.equal(
      submitted("fetch_balance").length + submitted("fetch_usage").length,
      beforeFetches,
    );
    // Recovery arriving AFTER the failed retry must clear its local read error too.
    config = baseConfig();
    await emit("credential-config-changed", config);
    assert.equal(text().includes("重新读取配置失败，请重试"), false);
    assert.equal(text().includes("synthetic config remains unreadable"), false);
    assert.equal(input("API Key").props.value, "SYNTHETIC_DRAFT");
  },
);

for (const lateFailure of [false, true]) {
  scenario(
    `R15-07: late retry ${lateFailure ? "rejection" : "response"} cannot overwrite a newer committed account`,
    async (concurrent) => {
      config = baseConfig({
        apiKeyConfigured: false,
        usageTokenConfigured: false,
        configReadError: "synthetic stale config error",
      });
      await mount(<App />, concurrent);
      await click(button("打开设置"));
      await change("API Key", "SYNTHETIC_KEEP_DRAFT");
      const stale = { ...config };
      const pending = deferred();
      handlers.get_app_config = () => pending.promise;
      await click(button("重新读取配置"));
      config = baseConfig();
      await emit("credential-config-changed", config);
      await act(async () => {
        if (lateFailure)
          pending.reject(new Error("synthetic stale IPC failure"));
        else pending.resolve(stale);
      });
      await flush();
      assert.equal(getCommittedConfig()?.configRevision, config.configRevision);
      const settings = renderer.root.findByType(SettingsPanel).props;
      assert.equal(settings.balanceState, "ok");
      assert.equal(settings.usageState, "ok");
      assert.equal(settings.balanceError, "");
      assert.equal(settings.usageError, "");
      assert.equal(text().includes(stale.configReadError), false);
      assert.equal(text().includes("重新读取配置失败，请重试"), false);
      assert.equal(input("API Key").props.value, "SYNTHETIC_KEEP_DRAFT");
      assert.equal(submitted("save_api_key").length, 0);
    },
  );
}

for (const recovery of ["retry read", "commit event"]) {
  scenario(
    `R15-07: a late mount read rejection cannot replace status recovered by ${recovery}`,
    async (concurrent) => {
      config = baseConfig({
        apiKeyConfigured: false,
        usageTokenConfigured: false,
        configReadError: "synthetic broken config before mounting settings",
      });
      await mount(<App />, concurrent);
      const mountRead = deferred();
      handlers.get_app_config = () => mountRead.promise;
      const beforeMountReads = submitted("get_app_config").length;
      await click(button("打开设置"));
      assert.equal(submitted("get_app_config").length, beforeMountReads + 1);
      await change("API Key", "SYNTHETIC_KEEP_MOUNT_DRAFT");
      await click(button("方式二：手动粘贴 token"));
      await change("用量 Token", "SYNTHETIC_KEEP_MOUNT_TOKEN");
      config = baseConfig();
      if (recovery === "retry read") {
        handlers.get_app_config = () => ({ ...config });
        await click(button("重新读取配置"));
        assert.equal(submitted("get_app_config").length, beforeMountReads + 2);
      } else {
        await emit("credential-config-changed", config);
      }
      assert.ok(text().includes(`已配置 ${config.apiKeyPreview}`));
      assert.ok(text().includes("用量 Token 已配置"));
      await act(async () =>
        mountRead.reject(new Error("synthetic obsolete mount read failure")),
      );
      await flush();
      assert.equal(
        text().includes("synthetic obsolete mount read failure"),
        false,
      );
      assert.ok(text().includes(`已配置 ${config.apiKeyPreview}`));
      assert.ok(text().includes("用量 Token 已配置"));
      const settings = renderer.root.findByType(SettingsPanel).props;
      assert.equal(settings.balanceState, "ok");
      assert.equal(settings.usageState, "ok");
      assert.equal(settings.balanceError, "");
      assert.equal(settings.usageError, "");
      assert.equal(getCommittedConfig()?.configRevision, config.configRevision);
      assert.equal(input("API Key").props.value, "SYNTHETIC_KEEP_MOUNT_DRAFT");
      assert.equal(
        input("用量 Token").props.value,
        "SYNTHETIC_KEEP_MOUNT_TOKEN",
      );
      assert.equal(submitted("save_api_key").length, 0);
      assert.equal(submitted("save_usage_token").length, 0);
    },
  );
}

for (const operationState of ["pending", "failed"]) {
  for (const mountOutcome of ["resolve", "reject"]) {
    scenario(
      `R15-07: old mount ${mountOutcome} preserves ${operationState} candidate Key feedback`,
      async (concurrent) => {
        await mount(<App />, concurrent);
        const accepted = getCommittedConfig();
        const mountRead = deferred();
        handlers.get_app_config = () => mountRead.promise;
        await click(input("设置"));
        await change("API Key", "SYNTHETIC_FAILED_CANDIDATE");
        const candidate = deferred();
        handlers.save_api_key = () => candidate.promise;
        await click(button("验证并保存"));
        assert.ok(text().includes("正在验证 API Key…"));
        if (operationState === "failed") {
          await act(async () =>
            candidate.reject(
              new Error("synthetic candidate Key verification failure"),
            ),
          );
          await flush();
        }
        const expected =
          operationState === "failed"
            ? "synthetic candidate Key verification failure"
            : "正在验证 API Key…";
        assert.ok(text().includes(expected));
        await act(async () => {
          if (mountOutcome === "resolve") mountRead.resolve({ ...config });
          else
            mountRead.reject(
              new Error("synthetic obsolete same-version read failure"),
            );
        });
        await flush();
        assert.ok(text().includes(expected));
        assert.equal(
          text().includes("synthetic obsolete same-version read failure"),
          false,
        );
        assert.equal(
          input("API Key").props.value,
          "SYNTHETIC_FAILED_CANDIDATE",
        );
        assert.equal(getCommittedConfig(), accepted);
        assert.equal(
          renderer.root.findByType(SettingsPanel).props.balanceState,
          "ok",
        );
        assert.equal(submitted("save_api_key").length, 1);
        if (operationState === "pending") {
          await act(async () =>
            candidate.reject(
              new Error("synthetic candidate Key verification failure"),
            ),
          );
          await flush();
          assert.ok(
            text().includes("synthetic candidate Key verification failure"),
          );
        }
      },
    );
  }
}

scenario(
  "R15-07: a real unreadable snapshot still supersedes candidate Key feedback",
  async (concurrent) => {
    await mount(<App />, concurrent);
    const mountRead = deferred();
    handlers.get_app_config = () => mountRead.promise;
    await click(input("设置"));
    await change("API Key", "SYNTHETIC_KEEP_BAD_CANDIDATE");
    handlers.save_api_key = () =>
      Promise.reject(new Error("synthetic candidate Key verification failure"));
    await click(button("验证并保存"));
    assert.ok(text().includes("synthetic candidate Key verification failure"));
    config = baseConfig({
      apiKeyConfigured: false,
      usageTokenConfigured: false,
      configReadError: "synthetic authoritative config read error",
    });
    await act(async () => mountRead.resolve({ ...config }));
    await flush();
    assert.ok(text().includes(config.configReadError));
    assert.equal(
      text().includes("synthetic candidate Key verification failure"),
      false,
    );
    assert.equal(getCommittedConfig()?.configRevision, config.configRevision);
    const settings = renderer.root.findByType(SettingsPanel).props;
    assert.equal(settings.balanceState, "error");
    assert.equal(settings.usageState, "error");
    assert.equal(settings.balanceError, config.configReadError);
    assert.equal(settings.usageError, config.configReadError);
    assert.equal(input("API Key").props.value, "SYNTHETIC_KEEP_BAD_CANDIDATE");
  },
);

scenario(
  "R14-01/04: hide and show preserve the same settings draft and guard cancellation",
  async (concurrent) => {
    config = baseConfig({ autoRefreshEnabled: true });
    await mount(<App />, concurrent);
    await click(input("设置"));
    await change("API Key", "SYNTHETIC_UNSAVED_DRAFT");
    await click(button("方式二：手动粘贴 token"));
    await change("用量 Token", "SYNTHETIC_UNSAVED_TOKEN");
    await change("余额提醒线", "22");
    const panel = renderer.root.findByProps({
      "data-testid": "settings-panel",
    });
    await emit("main-window-hidden");
    assert.equal(input("API Key").props.value, "SYNTHETIC_UNSAVED_DRAFT");
    const before =
      submitted("fetch_balance").length + submitted("fetch_usage").length;
    await act(async () => {
      for (const [id, fn] of [...timeouts]) {
        timeouts.delete(id);
        fn();
      }
    });
    await flush();
    assert.equal(
      submitted("fetch_balance").length + submitted("fetch_usage").length,
      before,
    );
    await emit("main-window-shown");
    assert.equal(
      renderer.root.findByProps({ "data-testid": "settings-panel" }),
      panel,
    );
    assert.equal(input("API Key").props.value, "SYNTHETIC_UNSAVED_DRAFT");
    assert.equal(input("用量 Token").props.value, "SYNTHETIC_UNSAVED_TOKEN");
    assert.equal(input("余额提醒线").props.value, "22");
    await click(input("返回主面板"));
    assert.equal(
      renderer.root.findAllByProps({ role: "alertdialog" }).length,
      1,
    );
    assert.equal(
      renderer.root.findByProps({ "data-testid": "settings-panel" }),
      panel,
    );
    await click(button("留在此页"));
    assert.equal(
      renderer.root.findAllByProps({ role: "alertdialog" }).length,
      0,
    );
    assert.equal(input("API Key").props.value, "SYNTHETIC_UNSAVED_DRAFT");
    assert.equal(input("用量 Token").props.value, "SYNTHETIC_UNSAVED_TOKEN");
    assert.equal(input("余额提醒线").props.value, "22");
    assert.equal(submitted("confirm_quit").length, 0);
  },
);

scenario(
  "R14-10: status read recovery clears only read errors and keeps dirty amounts",
  async (concurrent) => {
    await openAlerts(concurrent);
    await change("余额提醒线", "23");
    handlers.get_alert_status = () => {
      throw new Error("合成读取暂时失败");
    };
    await poll();
    assert.ok(text().includes("合成读取暂时失败"));
    handlers.get_alert_status = () => structuredClone(alerts);
    await poll();
    assert.equal(text().includes("合成读取暂时失败"), false);
    assert.equal(input("余额提醒线").props.value, "23");
    assert.ok(text().includes("修改尚未保存"));
  },
);

scenario(
  "R14-10: successful polling does not erase validation or failed-save errors",
  async (concurrent) => {
    await openAlerts(concurrent);
    await change("余额提醒线", "");
    await click(button("保存提醒设置"));
    assert.ok(text().includes("余额提醒线需为"));
    await poll();
    assert.ok(text().includes("余额提醒线需为"));
    await change("余额提醒线", "25");
    handlers.save_alert_options = () => {
      throw new Error("合成保存失败");
    };
    await click(button("保存提醒设置"));
    await poll();
    assert.ok(text().includes("合成保存失败"));
    assert.equal(input("余额提醒线").props.value, "25");
    assert.equal(button("保存提醒设置").props.disabled, false);
  },
);

scenario(
  "R14-10: discarding a draft cannot clear a real status-read failure",
  async (concurrent) => {
    let blocker;
    await openAlerts(concurrent, {
      onRegisterLeaveBlocker: (value) => {
        blocker = value;
      },
    });
    await change("余额提醒线", "24");
    handlers.get_alert_status = () => {
      throw new Error("合成当前读取失败");
    };
    await poll();
    assert.ok(text().includes("合成当前读取失败"));
    await act(async () => blocker.discard());
    await flush();
    assert.equal(input("余额提醒线").props.value, "10");
    assert.ok(text().includes("合成当前读取失败"));
    handlers.get_alert_status = () => structuredClone(alerts);
    await poll();
    assert.equal(text().includes("合成当前读取失败"), false);
  },
);

scenario(
  "R14-10: read recovery preserves test-notification failure",
  async (concurrent) => {
    await openAlerts(concurrent);
    handlers.test_alert_notification = () => {
      throw new Error("合成测试通知失败");
    };
    await click(button("发送测试通知"));
    handlers.get_alert_status = () => {
      throw new Error("合成读取失败");
    };
    await poll();
    handlers.get_alert_status = () => structuredClone(alerts);
    await poll();
    assert.ok(text().includes("合成测试通知失败"));
    assert.equal(text().includes("合成读取失败"), false);
  },
);

scenario(
  "R14-10: initial read failure can be retried without remount",
  async (concurrent) => {
    handlers.get_alert_status = () => {
      throw new Error("合成首次读取失败");
    };
    await mount(<AlertSettings />, concurrent);
    assert.ok(text().includes("合成首次读取失败"));
    handlers.get_alert_status = () => structuredClone(alerts);
    await click(button("重新读取设置"));
    assert.equal(text().includes("合成首次读取失败"), false);
    assert.equal(input("余额提醒线").props.value, "10");
  },
);

test("R14-01: native source contract intercepts only main close before hiding", () => {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");
  const hook = source.slice(
    source.indexOf(".on_window_event("),
    source.indexOf(".plugin(tauri_plugin_notification"),
  );
  assert.match(hook, /WindowEvent::CloseRequested/);
  assert.match(hook, /if window\.label\(\) == "main"/);
  assert.ok(
    hook.indexOf("api.prevent_close()") <
      hook.indexOf("tray::hide_main_window_inner(&main)"),
  );
  const tray = readFileSync("src-tauri/src/tray.rs", "utf8");
  const hide = tray.slice(
    tray.indexOf("pub(crate) fn hide_main_window_inner"),
    tray.indexOf("pub(crate) const EVENT_QUIT_REQUESTED"),
  );
  assert.match(hide, /window\.hide\(\)/);
  assert.match(hide, /window\.emit\(EVENT_MAIN_WINDOW_HIDDEN/);
  const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
  const quit = commands.slice(
    commands.indexOf("pub(crate) fn confirm_quit"),
    commands.indexOf("pub(crate) fn is_main_window_visible"),
  );
  assert.match(quit, /require_main\(&window\)\?/);
  assert.match(quit, /app\.exit\(0\)/);
});

test("R14-04: CSS contract puts content and guard in one row with navigation separate", () => {
  const css = readFileSync("src/styles.css", "utf8");
  assert.match(css, /\.stage\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(
    css,
    /\.stage > \.panel,\s*\.stage > \.settings-panel\s*\{\s*grid-area:\s*1 \/ 1/,
  );
  assert.match(
    css,
    /\.leave-guard\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/,
  );
  assert.match(css, /\.primary-navigation\s*\{[^}]*grid-area:\s*2 \/ 1/);
  assert.match(
    css,
    /\.stage\.with-navigation\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 48px/,
  );
});
