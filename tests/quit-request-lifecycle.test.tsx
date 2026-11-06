import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { LeavePromptDialog } from "../src/components/LeavePromptDialog";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { QuitInteractionGate } from "../src/quit-interaction";
import { useQuitInteractionBoundary } from "../src/quit-interaction-context";
import { getCommittedConfig, setCommittedConfig } from "../src/config-store";
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
  request: () => void;
  released: number;
  accept: () => void;
  reject: () => void;
};
const registrations: Registration[] = [];
// Process-lifetime sequence, matching the hook's renderer-lifetime watermark.
let quitIssued = 0;
let quitAcknowledged = 0;
const publishQuit = () => {
  quitIssued += 1;
};
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
    request: () => {
      publishQuit();
      callback();
    },
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
    case "get_pending_quit_intent":
      return quitIssued > quitAcknowledged ? String(quitIssued) : null;
    case "acknowledge_quit_intent":
      quitAcknowledged = Math.max(quitAcknowledged, Number(args.intent));
      return null;
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
      quitAcknowledged = quitIssued;
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
  "R32 quit before App mount is replayed after listener setup and duplicate wakes are inert",
  async (concurrent) => {
    publishQuit(); // No App listener exists to receive this click.
    await mount(concurrent);
    assert.equal(commands().length, 0);
    assert.equal(commands("get_pending_quit_intent").length, 0);
    await change(() => registrations[0].accept());
    assert.equal(commands().length, 1);
    assert.equal(commands("acknowledge_quit_intent").length, 1);
    await change(() => {
      registrations[0].callback();
      registrations[0].callback();
    });
    assert.equal(commands().length, 1);
  },
);

scenario(
  "R32 pending early quit survives failed setup and still negotiates drafts exactly once",
  async (concurrent) => {
    await mount(concurrent);
    publishQuit();
    await change(() => registrations[0].reject());
    await editDraft();
    await click("重试退出监听");
    await change(() => registrations[1].accept());
    assert.equal(prompts(), 1);
    assert.equal(commands().length, 0);
    await click("留在此页");
    await change(() => {
      registrations[0].callback();
      registrations[1].callback();
    });
    assert.equal(prompts(), 0);
    assert.equal(input().props.value, "DRAFT_ONLY");
    assert.equal(commands().length, 0);
    await change(() => registrations[1].request());
    assert.equal(prompts(), 1);
    await click("放弃修改并离开");
    assert.equal(commands().length, 1);
  },
);

scenario(
  "R31 listener failure is visible with window recovery, empty retry does not invent quit intent",
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
    await change(() => registrations[1].request());
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
      registrations[0].request();
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
    await change(() => registrations[0].request());
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
      await change(() => registrations[1].request());
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
      await change(() => registrations[0].request());
      await unmount();
      handlers.confirm_quit = async () => null;
      await mount(concurrent);
      await change(() => registrations[1].accept());
      await change(() => {
        if (outcome === "success") command.resolve(null);
        else command.reject(new Error("synthetic old command failure"));
      });
      assert.doesNotMatch(text(), /退出失败|正在关闭|正在请求退出/);
      await change(() => registrations[1].request());
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
    await change(() => registrations[0].request());
    await click("保存并离开");
    assert.equal(commands().length, 0);
    await unmount();
    await change(() => saving.resolve({ config: baseConfig(), balance }));
    assert.equal(commands().length, 0);
  },
);

