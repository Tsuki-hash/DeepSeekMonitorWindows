import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

// Execute the actual Rust raw-string initialization script, not a JS port of
// the queue. Only the browser/IPC boundaries are replaced with controllable fakes.
const rustSource = readFileSync(
  new URL("../src-tauri/src/sync_script.rs", import.meta.url),
  "utf8",
);
const match = /pub const USAGE_SYNC_POLL_JS: &str = r#"([\s\S]*?)"#;/.exec(
  rustSource,
);
assert.ok(match, "the production initialization script must be extractable");
const productionScript = match[1];
assert.equal(productionScript.split("token: token").length, 2);

function token(name) {
  return `synthetic-hook-${name}-`.padEnd(40, "x");
}

const A = token("A");
const B = token("B");
const C = token("C");
const D = token("D");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Flush both the host promise and vm promise queues without wall-clock sleeps.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function page({
  generation = 41,
  host = "platform.deepseek.com",
  bridge = true,
  fetchAvailable = true,
  xhrAvailable = true,
  invoke,
} = {}) {
  const calls = [];
  const fetches = [];
  const headers = [];
  const sinks = [];
  const listeners = new Map();
  const fetchResult = { nativeFetchResult: true };
  const headerResult = { nativeHeaderResult: true };
  const document = {};
  for (const name of ["title", "cookie"]) {
    Object.defineProperty(document, name, {
      set(value) {
        sinks.push([name, value]);
      },
    });
  }
  const storage = new Proxy(
    {},
    {
      get(_, name) {
        return (...args) => sinks.push([name, ...args]);
      },
      set(_, name, value) {
        sinks.push([name, value]);
        return true;
      },
    },
  );
  const console = Object.fromEntries(
    ["log", "warn", "error", "debug", "info"].map((name) => [
      name,
      (...args) => sinks.push([name, ...args]),
    ]),
  );
  function originalFetch(...args) {
    fetches.push({ receiver: this, args });
    return fetchResult;
  }
  class XMLHttpRequest {
    setRequestHeader(...args) {
      headers.push({ receiver: this, args });
      return headerResult;
    }
  }
  const originalSet = XMLHttpRequest.prototype.setRequestHeader;
  const core = {
    invoke(command, args) {
      const call = { command, args, ...deferred() };
      calls.push(call);
      return invoke ? invoke(call) : call.promise;
    },
  };
  const window = {
    fetch: fetchAvailable ? originalFetch : undefined,
    __TAURI__: bridge ? { core } : undefined,
    localStorage: storage,
    sessionStorage: storage,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
  };
  const context = createContext({
    window,
    location: { host },
    document,
    Headers,
    XMLHttpRequest: xhrAvailable ? XMLHttpRequest : undefined,
    localStorage: storage,
    sessionStorage: storage,
    console,
  });
  function inject() {
    // This is the same generation binding used by open_login_window; the
    // script never creates a replacement generation or calls a bypass command.
    runInContext(
      productionScript.replaceAll(
        "token: token",
        `token: token, generation: ${generation}`,
      ),
      context,
      { timeout: 1000 },
    );
  }
  function capture(value, transport = "fetch") {
    if (transport === "xhr") {
      return new XMLHttpRequest().setRequestHeader(
        "Authorization",
        `Bearer ${value}`,
      );
    }
    return window.fetch("/synthetic-api", {
      headers: { Authorization: `Bearer ${value}` },
    });
  }
  inject();
  return {
    calls,
    fetches,
    headers,
    sinks,
    listeners,
    window,
    XMLHttpRequest,
    core,
    originalFetch,
    originalSet,
    fetchResult,
    headerResult,
    capture,
    inject,
    dispatch(name) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn();
    },
  };
}

function capturedTokens(browser) {
  return browser.calls.map((call) => call.args.token);
}

for (const first of ["fetch", "xhr"]) {
  test(`R24 hook: ${first} A failure drains B without resending B or reading cache`, async () => {
    const browser = page();
    browser.capture(A, first);
    browser.capture(B, first === "fetch" ? "xhr" : "fetch");
    assert.deepEqual(capturedTokens(browser), [A]);
    browser.calls[0].reject("synthetic validation failure");
    await settle();
    assert.deepEqual(capturedTokens(browser), [A, B]);
    assert.equal(browser.calls[1].command, "usage_token_captured");
    assert.equal(browser.calls[1].args.generation, 41);
    assert.deepEqual(Object.keys(browser.calls[1].args).sort(), [
      "generation",
      "token",
    ]);
    browser.calls[1].resolve({ saved: true });
    await settle();
    assert.deepEqual(browser.sinks, []);
    assert.equal(browser.window.fetch, browser.originalFetch);
    assert.equal(
      browser.XMLHttpRequest.prototype.setRequestHeader,
      browser.originalSet,
    );
  });
}

