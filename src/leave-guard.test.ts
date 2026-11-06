import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptLeave,
  resolveLeave,
  LeaveDecisions,
  LeaveDecisionRunner,
} from "./leave-guard.ts";
import type { LeaveBlocker } from "./leave-guard.ts";

const make = (over: Partial<LeaveBlocker> = {}): LeaveBlocker => ({
  dirty: true,
  subject: "采集目录",
  save: async () => true,
  discard: () => undefined,
  ...over,
});

test("无草稿时直接离开_不打扰用户", () => {
  let left = false;
  const outcome = attemptLeave(make({ dirty: false }), () => {
    left = true;
  });
  assert.equal(outcome, "done");
  assert.equal(left, true);
});

test("有草稿时必须拦截_主导航不能绕过", () => {
  let left = false;
  const outcome = attemptLeave(make(), () => {
    left = true;
  });
  assert.equal(outcome, "blocked");
  assert.equal(left, false, "拦截生效前不得离开");
});

test("保存并离开_先保存再执行离开动作", async () => {
  let saved = false;
  let left = false;
  const blocker = make({
    save: async () => {
      saved = true;
      return true;
    },
  });
  const ok = await resolveLeave(blocker, "save", () => {
    left = true;
  });
  assert.equal(saved, true);
  assert.equal(left, true);
  assert.equal(ok, true);
});

test("保存失败不离开_草稿保留", async () => {
  let left = false;
  const blocker = make({ save: async () => false });
  const ok = await resolveLeave(blocker, "save", () => {
    left = true;
  });
  assert.equal(left, false, "保存失败必须留在当前页");
  assert.equal(ok, false);
});

test("放弃修改才离开_取消不离开", async () => {
  let discarded = false;
  let left = false;
  const blocker = make({
    discard: () => {
      discarded = true;
    },
  });
  assert.equal(
    await resolveLeave(blocker, "discard", () => {
      left = true;
    }),
    true,
  );
  assert.equal(discarded, true);
  assert.equal(left, true);

  let leftAgain = false;
  assert.equal(
    await resolveLeave(blocker, "cancel", () => {
      leftAgain = true;
    }),
    false,
  );
  assert.equal(leftAgain, false);
});

test("没有注册拦截器时正常离开", async () => {
  let left = false;
  assert.equal(
    await resolveLeave(null, "save", () => {
      left = true;
    }),
    true,
  );
  assert.equal(left, true);
});

// ---------- R08：保存中取消与连点 ----------

test("保存期间取消_迟到的保存成功不得导航", async () => {
  const decisions = new LeaveDecisions();
  const ticket = decisions.begin();
  let resolveSave: (value: boolean) => void = () => undefined;
  let left = false;
  const blocker = make({
    save: () => new Promise<boolean>((done) => (resolveSave = done)),
  });
  const pending = resolveLeave(
    blocker,
    "save",
    () => {
      left = true;
    },
    () => decisions.isCurrent(ticket),
  );
  // 用户在保存途中点取消。
  decisions.cancel(ticket);
  resolveSave(true);
  assert.equal(await pending, false, "取消后即使保存成功也不能离开");
  assert.equal(left, false);
});

test("连点只认最新一次决策_旧令牌失效", () => {
  const decisions = new LeaveDecisions();
  const first = decisions.begin();
  const second = decisions.begin();
  assert.equal(decisions.isCurrent(first), false, "旧决策必须失效");
  assert.equal(decisions.isCurrent(second), true);
});

test("取消后重新开始_新决策有效", () => {
  const decisions = new LeaveDecisions();
  const first = decisions.begin();
  decisions.cancel(first);
  assert.equal(decisions.isCurrent(first), false);
  const second = decisions.begin();
  assert.equal(decisions.isCurrent(second), true);
});

test("保存成功且未被取消_正常离开并结束决策", async () => {
  const decisions = new LeaveDecisions();
  const ticket = decisions.begin();
  let left = false;
  const ok = await resolveLeave(
    make(),
    "save",
    () => {
      left = true;
    },
    () => decisions.isCurrent(ticket),
  );
  assert.equal(ok, true);
  assert.equal(left, true);
  decisions.finish(ticket);
  assert.equal(decisions.isCurrent(ticket), false);
});

// ---------- 第五轮复评 Q04：决策所有权运行器 ----------

/** 等待微任务与完成回调链落定。 */
const tick = () => new Promise<void>((done) => setTimeout(done, 0));

