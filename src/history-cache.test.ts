// HistoryCache 的缓存契约测试（第五轮复评 N01）。
//
// N01 场景：某月成功 → TTL 内强刷失败 → 「只重试失败月份」。若重试不带
// force，缓存会在 5 分钟内直接返回旧成功值，不调用 loader，却把旧值当
// 本次成功清除失败标记 —— 表现为「假恢复」。这里锁定两条契约：
// 1. force 读取必须绕过 TTL 缓存与 pending 去重，真实发出请求；
// 2. 非强制读取在 TTL 内仍命中缓存（常规路径不受影响）。
//
// 运行方式：`npm test` → `node --test --experimental-strip-types src/`。

import { test } from "node:test";
import assert from "node:assert/strict";

import { HistoryCache } from "./history-cache.ts";
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

  // TTL 内强刷：真实请求但失败，只移除 pending，不清旧缓存。
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