for (const outcome of ["failure", "success"] as const) {
  scenario(
    `R32 pending quit locks retained edit and navigation callbacks (${outcome})`,
    async (concurrent) => {
      const command = deferred();
      await mount(concurrent);
      await change(() => registrations[0].accept());
      const openSettings =
        renderer.root.findByType(DashboardPanel).props.onSettings;
      await change(openSettings);
      await click("方式二：手动粘贴 token");
      const editKey = input().props.onChange;
      const editToken = renderer.root.findByProps({
        "aria-label": "用量 Token",
      }).props.onChange;
      const back = renderer.root.findByType(SettingsPanel).props.onBack;
      const save = button("验证并保存").props.onClick;
      const toggleAlert = renderer.root.findByProps({ label: "启用提醒" }).props
        .onChange;
      const retainedActions = () => {
        editKey({ target: { value: "MUST_NOT_BECOME_A_DRAFT" } });
        editToken({ target: { value: "MUST_NOT_BECOME_A_TOKEN" } });
        toggleAlert(true);
        save();
        back();
      };
      handlers.confirm_quit = () => {
        // This runs before the pending React render can disable any DOM control.
        retainedActions();
        return command.promise;
      };
      await change(() => registrations[0].request());
      await change(retainedActions);
      assert.equal(input().props.value, "");
      assert.equal(
        renderer.root.findByProps({ "aria-label": "用量 Token" }).props.value,
        "",
      );
      assert.equal(
        renderer.root.findByProps({ label: "启用提醒" }).props.checked,
        false,
      );
      assert.equal(renderer.root.findAllByType(SettingsPanel).length, 1);
      assert.equal(commands("save_api_key").length, 0);
      assert.equal(commands().length, 1);
      if (outcome === "failure") {
        await change(() => command.reject(new Error("synthetic failure")));
        await change(() => editKey({ target: { value: "RECOVERED_DRAFT" } }));
        assert.equal(input().props.value, "RECOVERED_DRAFT");
        await click("重试退出");
        assert.equal(prompts(), 1);
        assert.equal(commands().length, 1);
        await click("留在此页");
        assert.equal(input().props.value, "RECOVERED_DRAFT");
      } else {
        await change(() => command.resolve(null));
        await change(retainedActions);
        assert.equal(input().props.value, "");
        assert.equal(commands().length, 1);
      }
    },
  );
}

scenario(
  "R32 clipboard started before quit cannot create a draft after quit failure",
  async (concurrent) => {
    const clipboard = deferred<string>();
    const command = deferred();
    const previousNavigator = Object.getOwnPropertyDescriptor(g, "navigator");
    Object.defineProperty(g, "navigator", {
      configurable: true,
      value: { clipboard: { readText: () => clipboard.promise } },
    });
    try {
      handlers.confirm_quit = () => command.promise;
      await mount(concurrent);
      await change(() => registrations[0].accept());
      await change(() =>
        renderer.root.findByType(DashboardPanel).props.onSettings(),
      );
      await click("粘贴");
      await change(() => registrations[0].request());
      await change(() => command.reject(new Error("synthetic failure")));
      await change(() => clipboard.resolve("LATE_CLIPBOARD_DRAFT"));
      assert.equal(input().props.value, "");
      await change(() =>
        input().props.onChange({ target: { value: "FRESH_EDIT" } }),
      );
      assert.equal(input().props.value, "FRESH_EDIT");
    } finally {
      if (previousNavigator)
        Object.defineProperty(g, "navigator", previousNavigator);
      else delete g.navigator;
    }
  },
);

