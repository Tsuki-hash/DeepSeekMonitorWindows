import React from "react";
import Renderer, { act } from "react-test-renderer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../src/App";
import { DashboardPanel } from "../src/components/DashboardPanel";
import { AlertSettings } from "../src/components/AlertSettings";
import { setCommittedConfig } from "../src/config-store";
import { invalidateUsageRequests } from "../src/usage-api";

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
      try {
        await body(concurrent);
      } finally {
        if (renderer) await act(async () => renderer.unmount());
        renderer = null;
        await flush();
      }
    });
  }
}

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
