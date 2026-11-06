import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptLeave, resolveLeave, LeaveDecisions } from "./leave-guard.ts";
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
