import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { LeavePromptDialog } from "../src/components/LeavePromptDialog";
import { setCommittedConfig } from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";

// Production App, draft guard and quit hook with independently deferred native
// listeners/commands. Renderer StrictMode does not replay StrictEffects: the
// explicit unmount/remount scenarios cover ownership, not Windows/WebView2.
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
let id = 0;
const attrs = new Map();
const storage = new Map();
g.window = {
  setTimeout: () => ++id,
  clearTimeout: noop,
  setInterval: () => ++id,
  clearInterval: noop,
  requestAnimationFrame: () => ++id,
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
  visibilityState: "visible",
  activeElement: null,
  addEventListener: noop,
  removeEventListener: noop,
};
g.HTMLElement = class {};
g.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
g.__settingsListeners = new Map();
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type Registration = {
  callback: () => void;
  released: number;
  accept: () => void;
  reject: () => void;
};
const registrations: Registration[] = [];
g.__settingsListen = (name, callback) => {
  if (name !== "quit-requested") {
    const listeners = g.__settingsListeners.get(name) ?? new Set();
    g.__settingsListeners.set(name, listeners);
    listeners.add(callback);
    return Promise.resolve(() => listeners.delete(callback));
  }
  const pending = deferred<() => void>();
  const registration: Registration = {
    callback,
    released: 0,
    accept: () => pending.resolve(() => registration.released++),
    reject: () => pending.reject(new Error("synthetic registration failure")),
  };
  registrations.push(registration);
  return pending.promise;
};
let revision = 0;
const baseConfig = () => ({
  configRevision: ++revision,
  apiKeyRevision: revision,
  usageTokenRevision: revision,
  apiKeyConfigured: true,
  apiKeyPreview: "sk-…synthetic",
  usageTokenConfigured: true,
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: false,
  autostart: false,
  configPath: "SYNTHETIC_ONLY",
});
const balance = {
  isAvailable: true,
  currency: "CNY",
  totalBalance: "100",
  grantedBalance: "0",
  toppedUpBalance: "100",
};
let config = baseConfig();
let calls = [];
let handlers = {};
g.__settingsIpc = async (command, args) => {
  calls.push({ command, args });
  if (handlers[command]) return handlers[command](args);
  switch (command) {
    case "get_app_config":
      return { ...config };
    case "fetch_balance":
      return balance;
    case "fetch_usage":
      return { models: [], rawModels: [], days: [], monthCost: 0 };
    case "save_api_key":
      config = baseConfig();
      return { config, balance };
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
        balanceState: "disabled",
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
let renderer;
const nodeText = (node) =>
  typeof node === "string"
    ? node
    : (node?.children?.map(nodeText).join("") ?? "");
const text = () => nodeText(renderer.toJSON());
const button = (label) =>
  renderer.root
    .findAllByType("button")
    .find((node) => nodeText(node) === label);
const input = () => renderer.root.findByProps({ "aria-label": "API Key" });
const prompts = () => renderer.root.findAllByType(LeavePromptDialog).length;
const commands = (name = "confirm_quit") =>
  calls.filter((call) => call.command === name);
const flush = async () => {
  await act(async () => {
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  });
};
const change = async (action) => {
  await act(async () => {
    action();
  });
  await flush();
};
const click = async (label) => {
  const target = button(label);
  assert.ok(target, `Missing button ${label}`);
  assert.notEqual(target.props.disabled, true);
  await change(() => target.props.onClick());
};
const mount = async (concurrent) => {
  await act(async () => {
    renderer = Renderer.create(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
      {
        unstable_isConcurrent: concurrent,
        createNodeMock: () => ({
          setAttribute: noop,
          focus: noop,
          scrollTo: noop,
          scrollIntoView: noop,
          querySelector: () => null,
        }),
      },
    );
  });
  await flush();
};
const unmount = async () => {
  await act(async () => renderer.unmount());
  renderer = null;
  await flush();
};
const editDraft = async () => {
  await change(() =>
    renderer.root.findByType(DashboardPanel).props.onSettings(),
  );
  await change(() =>
    input().props.onChange({ target: { value: "DRAFT_ONLY" } }),
  );
};
function scenario(name, body) {
  for (const concurrent of [false, true]) {
    test(`${name} (${concurrent ? "concurrent" : "legacy"}, StrictMode)`, async () => {
      config = baseConfig();
      calls = [];
      handlers = {};
      registrations.length = 0;
      attrs.clear();
      storage.clear();
      g.__settingsListeners.clear();
      setCommittedConfig(null);
      invalidateUsageRequests();
      try {
        await body(concurrent);
      } finally {
        if (renderer) await unmount();
        invalidateUsageRequests();
        setCommittedConfig(null);
      }
    });
  }
}

scenario(
  "R31 listener failure is visible with window recovery, retry is owned and never quits automatically",
  async (concurrent) => {
    handlers.is_main_window_visible = async () => {
      throw new Error("synthetic visibility failure");
    };
    await mount(concurrent);
    await change(() => registrations[0].reject());
    assert.match(text(), /托盘退出暂不可用/);
    assert.match(text(), /无法确认窗口显隐状态/);
    assert.equal(
      renderer.root.findAllByProps({ className: "visibility-error" }).length,
      1,
    );
    const retry = button("重试退出监听").props.onClick;
    await change(() => {
      retry();
      retry();
    });
    assert.equal(registrations.length, 2);
    assert.equal(button("正在重试…").props.disabled, true);
    await change(() => registrations[0].callback());
    assert.equal(commands().length, 0);
    await change(() => registrations[1].accept());
    assert.doesNotMatch(text(), /托盘退出暂不可用|正在恢复退出监听/);
    assert.match(text(), /无法确认窗口显隐状态/);
    assert.equal(commands().length, 0);
    await change(() => registrations[1].callback());
    assert.equal(commands().length, 1);
    await unmount();
    assert.equal(registrations[1].released, 1);
  },
);

for (const decision of ["cancel", "discard", "save"] as const) {
  scenario(
    `R31 fallback exit uses unified draft ${decision}`,
    async (concurrent) => {
      await mount(concurrent);
      await change(() => registrations[0].reject());
      await editDraft();
      await click("安全退出");
      assert.equal(prompts(), 1);
      assert.equal(commands().length, 0);
      if (decision === "cancel") {
        await click("留在此页");
        assert.equal(prompts(), 0);
        assert.equal(input().props.value, "DRAFT_ONLY");
        assert.equal(commands().length, 0);
      } else if (decision === "discard") {
        await click("放弃修改并离开");
        assert.equal(commands().length, 1);
        assert.equal(commands("save_api_key").length, 0);
      } else {
        const saving = deferred();
        handlers.save_api_key = () => saving.promise;
        await click("保存并离开");
        assert.equal(commands().length, 0);
        await change(() => saving.resolve({ config: baseConfig(), balance }));
        assert.equal(commands().length, 1);
        assert.equal(commands("save_api_key").length, 1);
      }
    },
  );
}

scenario(
  "R31 command failure is visible and retries newly edited drafts, not old approval",
  async (concurrent) => {
    const command = deferred();
    handlers.confirm_quit = () => command.promise;
    await mount(concurrent);
    await change(() => registrations[0].accept());
    await change(() => {
      registrations[0].callback();
      registrations[0].callback();
    });
    assert.equal(commands().length, 1);
    assert.equal(button("安全退出").props.disabled, true);
    await change(() => command.reject(new Error("SYNTHETIC_PRIVATE_DETAIL")));
    assert.match(text(), /退出失败，应用仍保持打开/);
    assert.doesNotMatch(text(), /SYNTHETIC_PRIVATE_DETAIL/);
    await editDraft();
    await click("重试退出");
    assert.equal(prompts(), 1);
    assert.equal(commands().length, 1);
    await click("留在此页");
    assert.equal(commands().length, 1);
    assert.equal(input().props.value, "DRAFT_ONLY");
    assert.match(text(), /退出失败，应用仍保持打开/);
    handlers.confirm_quit = async () => null;
    await click("重试退出");
    await click("放弃修改并离开");
    assert.equal(commands().length, 2);
    await change(() => registrations[0].callback());
    assert.equal(
      commands().length,
      2,
      "Confirmed quit is terminal for this owner",
    );
  },
);

for (const outcome of ["success", "failure"] as const) {
  scenario(
    `R31 old listener late ${outcome} cannot affect remounted App`,
    async (concurrent) => {
      await mount(concurrent);
      const old = registrations[0];
      await unmount();
      await mount(concurrent);
      await change(() => registrations[1].accept());
      await change(() => {
        old.callback();
        if (outcome === "success") old.accept();
        else old.reject();
      });
      assert.equal(old.released, outcome === "success" ? 1 : 0);
      assert.equal(commands().length, 0);
      assert.doesNotMatch(text(), /托盘退出暂不可用|退出失败/);
      await change(() => registrations[1].callback());
      assert.equal(commands().length, 1);
    },
  );
}

for (const outcome of ["success", "failure"] as const) {
  scenario(
    `R31 old command late ${outcome} cannot affect remounted App`,
    async (concurrent) => {
      const command = deferred();
      handlers.confirm_quit = () => command.promise;
      await mount(concurrent);
      await change(() => registrations[0].accept());
      await change(() => registrations[0].callback());
      await unmount();
      handlers.confirm_quit = async () => null;
      await mount(concurrent);
      await change(() => registrations[1].accept());
      await change(() => {
        if (outcome === "success") command.resolve(null);
        else command.reject(new Error("synthetic old command failure"));
      });
      assert.doesNotMatch(text(), /退出失败|正在关闭|正在请求退出/);
      await change(() => registrations[1].callback());
      assert.equal(commands().length, 2);
    },
  );
}

scenario(
  "R31 delayed draft save cannot invoke quit after unmount",
  async (concurrent) => {
    const saving = deferred();
    handlers.save_api_key = () => saving.promise;
    await mount(concurrent);
    await change(() => registrations[0].accept());
    await editDraft();
    await change(() => registrations[0].callback());
    await click("保存并离开");
    assert.equal(commands().length, 0);
    await unmount();
    await change(() => saving.resolve({ config: baseConfig(), balance }));
    assert.equal(commands().length, 0);
  },
);