/** 构造带记录的运行器：submit 记录、意图清除次数、导航去向。 */
const harness = (blocker: LeaveBlocker) => {
  const submits: boolean[] = [];
  let clears = 0;
  const runner = new LeaveDecisionRunner(
    () => blocker,
    (value) => submits.push(value),
    () => {
      clears += 1;
    },
  );
  return { runner, submits, clears: () => clears };
};

test("Q04：保存途中新意图取代旧决策_旧成功不执行旧导航且最新意图直接执行", async () => {
  let resolveSave: (value: boolean) => void = () => undefined;
  const blocker = make({
    save: () => new Promise<boolean>((done) => (resolveSave = done)),
  });
  const { runner, submits, clears } = harness(blocker);
  let navigated: string | null = null;
  runner.requestIntent(() => (navigated = "A"));
  runner.decide("save");
  assert.deepEqual(submits, [true]);

  // 保存途中用户改变主意：请求导航 B（立即取得所有权）。
  runner.requestIntent(() => (navigated = "B"));
  resolveSave(true); // A 的保存迟到成功
  await tick();

  assert.equal(navigated, "B", "最终意图 B 执行，旧意图 A 不得导航");
  assert.deepEqual(submits, [true, false], "submitting 最终解除");
  assert.equal(clears(), 1, "提示随导航清除");
});

test("Q04：被取代的保存失败_最新意图保留待用户决定", async () => {
  let resolveSave: (value: boolean) => void = () => undefined;
  let saveCalls = 0;
  const blocker = make({
    save: () => {
      saveCalls += 1;
      // 第一次（被取代的那次）由测试控制结果；之后的重试直接成功。
      return saveCalls === 1
        ? new Promise<boolean>((done) => (resolveSave = done))
        : Promise.resolve(true);
    },
  });
  const { runner } = harness(blocker);
  let navigated: string | null = null;
  runner.requestIntent(() => (navigated = "A"));
  runner.decide("save");
  runner.requestIntent(() => (navigated = "B"));
  resolveSave(false); // A 的保存失败迟到
  await tick();

  assert.equal(navigated, null, "保存失败不得执行任何导航");
  // 最新意图 B 仍在待决：用户再次决策（默认 save 成功）即可执行。
  runner.decide("save");
  await tick();
  assert.equal(navigated, "B", "保留的最新意图仍可执行");
});

test("Q04：取消后新决策进行中_旧决策迟到完成不解除新提交状态", async () => {
  const resolvers: Array<(value: boolean) => void> = [];
  const blocker = make({
    save: () =>
      new Promise<boolean>((done) => {
        resolvers.push(done);
      }),
  });
  const { runner, submits, clears } = harness(blocker);
  let navigated: string | null = null;
  runner.requestIntent(() => (navigated = "A"));
  runner.decide("save"); // 保存 A 在途
  runner.cancel(); // 用户取消
  assert.deepEqual(submits, [true, false]);
  assert.equal(clears(), 1);
  runner.requestIntent(() => (navigated = "B"));
  runner.decide("save"); // 保存 B 在途
  assert.deepEqual(submits, [true, false, true]);

  resolvers[0](true); // A 迟到成功
  await tick();
  assert.equal(navigated, null, "旧决策不得导航");
  assert.deepEqual(submits, [true, false, true], "B 的提交状态不被旧完成解除");

  resolvers[1](true); // B 成功
  await tick();
  assert.equal(navigated, "B");
  assert.deepEqual(submits, [true, false, true, false]);
  assert.equal(clears(), 2);
});

test("Q04：提交中连点只认第一次决策", async () => {
  let resolveSave: (value: boolean) => void = () => undefined;
  let saveCalls = 0;
  const blocker = make({
    save: () => {
      saveCalls += 1;
      return new Promise<boolean>((done) => (resolveSave = done));
    },
  });
  const { runner, submits } = harness(blocker);
  let navigations = 0;
  runner.requestIntent(() => (navigations += 1));
  runner.decide("save");
  runner.decide("save"); // 提交中连点：忽略
  runner.decide("discard"); // 换决策也忽略
  resolveSave(true);
  await tick();
  assert.equal(saveCalls, 1, "只发起一次保存");
  assert.equal(navigations, 1, "只执行一次导航");
  assert.deepEqual(submits, [true, false]);
});

test("Q04：无待决意图时 decide 忽略_取消幂等", () => {
  const { runner, submits, clears } = harness(make());
  runner.decide("save"); // 无意图：忽略
  runner.cancel(); // 无在途决策与意图：幂等，不发状态
  runner.cancel();
  assert.deepEqual(submits, []);
  assert.equal(clears(), 0);
});