test("R24 hook: reinjection and repeated A/B preserve one flight and one queued B", async () => {
  const browser = page();
  const fetchHook = browser.window.fetch;
  const xhrHook = browser.XMLHttpRequest.prototype.setRequestHeader;
  browser.capture(A);
  for (let index = 0; index < 50; index++) {
    browser.capture(A, "xhr");
    browser.capture(B);
    browser.capture(B, "xhr");
    browser.inject();
  }
  assert.equal(browser.window.fetch, fetchHook);
  assert.equal(browser.XMLHttpRequest.prototype.setRequestHeader, xhrHook);
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].reject("synthetic invalid A");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B]);
  browser.calls[1].reject("synthetic invalid B");
  await settle();
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B]);
  // A later real observation can retry; neither failure schedules its own A/B.
  browser.capture(A);
  assert.deepEqual(capturedTokens(browser), [A, B, A]);
  browser.dispatch("pagehide");
  browser.calls[2].resolve();
  await settle();
});

test("R24 hook: keep oldest B and newest D instead of starving B with C/D arrivals", async () => {
  const browser = page();
  for (const value of [A, B, C, B, D, A, B, D]) browser.capture(value);
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].reject("synthetic A failure");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B]);
  browser.calls[1].reject("synthetic B failure");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B, D]);
  browser.calls[2].reject("synthetic D failure");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B, D]);
  browser.dispatch("unload");
});

test("R24 hook: a candidate burst retains only the oldest and latest waiters", async () => {
  const browser = page();
  browser.capture(A);
  for (let index = 0; index < 500; index++) browser.capture(token(index));
  for (let index = 0; index < 3; index++) {
    assert.equal(browser.calls.length, index + 1);
    browser.calls[index].reject("synthetic rejection");
    await settle();
  }
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, token(0), token(499)]);
  browser.dispatch("pagehide");
});

test("R24 hook: A success discards B/C and a later reinjection cannot restart capture", async () => {
  const browser = page();
  const detachedFetch = browser.window.fetch;
  browser.capture(A);
  browser.capture(B);
  browser.capture(C, "xhr");
  browser.calls[0].resolve({ saved: true });
  await settle();
  browser.inject();
  browser.capture(D);
  detachedFetch("/synthetic-api", {
    headers: { Authorization: `Bearer ${D}` },
  });
  await settle();
  assert.deepEqual(capturedTokens(browser), [A]);
  assert.equal(browser.listeners.get("pagehide").size, 0);
  assert.equal(browser.listeners.get("unload").size, 0);
  assert.deepEqual(Object.keys(browser.window.__dsm_token_hook__), ["resume"]);
  assert.equal(JSON.stringify(browser.window.__dsm_token_hook__), "{}");
  assert.deepEqual(browser.sinks, []);
});

test("R24 hook: cleanup preserves wrappers installed later by the platform", async () => {
  const browser = page();
  const fetchHook = browser.window.fetch;
  const xhrHook = browser.XMLHttpRequest.prototype.setRequestHeader;
  function laterFetch(...args) {
    return fetchHook.apply(this, args);
  }
  function laterSet(...args) {
    return xhrHook.apply(this, args);
  }
  browser.window.fetch = laterFetch;
  browser.XMLHttpRequest.prototype.setRequestHeader = laterSet;
  browser.capture(A);
  browser.capture(B, "xhr");
  browser.calls[0].resolve();
  await settle();
  assert.equal(browser.window.fetch, laterFetch);
  assert.equal(browser.XMLHttpRequest.prototype.setRequestHeader, laterSet);
  browser.capture(C);
  browser.capture(D, "xhr");
  assert.deepEqual(capturedTokens(browser), [A]);
  assert.equal(browser.fetches.length, 2);
  assert.equal(browser.headers.length, 2);
});

test("R24 hook: cleanup errors cannot reject the completion handler or restart capture", async () => {
  const browser = page();
  browser.capture(A);
  browser.capture(B);
  Object.defineProperty(browser.window, "fetch", { writable: false });
  Object.defineProperty(browser.XMLHttpRequest.prototype, "setRequestHeader", {
    writable: false,
  });
  browser.window.removeEventListener = () => {
    throw new Error("synthetic cleanup failure");
  };
  browser.calls[0].resolve();
  await settle();
  browser.inject();
  browser.capture(C);
  browser.capture(D, "xhr");
  browser.dispatch("pagehide");
  assert.deepEqual(capturedTokens(browser), [A]);
  assert.deepEqual(browser.sinks, []);
});

