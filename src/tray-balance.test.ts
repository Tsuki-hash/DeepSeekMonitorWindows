import { test } from "node:test";
import assert from "node:assert/strict";
import { TrayBalancePublisher } from "./tray-balance.ts";

const balance = { total: "19.62", currency: "CNY", stale: false };
const staleBalance = { ...balance, stale: true };
const cleared = { total: null, currency: null, stale: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// 手动推进唯一退避 timer，不使用真实等待，也不依赖 Node mock timer API。
class RetryClock {
  private next = 0;
  readonly pending = new Map<number, { delay: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next;
    this.pending.set(id, { delay, callback });
    return id;
  };
  clearTimeout = (id: number) => {
    this.pending.delete(id);
  };
  nextRetry() {
    assert.equal(this.pending.size, 1, "最多且至少有一个待重试 timer");
    const [id, job] = [...this.pending][0];
    return { id, ...job };
  }
  fire() {
    const job = this.nextRetry();
    this.pending.delete(job.id);
    job.callback();
  }
}
async function settle() {
  // transport 的 Promise、驱动 continuation 及串行发送最新值的微任务。
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

test("R15-05: 握手单飞，等待期间清 Key 只发布最新空值", async () => {
  const handshake = deferred<number>();
  const clock = new RetryClock();
  let begins = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      begins++;
      return handshake.promise;
    }
    messages.push(args!);
    return true;
  }, clock);
  const started = publisher.start();
  publisher.update(balance);
  publisher.update(staleBalance);
  publisher.update(cleared);
  await publisher.start();
  assert.equal(begins, 1);
  assert.equal(messages.length, 0);
  handshake.resolve(41);
  await started;
  assert.deepEqual(messages, [{ session: 41, revision: 3, ...cleared }]);
  assert.equal(clock.pending.size, 0);
  publisher.stop();
});

test("R15-05: 握手失败后无外部变化也重试并发布最终 null", async () => {
  const handshake = deferred<number>();
  const clock = new RetryClock();
  let begins = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      if (++begins === 1) return handshake.promise;
      return 42;
    }
    messages.push(args!);
    return true;
  }, clock);
  const started = publisher.start();
  publisher.update(balance);
  publisher.update(cleared);
  handshake.reject(new Error("托盘提示更新失败"));
  await started;
  assert.equal(clock.nextRetry().delay, 1000);
  assert.equal(messages.length, 0);
  clock.fire();
  await settle();
  assert.equal(begins, 2);
  assert.deepEqual(messages, [{ session: 42, revision: 2, ...cleared }]);
  assert.equal(clock.pending.size, 0);
  await publisher.start();
  assert.equal(messages.length, 1, "成功后 start 不重复发布已确认值");
  publisher.stop();
});

test("R15-05: 非法握手响应也退避重试，而不是永久静默退出", async () => {
  for (const invalid of [
    undefined,
    null,
    "2",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const clock = new RetryClock();
    let begins = 0;
    const messages: Record<string, unknown>[] = [];
    const publisher = new TrayBalancePublisher(async (command, args) => {
      if (command === "begin_tray_balance_session")
        return ++begins === 1 ? invalid : 7;
      messages.push(args!);
      return true;
    }, clock);
    publisher.update(balance);
    await settle();
    assert.equal(clock.nextRetry().delay, 1000);
    assert.equal(messages.length, 0);
    clock.fire();
    await settle();
    assert.deepEqual(messages, [{ session: 7, revision: 1, ...balance }]);
    assert.equal(clock.pending.size, 0);
    publisher.stop();
  }
});

test("R15-05: 永久握手失败仅有一个有界退避 timer，新 update 不绕过退避", async () => {
  const clock = new RetryClock();
  let begins = 0;
  const publisher = new TrayBalancePublisher(async (command) => {
    assert.equal(command, "begin_tray_balance_session");
    begins++;
    throw new Error("native unavailable");
  }, clock);
  await publisher.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
    const attempts = begins;
    publisher.update(balance);
    publisher.update(cleared);
    await publisher.start();
    assert.equal(begins, attempts);
    assert.equal(clock.nextRetry().delay, delay);
    clock.fire();
    await settle();
    assert.equal(begins, attempts + 1);
    assert.equal(clock.pending.size, 1);
  }
  const queuedCallback = clock.nextRetry().callback;
  const attempts = begins;
  publisher.stop();
  publisher.stop();
  assert.equal(clock.pending.size, 0);
  queuedCallback();
  publisher.update(balance);
  await publisher.start();
  assert.equal(begins, attempts, "stop 后连已排队回调也不得唤起握手");
});

