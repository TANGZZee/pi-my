// T3-1: codemode + tool_search 接入（SDK 能力探测，兼容用户自选旧版 SDK）。
//
// 语义（SDK 实证，agent-session.js :2746-2836）：
// - codemode 与 tool_search 都以 `defaultActive: false` 注册（extensions/codemode/index.js:26、
//   extensions/tool-search/index.js:11）——注册即入 getAllTools() 注册表（model-only 曝光），
//   但不自动激活、不声明给模型；点亮只靠 setActiveToolsByName。
// - `_refreshToolRegistry` 的 `allowedToolNames`（即 createAgentSession 的 `tools` 参数）
//   **永久裁剪注册表成员**（:2761/:2763 对 custom+builtin 双重过滤）。旧实现传
//   `tools: BASE_TOOLS` 时 mcp__*、codemode、tool_search 根本不在注册表里。
//   因此本批删除 `tools:` 参数（注册表全量），激活仍由 setActiveToolsByName 控制。
// - 删行后的 direct 增量只有 `powershell`（0.99.2 内置 8 个：bash/edit/find/grep/ls/
//   powershell/read/write）——CONFIRM_TOOLS 已含 powershell，ask 模式确认桥照常拦截。
//
// 为什么不用「动态 Set 子类放行 mcp__* 前缀」：createAgentSession 在 agent-session.js:178
// `new Set(config.allowedToolNames)` 拷贝成普通 Set，子类语义丢失；且 buildExtensions
// 顺序在构造器内，无注入点。删行是唯一安全路径。
//
// 激活基准（allToolNames → entry.knownTools 只增不减累积 getAllTools()+getActiveToolNames()）：
// - ask/full：`[...available]` 全量声明 —— codemode/tool_search/已连接的 mcp__* 自动进系统提示；
// - plan：toolsForModeSwitch 白名单（PLAN∪CUSTOM）自动排除新工具，只读语义保持。
// MCP 的 autoEnableCodemode 默认 true 也会激活 codemode —— Set 去重，幂等无冲突。

/** 能力探测：SDK 顶层是否导出这两个扩展工厂（旧版 SDK 无导出 → null，调用方跳过）。 */
export function detectCodemodeExtensions(module) {
  return {
    codemode: typeof module?.createCodemodeExtension === 'function' ? module.createCodemodeExtension : null,
    toolSearch: typeof module?.createToolSearchExtension === 'function' ? module.createToolSearchExtension : null,
  }
}

/**
 * 构造扩展工厂列表（可直接 spread 进 DefaultResourceLoader 的 extensionFactories）。
 *
 * 纪律与 mcpExtension 相同：extensionRunner 在 reload() 后是新对象，工厂必须无状态、
 * 每次会话创建现调一次（此处包装成 `() => sdkFactory()`，由 sessionExtensions 逐会话调用）。
 *
 * ⚠️ 不给 createCodemodeExtension 传选项：CodemodeExtensionOptions 实际只有
 * {mode?, inlineBudget?, models?}（0.99.2 dist/extensions/codemode/index.d.ts）——
 * 无 settings 字段，发明字段会被静默忽略。不传即走 SDK 默认（读 Settings.codemode）。
 */
export function codemodeExtensionFactories({ module } = {}) {
  const { codemode, toolSearch } = detectCodemodeExtensions(module)
  const factories = []
  if (codemode) factories.push(() => codemode())
  if (toolSearch) factories.push(() => toolSearch())
  return factories
}
