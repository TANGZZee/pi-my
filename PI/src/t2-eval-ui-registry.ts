/**
 * T2⑨ 评估结论文档：UI 插件注册表（PI/src/ui-registry.ts）迁移到 SDK 扩展 UI API 的可行性。
 *
 * 结论先行：**不迁移**。SDK 的扩展 UI API（ExtensionUIContext / MessageRenderer /
 * EntryRenderer）面向终端 TUI（Component/Theme/TUI 类型，@earendil-works/pi-agent-core
 * 渲染栈），而 PI 的插件系统面向 Web GUI（Svelte 5 + 声明式描述符 + iframe 沙箱）。
 * 两者渲染宿主不同构，不存在可承载迁移的 API 面；迁移 = 重写而非重构，且会失去
 * 纯数据注册表可被 node:test 直接覆盖的承重属性。以下把证据锚死，防止后来者重复勘查。
 *
 * == 证据链 ==
 *
 * 1. SDK 渲染器签名是 TUI 组件工厂（dist/core/extensions/types.d.ts:1126）：
 *      type MessageRenderer<T> = (message: CustomMessage<T>, options: MessageRenderOptions,
 *                                 theme: Theme) => Component | undefined
 *    其中 Component/Theme/TUI 来自 TUI 渲染栈（types.d.ts:12 从 TUI 模块导入；
 *    :67 EditorFactory = (tui: TUI, theme: EditorTheme, …) => EditorComponent）。
 *    PI 的 RendererSpec（src/ui-registry.ts:29-33）是纯数据描述符 {kind:'builtin'|'iframe',
 *    target}，由 PluginHost.svelte 解析成 Svelte 组件 —— 两侧的「组件」没有任何交集。
 *
 * 2. SDK 的 UI 交互原语同样是终端形态（types.d.ts:72-140 ExtensionUIContext）：
 *    select/confirm/input（TUI 对话框）、setWidget/setFooter/setHeader（TUI 组件工厂）、
 *    custom<T>((tui, theme, keybindings, done) => Component)。没有 Web 侧等价物，
 *    没有四槽位（timeline/float/settings/status）概念，没有 iframe 沙箱协议。
 *
 * 3. SDK 有 messageRenderers/entryRenderers 注册容器（types.d.ts:1684-1686），但它们
 *    挂在 ExtensionRunner 内部状态上，经 registerTool/registerCommand 同族的扩展加载期
 *    API 填充（TUI 进程内）；PI 的注册表是 UI 进程内运行时对象（registerRenderer /
 *    registerSlotHost 随时可调，含 unregister/subscribe/trust 门闩），生命周期与信任
 *    模型（RESERVED_CUSTOM_TYPE_PREFIX 'ui.' 防劫持、'core' 来源保留、iframe target
 *    协议白名单，ui-registry.ts:16-21）都是 Web 侧特有，SDK 无对应承载点。
 *
 * == 反向机会（记录但不做） ==
 *
 * 若未来把 PI 的 Web GUI 做成 SDK 的 RPC 前端（ExtensionMode 'rpc'，types.d.ts:212），
 * ExtensionUIContext 的 select/confirm/input 会经 RPC 透传到宿主 UI —— 届时 Web 侧
 * 可以承接这些对话框原语。但 renderers/widget/footer 仍是 TUI 工厂形态，不随 RPC 走；
 * 且该路径要求插件以 SDK 扩展（Node 模块，运行在 sidecar 进程）形态分发，与 PI 当前
 * 「消息驱动 + 声明式描述符 + iframe 沙箱」的 Web 插件模型不兼容。真要做，是一个独立
 * 的架构项目，不属于 T2 范围。
 *
 * == 处置 ==
 *
 * ui-registry.ts 保持原样（0 行改动）。本评估以注释形态锁定于本文件 + 承重测试
 * （tests/upgrade-t2-context.test.mjs 无涉；本评估无代码变更，故无新承重测试 ——
 * 锁定对象是「未改动」这一事实，由 upgrade-t2-mcp/context/imagegen 三套件的既有
 * 断言共同保证 ui-registry 相关锚点不被波及）。
 */
export {}