test("R15-05: 从未收到余额的握手恢复后主动发布初始化 null，之后不空转", async () => {
  const clock = new RetryClock();
  let begins = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      if (++begins === 1) throw new Error("native unavailable");
      return 5;
    }
    messages.push(args!);
    return true;
  }, clock);
  await publisher.start();
  clock.fire();
  await settle();
  assert.equal(begins, 2);
  assert.deepEqual(messages, [{ session: 5, revision: 1, ...cleared }]);
  assert.equal(clock.pending.size, 0);
  publisher.update(balance);
  await settle();
  assert.deepEqual(messages, [
    { session: 5, revision: 1, ...cleared },
    { session: 5, revision: 2, ...balance },
  ]);
  publisher.stop();
});

test("R15-05: 发布真正单飞，旧余额完成后直接收敛到在途期间的最新 null", async () => {
  const first = deferred<void>();
  const clock = new RetryClock();
  let begins = 0;
  let inFlight = 0;
  let maximum = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      begins++;
      return 8;
    }
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    messages.push(args!);
    if (messages.length === 1) await first.promise;
    inFlight--;
    return true;
  }, clock);
  publisher.update(balance);
  await settle();
  publisher.update(staleBalance);
  publisher.update({ total: "25.00", currency: "CNY", stale: false });
  publisher.update(cleared);
  await publisher.start();
  assert.equal(messages.length, 1);
  first.resolve();
  await settle();
  assert.deepEqual(messages, [
    { session: 8, revision: 1, ...balance },
    { session: 8, revision: 4, ...cleared },
  ]);
  assert.equal(begins, 1);
  assert.equal(maximum, 1);
  assert.equal(clock.pending.size, 0);
  publisher.stop();
});

test("R15-05: 旧发布失败后的 timer 只重试最新值，不重新握手", async () => {
  const first = deferred<void>();
  const clock = new RetryClock();
  let begins = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      begins++;
      return 9;
    }
    messages.push(args!);
    if (messages.length === 1) return first.promise;
    return true;
  }, clock);
  publisher.update(balance);
  await settle();
  publisher.update(staleBalance);
  first.reject(new Error("托盘菜单更新失败"));
  await settle();
  const queuedCallback = clock.nextRetry().callback;
  publisher.update(cleared);
  await publisher.start();
  assert.equal(messages.length, 1);
  assert.equal(clock.nextRetry().delay, 1000);
  clock.fire();
  await settle();
  assert.deepEqual(messages, [
    { session: 9, revision: 1, ...balance },
    { session: 9, revision: 3, ...cleared },
  ]);
  assert.equal(begins, 1);
  assert.equal(clock.pending.size, 0);
  queuedCallback();
  await settle();
  assert.equal(messages.length, 2, "旧 callback 不重复发布已经确认的 revision");
  publisher.stop();
});

test("R15-05: 菜单成功但 tooltip 失败仍重发相同代际并恢复最终状态", async () => {
  const clock = new RetryClock();
  let attempts = 0;
  let caption: unknown = "旧账户";
  let tooltip: unknown = "旧账户";
  let committedRevision = 0;
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return 10;
    messages.push(args!);
    const revision = args!.revision as number;
    if (revision <= committedRevision) return true;
    caption = args!.total;
    if (++attempts === 1) throw new Error("托盘提示更新失败");
    tooltip = args!.total;
    committedRevision = revision;
    return true;
  }, clock);
  publisher.update(cleared);
  await settle();
  assert.equal(caption, null);
  assert.equal(tooltip, "旧账户");
  assert.equal(committedRevision, 0);
  clock.fire();
  await settle();
  assert.equal(caption, null);
  assert.equal(tooltip, null);
  assert.equal(committedRevision, 1);
  assert.deepEqual(messages, [
    { session: 10, revision: 1, ...cleared },
    { session: 10, revision: 1, ...cleared },
  ]);
  assert.equal(clock.pending.size, 0);
  publisher.stop();
});

test("R15-05: 握手恢复重置退避，发布连续失败有界且恢复后不再唤起", async () => {
  const clock = new RetryClock();
  let begins = 0;
  let publishes = 0;
  let publishFails = true;
  const publisher = new TrayBalancePublisher(async (command) => {
    if (command === "begin_tray_balance_session") {
      if (++begins < 3) throw new Error("begin failed");
      return 11;
    }
    publishes++;
    if (publishFails) throw new Error("publish failed");
    return true;
  }, clock);
  publisher.update(balance);
  await settle();
  assert.equal(clock.nextRetry().delay, 1000);
  clock.fire();
  await settle();
  assert.equal(clock.nextRetry().delay, 2000);
  clock.fire();
  await settle();
  assert.equal(begins, 3);
  assert.equal(publishes, 1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(clock.nextRetry().delay, delay);
    clock.fire();
    await settle();
  }
  const obsoleteCallback = clock.nextRetry().callback;
  publishFails = false;
  clock.fire();
  await settle();
  assert.equal(clock.pending.size, 0);
  const completed = publishes;
  obsoleteCallback();
  await publisher.start();
  assert.equal(publishes, completed);
  publishFails = true;
  publisher.update(cleared);
  await settle();
  assert.equal(clock.nextRetry().delay, 1000, "成功后的下一次失败从 1 秒开始");
  obsoleteCallback();
  assert.equal(clock.pending.size, 1, "旧 callback 不能移除新一代 retry timer");
  assert.equal(begins, 3);
  publisher.stop();
});

