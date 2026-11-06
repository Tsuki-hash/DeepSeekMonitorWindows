// HistoryCache 的缓存契约测试（第五轮复评 N01）。
//
// N01 场景：某月成功 → TTL 内强刷失败 → 「只重试失败月份」。若重试不带
// force，缓存会在 5 分钟内直接返回旧成功值，不调用 loader，却把旧值当
// 本次成功清除失败标记 —— 表现为「假恢复」。这里锁定缓存契约：
// 1. force 读取必须绕过 TTL 缓存与 pending 去重，真实发出请求；
// 2. 健康的非强制读取在 TTL 内仍命中缓存（常规路径不受影响）；
// 3. 第 29 轮：后续失败覆盖成功的可信状态，重挂/切范围不能消除失败。
//
// 运行方式：`npm test` → `node --test --experimental-strip-types src/`。

import { test } from "node:test";
import assert from "node:assert/strict";

import { HistoryCache, HistoryCacheFailure } from "./history-cache.ts";
import { classifyHistoryFailure } from "./history-failure.ts";
import type { UsageResult } from "./types";

const usageWithCost = (monthCost: number): UsageResult => ({
  models: [],
  days: [],
  monthCost,
});

test("history-cache：成功→强刷失败→失败月份重试必须产生真实请求", async () => {
  const cache = new HistoryCache();
  let clock = 1_000_000;
  const now = () => clock;
  let calls = 0;
  const loader = () => {
    calls += 1;
    // 第 2 次调用模拟「重新查询历史」强刷失败；其余成功且值可区分。
    return calls === 2
      ? Promise.reject(new Error("service_unavailable"))
      : Promise.resolve(usageWithCost(calls));
  };

  const first = await cache.get("2026-10", loader, false, now);
  assert.equal(calls, 1);
  assert.equal(first.usage.monthCost, 1);

  // TTL 内强刷：真实请求失败，保留旧 payload 但记下失败状态。
  clock = 1_010_000;
  await assert.rejects(() => cache.get("2026-10", loader, true, now));
  assert.equal(calls, 2);

  // 失败月份重试（N01 修复后按钮传 force=true）：必须第 3 次真实请求，
  // 返回新值并更新 fetchedAt —— 不得把旧缓存当本次成功。
  clock = 1_020_000;
  const retried = await cache.get("2026-10", loader, true, now);
  assert.equal(calls, 3, "重试必须绕过 TTL 缓存真实请求");
  assert.equal(retried.usage.monthCost, 3);
  assert.equal(retried.fetchedAt, 1_020_000);
});

test("history-cache：TTL 内非强制读取仍命中缓存", async () => {
  const cache = new HistoryCache();
  let clock = 1_000_000;
  const now = () => clock;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return Promise.resolve(usageWithCost(1));
  };

  const first = await cache.get("2026-10", loader, false, now);
  clock = 1_020_000;
  const again = await cache.get("2026-10", loader, false, now);
  assert.equal(calls, 1, "TTL 内常规读取不应重复请求");
  assert.equal(again, first, "命中缓存时返回同一对象");

  // TTL 过期后恢复真实请求（fetchedAt=1_000_000，TTL 300 秒）。
  clock = 1_310_000;
  await cache.get("2026-10", loader, false, now);
  assert.equal(calls, 2);
});

test("history-cache：force 读取不被同名 pending 去重吞掉", async () => {
  const cache = new HistoryCache();
  const now = () => 1_000_000;
  let release: (value: UsageResult) => void = () => {};
  const firstGate = new Promise<UsageResult>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const loader = () => {
    calls += 1;
    return calls === 1 ? firstGate : Promise.resolve(usageWithCost(2));
  };

  const inFlight = cache.get("2026-10", loader, false, now);
  const deduped = cache.get("2026-10", loader, false, now);
  const value = usageWithCost(1);
  release(value);
  const [a, b] = await Promise.all([inFlight, deduped]);
  assert.equal(calls, 1, "常规读取被 pending 去重：只调用一次 loader");
  assert.equal(a.usage, value);
  assert.equal(b.usage, value);

  // force：即使同名月份仍有 pending 记录，也必须另起真实请求。
  const forced = await cache.get("2026-10", loader, true, now);
  assert.equal(calls, 2, "force 读取绕过 pending 去重");
  assert.equal(forced.usage.monthCost, 2);
});