for (const event of ["pagehide", "unload"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`R24 hook: ${event} discards waiters before late ${outcome}`, async () => {
      const browser = page();
      const detachedFetch = browser.window.fetch;
      const detachedSet = browser.XMLHttpRequest.prototype.setRequestHeader;
      browser.capture(A);
      browser.capture(B);
      browser.capture(C, "xhr");
      browser.dispatch(event);
      browser.dispatch(event);
      browser.calls[0][outcome]("synthetic late completion");
      await settle();
      browser.inject();
      detachedFetch("/synthetic-api", {
        headers: { authorization: `Bearer ${D}` },
      });
      detachedSet.call({}, "Authorization", `Bearer ${D}`);
      await settle();
      assert.deepEqual(capturedTokens(browser), [A]);
      assert.equal(browser.window.fetch, browser.originalFetch);
      assert.equal(
        browser.XMLHttpRequest.prototype.setRequestHeader,
        browser.originalSet,
      );
      assert.deepEqual(browser.sinks, []);
      const nextDocument = page({ generation: 42 });
      nextDocument.capture(D);
      assert.deepEqual(capturedTokens(nextDocument), [D]);
      assert.equal(nextDocument.calls[0].args.generation, 42);
      nextDocument.dispatch("pagehide");
      nextDocument.calls[0].resolve();
      await settle();
    });
  }
}

for (const message of ["同步已取消", "同步已取消或已被新的操作替代"]) {
  for (const asError of [false, true]) {
    test(`R24 hook: terminal revocation ${message} (${asError ? "Error" : "string"}) stops the queue`, async () => {
      const browser = page();
      browser.capture(A);
      browser.capture(B);
      browser.calls[0].reject(asError ? new Error(message) : message);
      await settle();
      browser.inject();
      browser.capture(C);
      assert.deepEqual(capturedTokens(browser), [A]);
      assert.equal(browser.window.fetch, browser.originalFetch);
      assert.deepEqual(browser.sinks, []);
    });
  }
}

const malformedResults = [
  [
    "synchronous throw",
    () => {
      throw new Error("synthetic bridge throw");
    },
  ],
  ["undefined", () => undefined],
  ["null", () => null],
  ["plain value", () => 1],
  ["plain object", () => ({})],
  ["non-callable then", () => ({ then: true })],
  [
    "throwing then getter",
    () =>
      Object.defineProperty({}, "then", {
        get() {
          throw new Error("synthetic then getter throw");
        },
      }),
  ],
  [
    "rejecting thenable",
    () => ({
      then(_resolve, reject) {
        reject("synthetic thenable rejection");
      },
    }),
  ],
];

for (const [name, result] of malformedResults) {
  test(`R24 hook: ${name} releases A and advances reentrantly observed B`, async () => {
    let browser;
    browser = page({
      invoke(call) {
        if (call.args.token === A) {
          browser.capture(B, "xhr");
          return result();
        }
        return call.promise;
      },
    });
    browser.capture(A);
    await settle();
    assert.deepEqual(capturedTokens(browser), [A, B]);
    browser.calls[1].resolve();
    await settle();
    browser.capture(C);
    assert.deepEqual(capturedTokens(browser), [A, B]);
    assert.deepEqual(browser.sinks, []);
  });
}

test("R24 hook: a thenable cannot settle twice and advance after success", async () => {
  let browser;
  browser = page({
    invoke() {
      browser.capture(B);
      return {
        then(resolve, reject) {
          resolve();
          reject("synthetic duplicate completion");
          throw new Error("synthetic post-resolution throw");
        },
      };
    },
  });
  browser.capture(A);
  await settle();
  assert.deepEqual(capturedTokens(browser), [A]);
  assert.equal(browser.window.fetch, browser.originalFetch);
});

test("R24 hook: a synchronous revocation clears reentrantly captured waiters", async () => {
  let browser;
  browser = page({
    invoke() {
      browser.capture(B);
      throw "同步已取消";
    },
  });
  browser.capture(A);
  await settle();
  browser.inject();
  browser.capture(C);
  assert.deepEqual(capturedTokens(browser), [A]);
});

test("R24 hook: late bridge readiness drains the preserved bounded queue on reinjection", async () => {
  const browser = page({ bridge: false });
  const fetchHook = browser.window.fetch;
  browser.capture(A);
  browser.capture(B);
  browser.capture(C);
  assert.deepEqual(capturedTokens(browser), []);
  browser.window.__TAURI__ = { core: browser.core };
  browser.inject();
  assert.equal(browser.window.fetch, fetchHook);
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].reject("synthetic A failure");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, C]);
  browser.calls[1].resolve();
  await settle();
});