test("R15-05: stop 后迟到握手成功或失败均不得发布或留下 timer", async () => {
  for (const fails of [false, true]) {
    const clock = new RetryClock();
    const handshake = deferred<number>();
    const commands: string[] = [];
    const publisher = new TrayBalancePublisher(async (command) => {
      commands.push(command);
      return handshake.promise;
    }, clock);
    const started = publisher.start();
    publisher.update(balance);
    publisher.stop();
    if (fails) handshake.reject(new Error("late begin failure"));
    else handshake.resolve(12);
    await started;
    publisher.update(cleared);
    await publisher.start();
    assert.deepEqual(commands, ["begin_tray_balance_session"]);
    assert.equal(clock.pending.size, 0);
  }
});

test("R15-05: stop 后迟到发布成功或失败均不得继续排队值或留下 timer", async () => {
  for (const fails of [false, true]) {
    const clock = new RetryClock();
    const publication = deferred<void>();
    const commands: string[] = [];
    const publisher = new TrayBalancePublisher(async (command) => {
      commands.push(command);
      if (command === "begin_tray_balance_session") return 13;
      return publication.promise;
    }, clock);
    publisher.update(balance);
    await settle();
    publisher.update(cleared);
    publisher.stop();
    if (fails) publication.reject(new Error("late update failure"));
    else publication.resolve();
    await settle();
    assert.deepEqual(commands, [
      "begin_tray_balance_session",
      "update_tray_balance",
    ]);
    assert.equal(clock.pending.size, 0);
  }
});

test("R15-05: 页面重建后旧握手回执不能发布，新会话只发送最新状态", async () => {
  const oldHandshake = deferred<number>();
  const oldClock = new RetryClock();
  const newClock = new RetryClock();
  const messages: Record<string, unknown>[] = [];
  const old = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return oldHandshake.promise;
    messages.push(args!);
    return true;
  }, oldClock);
  const starting = old.start();
  old.update(balance);
  old.stop();
  const current = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return 42;
    messages.push(args!);
    return true;
  }, newClock);
  current.update(cleared);
  await settle();
  oldHandshake.resolve(41);
  await starting;
  assert.deepEqual(messages, [{ session: 42, revision: 1, ...cleared }]);
  assert.equal(oldClock.pending.size, 0);
  assert.equal(newClock.pending.size, 0);
  current.update(staleBalance);
  await settle();
  assert.deepEqual(messages.at(-1), {
    session: 42,
    revision: 2,
    ...staleBalance,
  });
  current.stop();
});

test("R15-05: 旧会话发布迟到时仍带旧 epoch，不能覆盖重建后的清除值", async () => {
  const oldPublication = deferred<void>();
  let allocatedSession = 0;
  let nativeSession = 0;
  let nativeRevision = 0;
  let nativeTotal: unknown = "原账户余额";
  const messages: Record<string, unknown>[] = [];
  const transport = async (command: string, args?: Record<string, unknown>) => {
    if (command === "begin_tray_balance_session") return ++allocatedSession;
    messages.push(args!);
    if (args!.session === 1) await oldPublication.promise;
    const session = args!.session as number;
    const revision = args!.revision as number;
    if (session < nativeSession) return false;
    if (session === nativeSession && revision <= nativeRevision) return true;
    nativeSession = session;
    nativeRevision = revision;
    nativeTotal = args!.total;
    return true;
  };
  const oldClock = new RetryClock();
  const old = new TrayBalancePublisher(transport, oldClock);
  old.update(balance);
  await settle();
  old.stop();
  const newClock = new RetryClock();
  const current = new TrayBalancePublisher(transport, newClock);
  current.update(cleared);
  await settle();
  assert.equal(nativeSession, 2);
  assert.equal(nativeTotal, null);
  oldPublication.resolve();
  await settle();
  assert.equal(nativeTotal, null);
  assert.deepEqual(messages, [
    { session: 1, revision: 1, ...balance },
    { session: 2, revision: 1, ...cleared },
  ]);
  assert.equal(oldClock.pending.size, 0);
  assert.equal(newClock.pending.size, 0);
  current.stop();
});

