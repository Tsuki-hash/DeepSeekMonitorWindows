import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertAmounts,
  alertDraftAmounts,
  alertStateLabel,
} from "./alert-options.ts";
const saved = {
  enabled: true,
  lowBalanceEnabled: true,
  lowBalanceCny: 10,
  monthlyBudgetEnabled: false,
  monthlyBudgetCny: 100,
  quietHours: true,
};
test("关闭规则的无效草稿不阻止另一个规则保存，重新开启后仍严格验证", () => {
  assert.deepEqual(
    alertDraftAmounts(
      { ...saved, lowBalanceEnabled: false, monthlyBudgetEnabled: true },
      saved,
      "",
      "123.45",
    ),
    { lowBalanceCny: 10, monthlyBudgetCny: 123.45 },
  );
  assert.deepEqual(alertDraftAmounts(saved, saved, "0", ""), {
    lowBalanceCny: 0,
    monthlyBudgetCny: 100,
  });
  assert.deepEqual(
    alertDraftAmounts({ ...saved, enabled: false }, saved, "NaN", ""),
    { lowBalanceCny: 10, monthlyBudgetCny: 100 },
  );
  assert.throws(() => alertDraftAmounts(saved, saved, "", "100"));
  assert.throws(() =>
    alertDraftAmounts(
      { ...saved, monthlyBudgetEnabled: true },
      saved,
      "10",
      "0",
    ),
  );
});
test("提醒金额保留零余额线和小数，空值/非有限/越界不悄悄保存", () => {
  assert.deepEqual(alertAmounts("0", "123.45"), {
    lowBalanceCny: 0,
    monthlyBudgetCny: 123.45,
  });
  for (const low of ["", " ", "NaN", "Infinity", "-1", "1000000001"])
    assert.throws(() => alertAmounts(low, "100"));
  for (const budget of ["", "0", "-1", "Infinity", "1000000001"])
    assert.throws(() => alertAmounts("10", budget));
});
test("提醒状态按独立凭据解释，无效或未知不能冒充检查成功", () => {
  assert.ok(alertStateLabel("missing", "balance").includes("API Key"));
  assert.ok(alertStateLabel("missing", "budget").includes("Token"));
  assert.ok(
    alertStateLabel("credentials_invalid", "budget").includes("重新同步"),
  );
  assert.ok(alertStateLabel("invalid_data", "budget").includes("不发送"));
  assert.equal(
    alertStateLabel("future-unknown", "balance"),
    "暂未取得有效数据",
  );
});