for (const quitState of ["pending", "failed"] as const) {
  for (const firstCredential of ["key", "token"] as const) {
    scenario(
      `R32 prepared ${firstCredential} save cannot continue to Token or alerts after quit ${quitState}`,
      async (concurrent) => {
        const saving = deferred();
        const quitting = deferred();
        const firstCommand =
          firstCredential === "key" ? "save_api_key" : "save_usage_token";
        handlers[firstCommand] = () => saving.promise;
        handlers.confirm_quit = () => quitting.promise;
        await mount(concurrent);
        await change(() => registrations[0].accept());
        await change(() =>
          renderer.root.findByType(DashboardPanel).props.onSettings(),
        );
        await click("方式二：手动粘贴 token");
        if (firstCredential === "key") {
          await change(() =>
            input().props.onChange({ target: { value: "PREPARED_KEY" } }),
          );
        }
        await change(() =>
          renderer.root
            .findByProps({ "aria-label": "用量 Token" })
            .props.onChange({ target: { value: "PREPARED_TOKEN" } }),
        );
        await change(() =>
          renderer.root.findByProps({ label: "启用提醒" }).props.onChange(true),
        );
        await change(() => registrations[0].request());
        await click("保存并离开");
        assert.equal(commands(firstCommand).length, 1);
        assert.equal(commands("save_alert_options").length, 0);
        assert.equal(commands().length, 0);

        // Cancellation remains available during a save. A second request can
        // then discard the same page's drafts and begin the native exit.
        await click("留在此页");
        await change(() => registrations[0].request());
        await click("放弃修改并离开");
        assert.equal(commands().length, 1);
        if (quitState === "failed") {
          await change(() =>
            quitting.reject(new Error("synthetic quit failure")),
          );
          assert.match(text(), /退出失败/);
        }
        await change(() => {
          config = baseConfig();
          saving.resolve(
            firstCredential === "key" ? { config, balance } : config,
          );
        });
        assert.equal(
          commands("save_api_key").length,
          firstCredential === "key" ? 1 : 0,
        );
        assert.equal(
          commands("save_usage_token").length,
          firstCredential === "token" ? 1 : 0,
        );
        assert.equal(commands("save_alert_options").length, 0);
        assert.equal(commands().length, 1);
        assert.equal(prompts(), 0);
        assert.equal(input().props.value, "");
        assert.equal(
          renderer.root.findByProps({ "aria-label": "用量 Token" }).props.value,
          "",
        );
        assert.equal(
          renderer.root.findByProps({ label: "启用提醒" }).props.checked,
          false,
        );
        if (quitState === "failed") {
          // The revoked save must release busy without consuming a fresh edit.
          handlers.save_usage_token = async () => (config = baseConfig());
          await change(() =>
            renderer.root
              .findByProps({ "aria-label": "用量 Token" })
              .props.onChange({ target: { value: "FRESH_TOKEN" } }),
          );
          await click("保存 Token");
          assert.equal(
            commands("save_usage_token").length,
            firstCredential === "token" ? 2 : 1,
          );
          assert.equal(
            commands("save_usage_token").at(-1).args.usageToken,
            "FRESH_TOKEN",
          );
          assert.equal(
            renderer.root.findByProps({ "aria-label": "用量 Token" }).props
              .value,
            "",
          );
          assert.equal(commands().length, 1);
        }
      },
    );
  }

  for (const credential of ["key", "token"] as const) {
    scenario(
      `R32 ${credential} save queued behind Clear never starts IPC after quit ${quitState}`,
      async (concurrent) => {
        const clearing = deferred();
        const quitting = deferred();
        const clearCommand =
          credential === "key" ? "clear_api_key" : "clear_usage_token";
        const saveCommand =
          credential === "key" ? "save_api_key" : "save_usage_token";
        const draftInput = () =>
          credential === "key"
            ? input()
            : renderer.root.findByProps({ "aria-label": "用量 Token" });
        handlers[clearCommand] = () => clearing.promise;
        handlers.confirm_quit = () => quitting.promise;
        await mount(concurrent);
        await change(() => registrations[0].accept());
        await change(() =>
          renderer.root.findByType(DashboardPanel).props.onSettings(),
        );
        await click("方式二：手动粘贴 token");
        await click(credential === "key" ? "清除 Key" : "清除 Token");
        assert.equal(commands(clearCommand).length, 1);
        // Inputs intentionally stay editable during Clear. The page's unified
        // Save and leave path queues this snapshot behind the clear barrier.
        await change(() =>
          draftInput().props.onChange({
            target: { value: "QUEUED_CANDIDATE" },
          }),
        );
        await change(() => registrations[0].request());
        await click("保存并离开");
        assert.equal(commands(saveCommand).length, 0);
        await click("留在此页");
        await change(() => registrations[0].request());
        await click("放弃修改并离开");
        assert.equal(commands().length, 1);
        if (quitState === "failed") {
          await change(() =>
            quitting.reject(new Error("synthetic quit failure")),
          );
        }
        await change(() => {
          config = {
            ...baseConfig(),
            ...(credential === "key"
              ? { apiKeyConfigured: false }
              : { usageTokenConfigured: false }),
          };
          clearing.resolve(config);
        });
        assert.equal(
          commands(saveCommand).length,
          0,
          "Revocation must be checked when the queued callback actually sends IPC",
        );
        assert.equal(commands().length, 1);
        assert.equal(prompts(), 0);
        assert.equal(draftInput().props.value, "");
        if (quitState === "failed") {
          handlers.save_usage_token = async () => (config = baseConfig());
          await change(() =>
            draftInput().props.onChange({
              target: { value: "FRESH_AFTER_CLEAR" },
            }),
          );
          await click(credential === "key" ? "验证并保存" : "保存 Token");
          assert.equal(commands(saveCommand).length, 1);
          assert.equal(
            commands(saveCommand)[0].args[
              credential === "key" ? "apiKey" : "usageToken"
            ],
            "FRESH_AFTER_CLEAR",
          );
          assert.equal(draftInput().props.value, "");
          assert.equal(commands().length, 1);
        }
      },
    );
  }

  for (const clearOutcome of ["success", "failure"] as const) {
    scenario(
      `R32 queued web login is revoked by quit ${quitState} after Clear ${clearOutcome}`,
      async (concurrent) => {
        const clearing = deferred();
        const quitting = deferred();
        handlers.clear_usage_token = () => clearing.promise;
        handlers.confirm_quit = () => quitting.promise;
        handlers.start_usage_sync = async ({ requestId }) => ({
          requestId,
          generation: 1,
          active: true,
          kind: "web",
          synced: false,
        });
        await mount(concurrent);
        await change(() => registrations[0].accept());
        await change(() =>
          renderer.root.findByType(DashboardPanel).props.onSettings(),
        );
        await click("清除 Token");
        assert.equal(commands("clear_usage_token").length, 1);
        // Clear outlives the old settings page. The remounted page's login
        // button is enabled, but its command still waits on the global barrier.
        await change(() =>
          renderer.root.findByType(SettingsPanel).props.onBack(),
        );
        assert.equal(renderer.root.findAllByType(SettingsPanel).length, 0);
        await change(() =>
          renderer.root.findByType(DashboardPanel).props.onSettings(),
        );
        await click("网页登录自动同步");
        assert.equal(commands("start_usage_sync").length, 0);
        assert.ok(button("取消同步"));
        await change(() => registrations[0].request());
        assert.equal(commands().length, 1);
        assert.equal(prompts(), 0);
        if (quitState === "failed") {
          await change(() =>
            quitting.reject(new Error("synthetic quit failure")),
          );
        }
        await change(() => {
          if (clearOutcome === "success") {
            config = { ...baseConfig(), usageTokenConfigured: false };
            clearing.resolve(config);
          } else {
            clearing.reject(new Error("synthetic clear failure"));
          }
        });
        assert.equal(
          commands("clear_usage_token").length,
          1,
          "The previously requested privacy operation is not cancelled",
        );
        assert.equal(
          getCommittedConfig()?.usageTokenConfigured,
          clearOutcome !== "success",
          "Clear receipts still update committed credentials",
        );
        assert.equal(
          commands("start_usage_sync").length,
          0,
          "Releasing Clear must not launch the revoked login",
        );
        assert.equal(commands().length, 1);
        assert.ok(
          button("网页登录自动同步"),
          "Revoked login releases its syncing state",
        );
        assert.doesNotMatch(text(), /正在打开登录窗口|同步请求已撤销/);
        if (quitState === "failed") {
          await click("网页登录自动同步");
          assert.equal(commands("start_usage_sync").length, 1);
          assert.ok(button("取消同步"));
          assert.match(text(), /等待网页登录/);
          assert.equal(commands().length, 1);
        }
      },
    );
  }
}