test("R15-05: update 保存独立快照，调用方后续修改不能复活已清余额", async () => {
  const handshake = deferred<number>();
  const clock = new RetryClock();
  const messages: Record<string, unknown>[] = [];
  const publisher = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return handshake.promise;
    messages.push(args!);
    return true;
  }, clock);
  const snapshot: {
    total: string | null;
    currency: string | null;
    stale: boolean;
  } = {
    ...cleared,
  };
  publisher.update(snapshot);
  snapshot.total = "999";
  snapshot.currency = "CNY";
  snapshot.stale = true;
  handshake.resolve(14);
  await settle();
  assert.deepEqual(messages, [{ session: 14, revision: 1, ...cleared }]);
  publisher.stop();
});

test("R15-05: 旧 begin 命令本体迟到只预留 epoch，不抢占重建后的 owner", async () => {
  const enterOldBegin = deferred<void>();
  let allocatedSession = 0;
  let activeSession = 0;
  let nativeRevision = 0;
  let nativeTotal: unknown = "旧账户";
  const messages: Record<string, unknown>[] = [];
  const publish = (args: Record<string, unknown>) => {
    messages.push(args);
    const session = args.session as number;
    const revision = args.revision as number;
    if (session < activeSession) return false;
    if (session === activeSession && revision <= nativeRevision) return true;
    nativeTotal = args.total;
    activeSession = session;
    nativeRevision = revision;
    return true;
  };
  const oldClock = new RetryClock();
  const old = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") {
      await enterOldBegin.promise;
      return ++allocatedSession;
    }
    return publish(args!);
  }, oldClock);
  const starting = old.start();
  old.update(balance);
  old.stop(); // 对应 App effect：cleanup 完成后才创建下一实例。
  const newClock = new RetryClock();
  const current = new TrayBalancePublisher(async (command, args) => {
    if (command === "begin_tray_balance_session") return ++allocatedSession;
    return publish(args!);
  }, newClock);
  current.update(cleared);
  await settle();
  assert.equal(activeSession, 1);
  assert.equal(nativeTotal, null);
  enterOldBegin.resolve();
  await starting;
  assert.equal(
    allocatedSession,
    2,
    "旧 begin 最后入场得到更高但未激活的 epoch",
  );
  assert.equal(activeSession, 1);
  assert.equal(nativeTotal, null);
  assert.deepEqual(messages, [{ session: 1, revision: 1, ...cleared }]);
  current.update(staleBalance);
  await settle();
  assert.equal(nativeTotal, balance.total);
  assert.equal(activeSession, 1, "当前会话未因旧 begin 被撤销");
  assert.deepEqual(messages.at(-1), {
    session: 1,
    revision: 2,
    ...staleBalance,
  });
  assert.equal(oldClock.pending.size, 0);
  assert.equal(newClock.pending.size, 0);
  current.stop();
});

test("R15-05: 原生明确拒绝旧 epoch 时停止旧实例，不重新握手争夺 owner", async () => {
  const clock = new RetryClock();
  const publication = deferred<boolean>();
  const commands: string[] = [];
  const publisher = new TrayBalancePublisher(async (command) => {
    commands.push(command);
    if (command === "begin_tray_balance_session") return 15;
    return publication.promise;
  }, clock);
  publisher.update(balance);
  await settle();
  publisher.update(cleared);
  publication.resolve(false);
  await settle();
  publisher.update(staleBalance);
  await publisher.start();
  assert.deepEqual(commands, [
    "begin_tray_balance_session",
    "update_tray_balance",
  ]);
  assert.equal(clock.pending.size, 0);
});

test("R15-05: 非法发布确认不冒充成功，保留会话并重试最终值", async () => {
  for (const invalid of [undefined, null, "true", 0, {}, []]) {
    const clock = new RetryClock();
    let begins = 0;
    const messages: Record<string, unknown>[] = [];
    const publisher = new TrayBalancePublisher(async (command, args) => {
      if (command === "begin_tray_balance_session") {
        begins++;
        return 16;
      }
      messages.push(args!);
      return messages.length === 1 ? invalid : true;
    }, clock);
    publisher.update(balance);
    await settle();
    assert.equal(clock.nextRetry().delay, 1000);
    publisher.update(cleared);
    clock.fire();
    await settle();
    assert.deepEqual(messages, [
      { session: 16, revision: 1, ...balance },
      { session: 16, revision: 2, ...cleared },
    ]);
    assert.equal(begins, 1);
    assert.equal(clock.pending.size, 0);
    publisher.stop();
  }
});
