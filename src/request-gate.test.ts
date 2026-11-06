import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestGate } from "./request-gate.ts";

test("RequestGate：清除后旧请求不能提交，旧请求结束不释放新请求", async () => {
  const gate = new RequestGate<number>();
  let resolveOld: ((n: number) => void) | undefined;
  let resolveNew: ((n: number) => void) | undefined;
  const old = gate.run(
    () =>
      new Promise<number>((resolve) => {
        resolveOld = resolve;
      }),
  );
  await Promise.resolve();
  gate.invalidate();
  const fresh = gate.run(
    () =>
      new Promise<number>((resolve) => {
        resolveNew = resolve;
      }),
  );
  await Promise.resolve();
  assert.ok(resolveOld);
  resolveOld(1);
  await assert.rejects(() => old);
  assert.equal(
    gate.run(() => Promise.resolve(3)),
    fresh,
  );
  assert.ok(resolveNew);
  resolveNew(2);
  assert.equal(await fresh, 2);
});

test("RequestGate：并发查询共享请求，失败之后可以重试", async () => {
  const gate = new RequestGate<number>();
  let calls = 0;
  const first = gate.run(async () => {
    calls += 1;
    throw new Error("offline");
  });
  assert.equal(
    gate.run(() => Promise.resolve(2)),
    first,
  );
  await assert.rejects(() => first);
  assert.equal(calls, 1);
  assert.equal(await gate.run(() => Promise.resolve(4)), 4);
});

test("R33 RequestGate：首个微任务前撤销，不调用旧任务", async () => {
  const gate = new RequestGate<number>();
  let calls = 0;
  const old = gate.run(async () => {
    calls += 1;
    return 1;
  });
  gate.invalidate();
  await assert.rejects(() => old);
  assert.equal(calls, 0);
  assert.equal(await gate.run(async () => ++calls), 1);
});

test("R33 RequestGate：复用任务回调取得新检查点，旧续查不能复活", async () => {
  const gate = new RequestGate<number>();
  const checkpoints: Array<() => void> = [];
  const settle: Array<(value: number) => void> = [];
  const continuations: number[] = [];
  const fetch = async (assertCurrent: () => void) => {
    checkpoints.push(assertCurrent);
    const value = await new Promise<number>((resolve) => settle.push(resolve));
    assertCurrent();
    continuations.push(value);
    return value;
  };
  const old = gate.run(fetch);
  const rejected = assert.rejects(() => old);
  await Promise.resolve();
  gate.invalidate();
  const fresh = gate.run(fetch);
  await Promise.resolve();
  assert.equal(checkpoints.length, 2);
  assert.throws(checkpoints[0]);
  checkpoints[1]();
  settle[0](1);
  await rejected;
  assert.deepEqual(continuations, []);
  assert.equal(gate.run(fetch), fresh, "旧任务结束不能释放新任务");
  settle[1](2);
  assert.equal(await fresh, 2);
  assert.deepEqual(continuations, [2]);
  assert.throws(checkpoints[0], "新任务成功也不能恢复旧代际");
  gate.invalidate();
  assert.throws(checkpoints[1]);
});
