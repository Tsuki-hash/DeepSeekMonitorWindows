# 第 29 轮：异常日期独立保留，不进入正常历史合计

**本轮仅修改源码和回归文本并做静态核对。未运行构建、测试、脚本或应用，未执行 Windows 验收，以下均不是通过记录。编译及实际测试由维护者在 Windows 本机完成。**

## 问题与修复边界

生产 Rust 响应已经会对无效日期发出警告，但仍保留原始日记录。此前历史层只检查年月前缀和字符串范围；查询完整 2026-10 时，`2026-10-1` 或 `2026-10-03x` 可以进入正常 rows、月合计和 CSV returned。每日趋势却只枚举规范日期，因此与顶部及月柱不一致，31 个合法日再加异常行甚至会导出 `coveredDates=32`。

`src/history.ts` 现在先严格验证十位 `YYYY-MM-DD` 和实际公历日期，再验证归属所查询月份，之后才做所选窗口、请求源日、响应记账日和 unavailable 过滤：

- 短日期、后缀字符、尾换行/空白、无效月份、日 00/32、平年 2 月 29 日及短月 31 日均不能成为正常记录。不用 Date 的自动进位来“修正”原始日期。
- 合法闰日、合法真实 0、原有缺失值和正常同日去重保持原口径。窗口枚举同样拒绝非法端点，不能悄悄把非法区间归一化。
- `HistorySnapshot.excludedDays` 单独保留原始日期、查询月、排除原因、源日、响应记账日、抓取时刻、unavailable 状态、原始模型及来源警告。先留证据再做窗口/源日过滤，不能因为异常字符串早于/晚于边界、出现在 unavailableDates 或已有同名规范日期就丢掉证据。
- 正常 rows、coverage、顶部/模型/月趋势、日趋势、CSV returned、JSON daily/monthly 继续共享合法返回日口径。真正没有返回的规范日期仍留在 missingDates；异常日期不会冒充真实日期填补缺日，也不会加入缺日枚举。只剩异常行时合计仍未知，不造 0。
- `sourceAsOfDate` 和 `usage.accountingDate` 的既有上界都保留。晚于任一有效源日的规范零占位行仍不能晋升成真实返回日。旧响应未记录源日时仍沿用原有兼容行为。
- 账户 epoch、缓存隔离、查询批次合并与 legacy schema 判定未改。异常证据只从当前快照来源生成，切换窗口时随现有来源月份一起保留或移除，不建立跨账户存储。

面板另在覆盖信息后显示异常条数、原始日期、查询月和排除说明，标明异常不参与合计、导出保留证据。即使旧响应没有后端 warnings，也有前端明确异常提示。原始后端警告仍保留。

## 导出契约

- JSON 的 `daily` 和 `monthly.models` 只含合法返回日；`monthly.coveredDates` 只计规范唯一日期。`monthly.excludedDateRecordCount` 是该查询月来源中的异常记录数，不能当作缺失天数或已返回天数。
- 新增独立的 `excludedDateRecords`。每条带 `status=excluded-invalid-date` 或 `excluded-outside-query-month`、`includedInTotals=false`、原始日期/查询月、原因、时间及源日、unavailable、warnings 和白名单 models。异常 900 仍在 models 中供核对，不变成正常数量，也不改成 0。
- `sourceMonthlySnapshots` 继续保留明确标记为完整原始月来源的汇总，并补保留来源 warnings。它可能包含平台异常贡献，因此不能与 selected-window monthly 混用。
- CSV 原有前 15 列及 returned/not-returned 状态不变，末尾追加 `source_month`、`source_as_of_date`、`source_accounting_date`、`date_issue`、`warnings`、`excluded_models`。异常记录采用独立 excluded 状态，原有七个数值列全部留空；原值在 JSON 编码的 `excluded_models` 证据列，不会污染普通数值列求和。原始日期仍经过 CSV 公式防护及引号转义。
- JSON 模型白名单明确保留 `dataWarning`，不展开任意原始对象。新增异常路径同样不导出附加 token 等凭据字段。

## 新增回归文本（待执行）

`src/history.test.ts`：

1. 规范格式、实际闰年规则（2000 可闰、2100 不闰）、月末、尾换行/空白和非法区间端点。
2. 分别构造完整 31 日 × 10 Tokens，加 `2026-10-1=900` 或 `2026-10-03x=900` 的生产形状响应，包含完整 UsageDay 字段、rawModels 和后端警告。与实际 Rust 输出一样，不提供前端可选的 accountingDate / unavailableDates，也不预先把异常 day 标成 unavailable；由历史缓存来源提供 sourceAsOfDate。正常 rows/daily/CSV returned 都为 31 条，coveredDates=31，顶部/月度/daily 图表基础值和 JSON monthly 都为 310；原始平台月值 1210 与异常 900 分开保留。
3. 原始日期、源日、响应记账日、来源警告及模型 dataWarning 在 JSON/CSV 异常区中保留。正常 CSV 数字列直接求和仍为 310；加到源模型的 token 属性不得泄漏。输入源对象不被修改。
4. 没有 10-01 规范行、只有 `10-1`，加真实缺失列表、`sourceAsOfDate=10-04`、响应 `accountingDate=10-03`、规范未来零、前后错月及窗口外异常：只 10-03 为正常返回，10-01/02/04/05 仍未知；六条异常证据完整。即使没有后端 warnings，排除原因仍明确。窗口推进不能晋升旧零占位，也不能丢失异常证据。
5. 2024-02-29 合法，2024-02-30 / 2026-02-29 / 2026-04-31 排除但保留。仅有异常日时 rows/models 为空、覆盖 0、合计 null，31 个真实日期均保持未返回。
6. 合法真实 0、day.unavailable、空/缺 rawModels 分别保持原语义；未记录或空 sourceAsOfDate 及旧 schema 均不凭空造出正常日或新异常。异常日期的 CSV 公式防护仍生效，JSON 保留原始字符串。

本轮另由缓存修复同步调整旧历史缓存用例：失败后的暖缓存读取应拒绝，不能把保存的成功 payload 当成恢复；该调整对应缓存错误状态的新契约，并非本日期修复放宽断言。

## Windows 本机核验

按 [发布源码门禁](RELEASE_GATES_1.3.1.md) 执行既有完整类型、单元、组件及构建流程。新单元文本在已有测试入口内，没有新增依赖或执行脚本。

在本机合成上述完整 10 月响应后，逐项核对顶部、模型汇总、每日趋势、全部历史月柱、每日明细、异常提示、来源状态和导出。再以缺规范日期、未来零、闰日、跨账户及旧 schema 夹具复查：非法日期不可作为正常返回；真正缺失仍未知；异常 900 和警告可查；换账户后旧异常与旧金额一起清除；没有新版原始模型明细的 legacy 提示和导出限制不变。