test("R24 hook: accepted token length is bounded and malformed headers are ignored", async () => {
  const browser = page();
  for (const value of ["", "short", "x".repeat(16 * 1024 + 1)]) {
    browser.capture(value);
  }
  browser.window.fetch("/synthetic-api", {
    headers: { Authorization: `Basic ${A}` },
  });
  assert.deepEqual(capturedTokens(browser), []);
  const maximum = "x".repeat(16 * 1024);
  browser.capture(maximum);
  assert.deepEqual(capturedTokens(browser), [maximum]);
  browser.dispatch("unload");
  browser.calls[0].reject("synthetic late failure");
  await settle();
});

test("R24 hook: a throwing bridge accessor preserves candidates without spinning", async () => {
  const browser = page({ bridge: false });
  Object.defineProperty(browser.window, "__TAURI__", {
    configurable: true,
    get() {
      throw new Error("synthetic unavailable bridge");
    },
  });
  browser.capture(A);
  browser.capture(B);
  await settle();
  assert.deepEqual(capturedTokens(browser), []);
  Object.defineProperty(browser.window, "__TAURI__", {
    value: { core: browser.core },
  });
  browser.inject();
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].reject("synthetic A failure");
  await settle();
  assert.deepEqual(capturedTokens(browser), [A, B]);
  browser.calls[1].resolve();
  await settle();
});

for (const shape of [
  "object",
  "pairs",
  "Headers",
  "Request",
  "init override",
]) {
  test(`R24 hook: fetch ${shape} preserves the original receiver, arguments, and result`, async () => {
    const browser = page();
    const receiver = {};
    let input = "/synthetic-api";
    let init;
    if (shape === "object")
      init = { headers: { aUtHoRiZaTiOn: `Bearer ${A}` } };
    if (shape === "pairs")
      init = { headers: [["AUTHORIZATION", `bEaReR ${A}`]] };
    if (shape === "Headers") {
      init = { headers: new Headers({ Authorization: `Bearer ${A}` }) };
    }
    if (shape === "Request" || shape === "init override") {
      input = new Request("https://platform.deepseek.com/synthetic-api", {
        headers: { Authorization: `Bearer ${shape === "Request" ? A : B}` },
      });
    }
    if (shape === "init override") {
      init = { headers: { Authorization: `Bearer ${A}` } };
    }
    assert.equal(
      browser.window.fetch.call(receiver, input, init),
      browser.fetchResult,
    );
    assert.deepEqual(capturedTokens(browser), [A]);
    assert.equal(browser.fetches[0].receiver, receiver);
    assert.equal(browser.fetches[0].args[0], input);
    assert.equal(browser.fetches[0].args[1], init);
    browser.calls[0].resolve();
    await settle();
  });
}

test("R24 hook: XHR interception preserves the original receiver, arguments, and result", async () => {
  const browser = page({ fetchAvailable: false });
  const request = new browser.XMLHttpRequest();
  const value = `Bearer ${A}`;
  assert.equal(
    request.setRequestHeader("AUTHORIZATION", value),
    browser.headerResult,
  );
  assert.equal(browser.headers[0].receiver, request);
  assert.deepEqual(browser.headers[0].args, ["AUTHORIZATION", value]);
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].resolve();
  await settle();
});

test("R24 hook: absent XHR does not break fetch and a foreign host installs no hook", async () => {
  const browser = page({ xhrAvailable: false });
  browser.capture(A);
  assert.deepEqual(capturedTokens(browser), [A]);
  browser.calls[0].resolve();
  await settle();
  const foreign = page({ host: "untrusted.example" });
  foreign.capture(A);
  foreign.capture(B, "xhr");
  assert.deepEqual(capturedTokens(foreign), []);
  assert.equal(foreign.window.fetch, foreign.originalFetch);
  assert.equal(foreign.window.__dsm_token_hook__, undefined);
});

test("R24 hook: a header getter failure cannot break the platform request", () => {
  const browser = page();
  const init = {
    get headers() {
      throw new Error("synthetic header getter failure");
    },
  };
  assert.equal(
    browser.window.fetch("/synthetic-api", init),
    browser.fetchResult,
  );
  assert.equal(browser.fetches.length, 1);
  assert.equal(browser.fetches[0].args[1], init);
  assert.deepEqual(capturedTokens(browser), []);
  browser.dispatch("unload");
});
