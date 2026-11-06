# 第 29 轮：定向设置的导航焦点所有权

**仅修改代码并静态审阅。未执行构建、测试、脚本或应用。以下都是待执行回归，不是 PASS 记录；原生 DOM、Windows/WebView2、NVDA 与 Narrator 仍需维护者验收。**

## 修复范围

- `SettingsPanel` 不再接受 `targetSection`，不再创建独立 RAF。它只提供 `data-settings-focus="usageToken"`、`data-settings-focus="dataNotices"` 及 `data-settings-disclosure="dataNotices"` 三个定位标记。
- 设置目标和页面、导航代际一起提交，并保存在 App 的同一焦点请求中。首页/详情的数据说明、历史页的 Token 配置入口与首次引导的 Token 入口都走这一请求。普通设置标题与详情返回模型继续保留原有行为。
- 打开数据说明、滚动、聚焦三项副作用都属于同一请求。后续 `focusin`、`keydown`、`pointerdown`、原生 hidden、document hidden、窗口 blur、账户状态变化、新导航意图及草稿离开提示会永久撤销旧定向请求。显示/重新聚焦窗口或取消草稿提示不能恢复它。
- 执行前重查当前帧身份、请求身份、已提交页面/目标、导航代际、账户代际、原生可见性、document 可见性/hasFocus、主动焦点变化及目标连接/隐藏状态。帧先消费请求，再打开说明、滚动和聚焦；自身的 focusin 不会生成第二次请求。
- 同一页面的偏好/数据提交可以替换尚未执行的 RAF，但被取消的旧 callback 即使被故意交付也不能消费新帧。账户变化则永久撤销定向请求，不把它变成稍后重放。
- 数据说明不再由渲染时的 `open` 属性提前打开。只有仍合法的请求能展开它；用户随后手动开关 details 不会被后台刷新强制覆盖。

## 新增合成组件覆盖（待执行）

`tests/directed-settings-focus.test.tsx` 挂载生产 `App` 与真实 `SettingsPanel`、草稿状态和 `LeavePromptDialog`。使用合成 ref、RAF、IPC 和事件，分别记录 details 打开、scrollIntoView 与 focus。节点来自当前 renderer 树，不在夹具中重写 App 的请求所有权判断；一般子组件 ref 也不是一律 no-op，避免重新引入子 RAF 后测试看不见它。

11 个场景，每个都覆盖 `usageToken`/`dataNotices` 和 legacy/concurrent renderer，共声明 44 个用例：

1. 正常进入只展开/滚动/聚焦一次；普通刷新不重放，再次明确进入成功。
2. 引导 Token 和详情数据说明入口与历史 Token、首页数据说明入口共用同一机制。
3. focusin、Tab keydown、pointerdown 分别取消；迟到旧帧和重新显示均无副作用，新导航成功。
4. native hidden、document hidden、blur 分别取消；恢复前后都故意交付旧 callback，均不重放。
5. 不发送可见性/失焦事件，直接在执行前改变 document.visibilityState 或 hasFocus，仍拒绝执行和复活。
6. 账户 A → B → A 的旧凭据内容恢复不复活旧定向请求，新明确导航成功。
7. 普通偏好提交替换 RAF，旧 callback 不能抢先执行，当前合法帧仍只执行一次。
8. 无键盘/指针事件的新导航也取消旧帧；返回首页再进入另一个设置目标，旧帧不能错误定位新页面。
9. 使用真实 API Key 草稿和真实 App blocker 阻止离开，旧帧不能抢提示框焦点；点“留在此页”保留草稿且不重放，清空草稿后新导航成功。
10. 卸载取消所有排队帧，迟到 callback 不触及断开目标。
11. 普通设置仍聚焦标题，详情明确返回仍恢复到当前重挂载的模型入口，不额外展开或滚动设置。

执行入口为仓库统一的 `npm run test:components`。本轮只注册用例，未运行命令；生产类型检查、组件套件、完整构建和全部发布门禁须由维护者在 Windows 按仓库说明自行执行。不能把 renderer 合成焦点日志、props 回调或 concurrent renderer 模式当作原生 DOM、真实 Enter/Space、StrictEffects 或读屏通过证据。

## Windows/WebView2 与原生 DOM 回归（待执行）

使用维护者自行编译的 Windows 应用，以及可暂停/逐帧交付 RAF 的真实 `createRoot` + StrictMode DOM 测试环境。保留浏览器实际 `.focus()`、`document.activeElement`、原生键盘/指针事件与布局，不以合成节点代替。

对两个定向目标分别执行：

1. 正常进入，释放帧后 focus 指向 Token 区块或数据说明 summary，数据说明只展开一次。继续 Tab/Shift+Tab 正常移动。普通刷新及窗口重显不把焦点拉回来。
2. 设置已提交、RAF 尚未执行时，分别 Tab、Shift+Tab、点击 API Key、主动调用另一个控件的真实 `.focus()`；再释放旧帧。焦点保持用户最后选择，滚动位置与 details 状态不被旧请求改变。
3. 同一竞争窗口内分别隐藏到托盘、document hidden、Alt-Tab。恢复前后释放旧帧，都不得后台聚焦或恢复时跳动。再次明确导航可以定位一次。
4. 账户/凭据变化、配置不可信/恢复或清理状态变化发生在提交与帧之间，旧帧失效。普通非凭据偏好提交不应丢失仍合法请求，但先前被替换的帧不能执行。
5. 后续导航离开或更换目标，只能最新请求生效；设置草稿阻挡导航后，提示框拥有焦点。点“留在此页”不能复活旧定向请求，草稿仍在。
6. 未提交/中止的并发渲染、StrictEffects 重放、快速同目标往返、组件卸载和过期帧均不执行失效副作用。
7. 覆盖首页/详情数据说明、历史/引导 Token 四个生产入口；普通设置/历史标题与三个模型的明确返回继续按[第 28 轮回归](REVIEW28_RETURN_FOCUS_REGRESSIONS.md)验收。

在紧凑窗口和 200% 缩放下检查滚动和焦点环；分别使用 NVDA 与 Narrator，记录版本和扫描/浏览模式。正常定位后应读到正确设置区块，主动选择别处或取消提示后不得重新读出旧目标。Windows 原生焦点、真实滚动布局和读屏结果必须分别记录，不能互相代替。
