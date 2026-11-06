# 第 31 轮：离开提示与峰谷说明的焦点归属

**本轮只修改代码并静态审阅。未执行测试、类型检查、构建、格式检查、脚本或应用。下列用例均为待执行回归，不是 PASS 记录。真实 DOM、Windows/WebView2、StrictEffects 和读屏仍须另行验收。**

## 离开提示修复

- `LeavePromptDialog` 在 layout effect 中记录当前触发控件、同步原生显隐代际，并注册初始焦点 RAF。窗口不可见、文档 hidden 或没有焦点时不创建待执行首焦点。
- 首焦点监听 capture 阶段的 `focusin`、`keydown`、`pointerdown`。无论交互发生在提示内还是外，都同步取消尚未执行的 RAF；只有提示外的交互才同时撤销以后取消时的焦点归还资格。节点移除退回 body/documentElement 不被误当成用户选中了新控件。
- App 传入现有 `WindowVisibilityGate`。原生 hidden 会同步撤销提示，不等 React 提交；文档 hidden、窗口 blur 与卸载同样撤销。hidden/shown 同批发生或手动交付已取消 callback 都不能复活旧请求，新的明确离开提示仍可正常取得首焦点。
- RAF 执行前重新核对存活状态、帧身份、显隐代际、原生/文档可见性、窗口焦点和 activeElement。只聚焦仍连接、未隐藏/inert/禁用、有布局框的首个未禁用按钮。
- 所有三选一决定先取消待执行首焦点。只有“留在此页”且提示仍拥有当前焦点、原触发器仍连接并可用时，才以 `preventScroll` 归还焦点。保存成功、放弃离开、提示被替换或卸载均不自行归还，新的页面导航继续由 App 负责。

## 峰谷说明修复

- `PricingPeriodBadge` 的 document Escape 处理先检查 `defaultPrevented`。图表日期等控件在目标事件阶段已经处理的 Escape 不会再关闭峰谷说明或抢回焦点。
- 未处理的外部 Escape 仍可关闭说明，但保持外部控件焦点。仅当事件目标和处理时的真实 activeElement 都仍在说明容器内，才归还到峰谷按钮；冒泡期间已经移到外部的焦点不被旧事件目标夺回。
- 保留按钮开关、内部点击不关闭、外部点击关闭、展开关系 ARIA 与卸载清理；未改变峰谷计算规则或定时刷新策略。

## 合成组件覆盖（全部待执行）

`tests/directed-settings-focus.test.tsx` 复用实际 App、SettingsPanel、LeavePromptDialog 和原生监听链。合成节点绑定当前 renderer host 身份，重渲染仍可观察，卸载后不会别名到同形的新节点；受控 RAF 保留已取消 callback 供故意迟到交付。归还无效目标的断言同时检查 `.focus()` 调用尝试，而不只依赖合成节点拒绝聚焦后的成功日志。

新增 29 个 R31 场景，各覆盖两个设置入口与 legacy/concurrent renderer，声明 116 个用例：

1. 首焦点只执行一次；提示内 Tab/点击后的 Cancel 安全归还原输入框，不因 shown 重放。
2. 三类外部交互分别同步取消首焦点；旧 callback、重显与后续取消不能复活它，新提示仍可工作。
3. 三类内部交互也取消首焦点。键盘/指针分支在随后 focusin 之前交付旧 callback，避免只测到 focusin 的取消效果；合法 Cancel 仍可归还。
4. native hidden、document hidden、blur 在 React 提交前同步取消，并在同批恢复及迟到 callback 后保持失效。
5. 没有事件时，RAF 仍重查 document hidden、hasFocus 和主动变更的 activeElement。
6. 首焦点完成后，原生/文档隐藏、失焦、外部焦点/点击、隐藏/禁用触发器，以及无事件的隐藏/失焦/外部焦点共十种情况都拒绝归还，也不能等恢复后补归还。
7. 隐藏时创建提示不安排首焦点，shown 不会自行启动它。
8. 放弃离开不抢回旧输入框；只由新页面 RAF 聚焦首页标题。
9. 保存成功、保存失败与保存途中取消三种异步结果：直接调用决定也取消初始 RAF；保存中保持保存/放弃禁用、取消可用；保存成功交给新页面，失败保留草稿和提示，取消后的迟到成功不得导航或补聚焦。
10. 卸载取消旧 callback，且不归还旧控件。所有场景结束核对 RAF、document/window/native 监听清理。

`tests/pricing-period-badge.test.tsx` 挂载实际 Badge 与 StackedBarChart，声明 6 个场景 × 两种 renderer 模式，共 12 个用例：图表已处理 Escape、外部未处理 Escape、内部 Escape 归还、defaultPrevented/其他按键、冒泡前焦点移动及相反方向目标不匹配、开关/内外点击/清理。夹具把同一个事件的 defaultPrevented 从 React 目标处理传给 document 监听，并确认图表与 Badge 监听均收到该事件，避免靠漏投递制造假通过。

新增 Badge suite 与独立的 `quit-request-lifecycle` suite 已注册到 `scripts/test-settings-components.mjs`，组件 runner 共十二套。`scripts/tests/release-gates.test.mjs` 保留全部 suite 的源文件与注册断言。运行入口仍是 `npm run test:components`，门禁检查是 `node --test scripts/tests/release-gates.test.mjs`，本轮均未运行。

## 真实 DOM 与 Windows/WebView2 验收（待执行）

1. 在真实 `createRoot` + StrictMode 测试环境中暂停 RAF。通过 API Key、Token 或提醒设置的真实草稿打开提示；在提交后、首帧前分别 Tab、Shift+Tab、点击另一个控件，以及真实 `.focus()`。释放旧 RAF 后焦点必须保持用户选择。提示内操作也不能被迟到首焦点抢走。
2. 在同一竞争窗口隐藏到托盘、触发文档 hidden、Alt-Tab，分别在隐藏中和恢复后释放旧 RAF。再做快速 hidden/shown 同批与卸载重挂载；旧 callback 均无焦点副作用，新明确提示仍只聚焦一次。
3. 正常提示按“留在此页”恢复到仍可用的触发器。焦点已到外部、触发器断开/隐藏/inert/禁用或窗口失焦时不能抢回。保存成功与放弃离开只聚焦新页；失败保留草稿；保存途中取消后的迟到成功不能导航或补聚焦。
4. 键盘打开峰谷说明，Tab 到图表日期，用 Enter 固定明细后按 Escape。明细关闭，日期保持焦点，峰谷说明仍打开。再到普通外部控件按未处理的 Escape：说明关闭，焦点不回峰谷按钮。按钮内部 Escape 正常关闭，按钮可继续激活。
5. 窄窗口和 200% 缩放下检查焦点环、滚动及 Tab 顺序。分别用 NVDA 与 Narrator 检查提示名称/描述、三个决定和峰谷按钮的展开状态，记录各自结果。

合成 renderer 不执行浏览器事件冒泡、Tab/Enter 默认行为、真实布局或 `createRoot` StrictEffects 重放。合成 `.focus()` 日志与 ARIA 属性存在不能作为以上任何原生项目通过的证据。完整本机检查仍按[发布门禁说明](RELEASE_GATES_1.3.1.md)与[验收清单](ACCEPTANCE_1.3.1.md)执行。