test("R32 native interaction fence and inert state follow the synchronous lock", async () => {
  class Node extends g.HTMLElement {
    inert = false;
    children = [];
    listeners = new Map();
    classList = {
      contains: (name) => this.recovery && name === "visibility-error",
    };
    constructor(public recovery = false) {
      super();
    }
    setAttribute() {}
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    removeEventListener(name) {
      this.listeners.delete(name);
    }
  }
  const stage = new Node();
  const content = new Node();
  const recovery = new Node(true);
  stage.children = [content, recovery];
  const gate = new QuitInteractionGate();
  function Boundary() {
    const ref = React.useRef<HTMLDivElement>(null);
    useQuitInteractionBoundary(gate, ref);
    return <div ref={ref} />;
  }
  let boundary;
  await act(async () => {
    boundary = Renderer.create(<Boundary />, { createNodeMock: () => stage });
  });
  const unlock = gate.lock();
  assert.equal(content.inert, true);
  assert.equal(recovery.inert, false, "Closing status stays accessible");
  let prevented = 0;
  let stopped = 0;
  stage.listeners.get("beforeinput")({
    cancelable: true,
    preventDefault: () => prevented++,
    stopImmediatePropagation: () => stopped++,
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  unlock();
  assert.equal(content.inert, false);
  await act(async () => boundary.unmount());
  assert.equal(stage.listeners.size, 0);
});