// Round 29: tests use the production cache, with no platform/network requests.
const deferredUsage = () => {
  let resolve!: (value: UsageResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UsageResult>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};
const cachedFailure = async (task: Promise<unknown>) => {
  try {
    await task;
  } catch (failure) {
    assert.ok(failure instanceof HistoryCacheFailure);
    return failure;
  }
  throw new Error(
    "Expected an explicit cached failure, not a successful payload",
  );
};

for (const code of [
  "not_configured",
  "credentials_invalid",
  "rate_limited",
  "unavailable",
  "invalid_data",
  "unknown",
]) {
  test(`R29 history-cache: warm ${code} failure preserves data and classification until a real success`, async () => {
    const cache = new HistoryCache();
    const now = () => 1_000_000;
    const accountingDate = () => "2026-10-20";
    let calls = 0;
    const success = () => {
      calls++;
      return Promise.resolve(usageWithCost(calls));
    };
    const first = await cache.get(
      "2026-10",
      success,
      false,
      now,
      accountingDate,
    );
    const original = { code, message: `synthetic ${code}` };
    const failed = await cachedFailure(
      cache.get(
        "2026-10",
        async () => {
          calls++;
          throw original;
        },
        true,
        now,
        accountingDate,
      ),
    );
    assert.equal(failed.epoch, cache.epoch());
    assert.equal(failed.month, "2026-10");
    assert.equal(
      failed.classified.kind,
      classifyHistoryFailure(original, "2026-10").kind,
    );
    assert.notEqual(failed.classified.message, original.message);
    assert.equal(failed.lastSuccess, first);
    for (let read = 0; read < 3; read++) {
      const replay = await cachedFailure(
        cache.get("2026-10", success, false, now, accountingDate),
      );
      assert.deepEqual(replay.classified, failed.classified);
      assert.equal(replay.lastSuccess, first);
      assert.equal(replay.hadSuccess, true);
    }
    assert.equal(calls, 2);
    const recovered = await cache.get(
      "2026-10",
      success,
      true,
      now,
      accountingDate,
    );
    assert.equal(calls, 3);
    assert.equal(recovered.usage.monthCost, 3);
    assert.equal(
      await cache.get("2026-10", success, false, now, accountingDate),
      recovered,
    );
    assert.equal(
      calls,
      3,
      "healthy TTL hits remain available after real recovery",
    );
  });
}

test("R29 history-cache: payload eviction is bounded but TTL never erases failure evidence", async () => {
  const cache = new HistoryCache();
  let clock = 1_000_000;
  const now = () => clock;
  const date = () => "2026-10-20";
  await cache.get("2026-10", async () => usageWithCost(10), false, now, date);
  const firstError = { code: "invalid_data" };
  await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        throw firstError;
      },
      true,
      now,
      date,
    ),
  );
  for (const month of ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05"])
    await cache.get(month, async () => usageWithCost(1), false, now, date);
  let calls = 0;
  const again = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        calls++;
        return usageWithCost(20);
      },
      false,
      now,
      date,
    ),
  );
  assert.equal(calls, 0);
  assert.equal(
    again.lastSuccess,
    undefined,
    "evicted payloads are not pinned by failure metadata",
  );
  assert.equal(again.hadSuccess, true);
  assert.equal(
    again.classified.kind,
    classifyHistoryFailure(firstError, "2026-10").kind,
  );
  clock += 300_001;
  const nextError = { code: "rate_limited" };
  const expired = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        calls++;
        throw nextError;
      },
      false,
      now,
      date,
    ),
  );
  assert.equal(
    calls,
    1,
    "expiry permits a real request, rather than silently clearing failure",
  );
  assert.equal(
    expired.classified.kind,
    classifyHistoryFailure(nextError, "2026-10").kind,
  );
  assert.equal(expired.lastSuccess, undefined);
  const recovered = await cache.get(
    "2026-10",
    async () => {
      calls++;
      return usageWithCost(30);
    },
    true,
    now,
    date,
  );
  assert.equal(calls, 2);
  assert.equal(recovered.usage.monthCost, 30);
});

