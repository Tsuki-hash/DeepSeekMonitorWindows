import { test } from "node:test";
import assert from "node:assert/strict";
import { TrayBalancePublisher } from "./tray-balance.ts";

const balance = { total: "19.62", currency: "CNY", stale: false };
const cleared = { total: null, currency: null, stale: false };
test("托盘握手等待期间清Key只发布最新空值，页面重建使用新的原生会话", async () => {
  let resolve: (session: number) => void = () => {
    throw new Error("handshake not started");
  };
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session")
      return new Promise<number>((done) => {
        resolve = done;
      });
    messages.push(args!);
  });
  const started = publisher.start();
  publisher.update(balance);
  publisher.update(cleared);
  assert.equal(messages.length, 0);
  resolve(41);
  await started;
  assert.deepEqual(messages, [{ session: 41, revision: 2, ...cleared }]);
  publisher.stop();
  const remount = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return 42;
    messages.push(args!);
  });
  remount.update(balance);
  await remount.start();
  await Promise.resolve();
  assert.deepEqual(messages.at(-1), { session: 42, revision: 1, ...balance });
  publisher.update(balance);
  assert.equal(messages.length, 2);
});
test("卸载后的迟到握手不发布旧余额，初始化失败可在后续变化时重试", async () => {
  let resolve: (session: number) => void = () => {
    throw new Error("handshake not started");
  };
  let attempts = 0;
  const messages: Record<string, unknown>[] = [];
  const old = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session")
      return new Promise<number>((done) => {
        resolve = done;
      });
    messages.push(args!);
  });
  const starting = old.start();
  old.update(balance);
  old.stop();
  resolve(1);
  await starting;
  assert.equal(messages.length, 0);
  const current = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      if (++attempts === 1) throw new Error("native unavailable");
      return 2;
    }
    messages.push(args!);
  });
  await current.start();
  current.update(cleared);
  await Promise.resolve();
  assert.deepEqual(messages, [{ session: 2, revision: 1, ...cleared }]);
});
