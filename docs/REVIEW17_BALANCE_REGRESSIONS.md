# 第十七轮余额值域回归说明

**状态：仅修改源码及回归文本，未编译、未运行任何项目测试、未启动应用或访问真实 DeepSeek 接口。以下项目均待维护者在最终候选源码的 Windows 工作区执行，不构成运行通过记录。**

## 入口与有效语义

- `fetch_balance_with_key` 仍是首页刷新、API Key 保存验证、后台余额提醒共用的请求入口；读取有界 HTTP 响应后，统一调用 `parse_balance_json`。
- JSON 结构错误、空余额列表、选中余额的未知币种或无效金额统一返回 `InvalidData`。选中的首行 `total_balance`、`granted_balance`、`topped_up_balance` 都必须是可用的金额字符串，不补缺失值或用零兜底。
- 金额拒绝空白、非数字、NaN/Infinity、浮点溢出、超出显示范围及非零值下溢成零。金额不做非负限制，保留明确零、欠费负数、科学计数法与原始精度字符串；不擅自校正分项，也不新增分项加总相等的约束。
- 保留既有首条余额语义，不跳过无效首行去选择后续其他币种。当前支持 CNY、USD；未知币种不默认当作人民币。`is_available=false` 可表示余额不足，不把它当作凭据失效。
- 金额共同防御范围为绝对值不超过 `1e15`，沿用托盘已有显示上界。此值是应用显示边界，不是 DeepSeek 余额业务上限或账户额度保证。
- 提醒原先单独采用 `1e12`，现在复用共同范围。人民币提醒阈值配置范围为 `0..=1e9`；新接纳的绝对余额区间大于 `1e12`，其正值必然高于阈值、负值必然低于阈值，不增加阈值附近的浮点比较风险。原有 f64 比较和两位小数显示舍入仍存在，本轮没有实现精确十进制财务计算。
- USD 是合法余额，但人民币提醒仍为 `unsupported`，不直接将美元与人民币阈值比较。未知币种、无效 USD 金额则属于 `invalid_data`。

## 失败关闭与最后可信数据

- 来源层在创建 `BalanceResult` 前失败，首页不会对该响应执行成功更新，也不会推进最后成功时间。现有 App 失败路径保留旧可信金额并显示更新失败；托盘将该旧金额标为旧数据。首次失败没有可信快照时不能出现零余额或“最近成功”。
- API Key 保存的现有验证失败分支保留原 Key 与配置，不将数据错误当作凭据失效。新增 Windows 回归使用真实命令 helper 和隔离配置目录，断言文件字节、Key、用量 Token 及三个版本号均不变。
- 后台提醒的错误分支不会进入阈值判断或触发通知。托盘的余额字符串入口与提醒复用相同金额/币种校验，避免成功展示后才发生口径分歧。

## 新增后端回归文本

`src-tauri/src/deepseek_api.rs` 共 6 条：

1. `r17_balance_rejects_invalid_totals_at_the_production_json_boundary`：空白、非数字、非有限、溢出、上下越界、下溢伪零及稳定错误分类。
2. `r17_balance_keeps_zero_debt_supported_currencies_and_original_precision`：CNY/USD、明确零、负余额、科学计数法、显示边界、可用/不可用状态及原始金额字符串。
3. `r17_balance_unknown_or_missing_currency_is_not_assumed_cny`：未知、缺失、空白及错误类型的币种。
4. `r17_balance_all_amount_fields_require_explicit_valid_strings`：三个金额字段的缺失、null、数字类型及异常字符串。
5. `r17_balance_does_not_replace_a_bad_first_row_with_another_currency`：保留首行选择，坏首行不能被后续合法行掩盖。
6. `r17_balance_invalid_structure_uses_the_same_invalid_data_classification`：坏 JSON、空/错误结构与 `is_available` 类型错误。

`src-tauri/src/alerts.rs` 共 2 条：

- `r17_balance_parser_failure_never_enters_notification_evaluation`：真实 JSON 解析入口失败后，提醒评估闭包不得执行。
- `r17_balance_valid_values_keep_cny_threshold_and_usd_unsupported_semantics`：零/欠费、等号边界、非触发金额、大额正负余额和 USD 提醒限制。

`src-tauri/src/commands.rs` 共 1 条：

- `r17_invalid_balance_response_preserves_the_saved_key_and_revisions`：Windows 命令验证链失败时不改原凭据、密文文件及配置版本。

另见托盘入口与真实 App 组件的配套回归文本；上述 9 条不是本轮所有新增测试的总数，也不代替完整项目门禁。

## 待执行使用验收

1. 先成功取得可信余额，再依次提供空白、NaN/Infinity、超界金额或未知币种的合成响应：首页保留原金额与成功时间，显示更新失败；托盘保留原值并标旧；提醒显示数据异常且不通知。恢复有效响应后再更新金额和成功时间。
2. 首次查询即异常：不显示伪零、不发布“最近成功”；用异常响应验证新 Key 时，原 Key、旧账户状态和配置版本保持不变。
3. 明确零、合理负余额、CNY/USD、`is_available=false` 均不因本轮校验被误报为坏数据；CNY 零/欠费按提醒阈值评估，USD 不触发人民币提醒。
4. 在最终候选源码执行项目完整发布门禁、Windows 后端及组件测试，再做托盘和系统通知验收。不得将本说明、静态阅读或仅运行筛选回归用例记作发布通过。