test("R29 history-cache: eviction before a failed refresh still records that the old success is unavailable", async () => {
  const cache = new HistoryCache();
  const now = () => 1_000_000;
  const date = () => "2026-10-20";
  for (const month of ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06"])
    await cache.get(month, async () => usageWithCost(1), false, now, date);
  const failure = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        throw { code: "invalid_data" };
      },
      true,
      now,
      date,
    ),
  );
  assert.equal(failure.hadSuccess, true);
  assert.equal(failure.lastSuccess, undefined);
  let calls = 0;
  const replay = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        calls++;
        return usageWithCost(99);
      },
      false,
      now,
      date,
    ),
  );
  assert.equal(replay.lastSuccess, undefined);
  assert.deepEqual(replay.classified, failure.classified);
  assert.equal(
    calls,
    0,
    "eviction cannot silently turn a failed month into success",
  );
});

test("R29 history-cache: accounting-day rollover requires real recovery and keeps the old source date on failure", async () => {
  const cache = new HistoryCache();
  const now = () => 1_000_000;
  let day = "2026-10-20";
  const date = () => day;
  const first = await cache.get(
    "2026-10",
    async () => usageWithCost(10),
    false,
    now,
    date,
  );
  await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        throw { code: "unavailable" };
      },
      true,
      now,
      date,
    ),
  );
  day = "2026-10-21";
  let calls = 0;
  const nextDay = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        calls++;
        throw { code: "invalid_data" };
      },
      false,
      now,
      date,
    ),
  );
  assert.equal(calls, 1);
  assert.equal(nextDay.lastSuccess, first);
  assert.equal(nextDay.lastSuccess?.sourceAsOfDate, "2026-10-20");
  const recovered = await cache.get(
    "2026-10",
    async () => usageWithCost(20),
    true,
    now,
    date,
  );
  assert.equal(recovered.sourceAsOfDate, "2026-10-21");
});

for (const newest of ["success", "failure"] as const) {
  for (const older of ["success", "failure"] as const) {
    test(`R29 history-cache: older ${older} follows newer ${newest} without rewriting it`, async () => {
      const cache = new HistoryCache();
      const now = () => 1_000_000;
      const date = () => "2026-10-20";
      const first = await cache.get(
        "2026-10",
        async () => usageWithCost(1),
        false,
        now,
        date,
      );
      const oldGate = deferredUsage();
      const newGate = deferredUsage();
      const oldRequest = cache.get(
        "2026-10",
        () => oldGate.promise,
        true,
        now,
        date,
      );
      const newRequest = cache.get(
        "2026-10",
        () => newGate.promise,
        true,
        now,
        date,
      );
      // Attach rejection handling before releasing either deferred response.
      const oldOutcome = oldRequest.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const newOutcome = newRequest.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const newError = { code: "rate_limited", message: "newest failure" };
      if (newest === "success") newGate.resolve(usageWithCost(20));
      else newGate.reject(newError);
      const authoritative = await newOutcome;
      if (older === "success") oldGate.resolve(usageWithCost(5));
      else
        oldGate.reject({
          code: "credentials_invalid",
          message: "obsolete failure",
        });
      assert.deepEqual(await oldOutcome, authoritative);
      let loaderCalls = 0;
      const read = cache.get(
        "2026-10",
        async () => {
          loaderCalls++;
          return usageWithCost(99);
        },
        false,
        now,
        date,
      );
      if (newest === "success") {
        assert.equal((await read).usage.monthCost, 20);
      } else {
        const error = await cachedFailure(read);
        assert.equal(
          error.classified.kind,
          classifyHistoryFailure(newError, "2026-10").kind,
        );
        assert.equal(error.lastSuccess, first);
      }
      assert.equal(loaderCalls, 0);
    });
  }
}

test("R29 history-cache: three overlapping forced requests and a normal consumer follow the latest attempt", async () => {
  const cache = new HistoryCache();
  const first = deferredUsage();
  const second = deferredUsage();
  const third = deferredUsage();
  const a = cache.get("2026-10", () => first.promise, true);
  const b = cache.get("2026-10", () => second.promise, true);
  const c = cache.get("2026-10", () => third.promise, true);
  let extraCalls = 0;
  const adopted = cache.get("2026-10", async () => {
    extraCalls++;
    return usageWithCost(99);
  });
  first.reject(new Error("old failure"));
  second.resolve(usageWithCost(2));
  third.resolve(usageWithCost(3));
  const values = await Promise.all([a, b, c, adopted]);
  assert.ok(values.every((value) => value === values[0]));
  assert.equal(values[0].usage.monthCost, 3);
  assert.equal(extraCalls, 0);
});

for (const middle of ["success", "failure"] as const) {
  for (const late of ["success", "failure"] as const) {
    test(`R29 history-cache: a settled middle ${middle} cannot mask the newest outcome when the oldest ${late} arrives`, async () => {
      const cache = new HistoryCache();
      const now = () => 1_000_000;
      const date = () => "2026-10-20";
      await cache.get(
        "2026-10",
        async () => usageWithCost(1),
        false,
        now,
        date,
      );
      const oldest = deferredUsage();
      const a = cache.get("2026-10", () => oldest.promise, true, now, date);
      const aOutcome = a.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const b = cache.get(
        "2026-10",
        async () => {
          if (middle === "failure") throw { code: "credentials_invalid" };
          return usageWithCost(2);
        },
        true,
        now,
        date,
      );
      await b.then(
        () => {},
        () => {},
      );
      // B has already left pending; A is still unresolved when C starts.
      const latestError = { code: "rate_limited" };
      const c = cache.get(
        "2026-10",
        async () => {
          if (middle === "success") throw latestError;
          return usageWithCost(3);
        },
        true,
        now,
        date,
      );
      const expected = await c.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (late === "success") oldest.resolve(usageWithCost(99));
      else oldest.reject(new Error("obsolete error"));
      assert.deepEqual(await aOutcome, expected);
      const read = cache.get(
        "2026-10",
        async () => usageWithCost(100),
        false,
        now,
        date,
      );
      if (middle === "success") {
        const failure = await cachedFailure(read);
        assert.equal(
          failure.classified.kind,
          classifyHistoryFailure(latestError, "2026-10").kind,
        );
        assert.equal(failure.lastSuccess?.usage.monthCost, 2);
      } else {
        assert.equal((await read).usage.monthCost, 3);
      }
    });
  }
}

for (const late of ["success", "failure"] as const) {
  test(`R29 history-cache: credential changes discard stored failures and late ${late}`, async () => {
    const cache = new HistoryCache();
    await cache.get("2026-10", async () => usageWithCost(1));
    await cachedFailure(
      cache.get(
        "2026-10",
        async () => {
          throw { code: "credentials_invalid" };
        },
        true,
      ),
    );
    const gate = deferredUsage();
    const pending = cache.get("2026-10", () => gate.promise, true);
    const rejected = assert.rejects(() => pending);
    await Promise.resolve();
    cache.invalidate();
    const current = await cache.get("2026-10", async () => usageWithCost(2));
    if (late === "success") gate.resolve(usageWithCost(9));
    else gate.reject({ code: "invalid_data" });
    await rejected;
    assert.equal(
      await cache.get("2026-10", async () => usageWithCost(99)),
      current,
    );
  });
}

test("R29 history-cache: an epoch change before the loader microtask prevents old-session work", async () => {
  const cache = new HistoryCache();
  let calls = 0;
  const pending = cache.get("2026-10", async () => {
    calls++;
    return usageWithCost(1);
  });
  cache.invalidate();
  await assert.rejects(() => pending);
  assert.equal(calls, 0);
});

test("R29 history-cache: failure metadata keeps classification but no raw error text or attached payload", async () => {
  const cache = new HistoryCache();
  await cache.get("2026-10", async () => usageWithCost(1));
  const original = {
    code: "unknown",
    message: `synthetic-secret-request-body:${"x".repeat(4096)}请重新登录，用量 Token 已失效`,
    payload: { days: Array(100).fill({ rawModels: [usageWithCost(999)] }) },
  };
  const failure = await cachedFailure(
    cache.get(
      "2026-10",
      async () => {
        throw original;
      },
      true,
    ),
  );
  assert.equal(failure.classified.kind, "auth");
  assert.equal(failure.classified.message, "用量凭据需要配置或重新同步。");
  assert.equal(
    JSON.stringify(failure.classified).includes("synthetic-secret"),
    false,
  );
  assert.deepEqual(Object.keys(failure.classified).sort(), [
    "kind",
    "message",
    "month",
  ]);
  assert.equal("original" in failure, false);
  assert.equal("payload" in failure, false);
  const replay = await cachedFailure(
    cache.get("2026-10", async () => usageWithCost(2)),
  );
  assert.deepEqual(replay.classified, failure.classified);
  assert.equal("payload" in replay.classified, false);
});
