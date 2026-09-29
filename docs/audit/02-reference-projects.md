# 参考项目分析：percho 与 pi-agent-desktop

> 目的：为 Pi-My 的下一步演进提炼**可移植的机制**，并明确**不要复制的东西**。
> 两个项目都是 MIT，均基于同一个 `@earendil-works/pi-coding-agent` SDK，与 Pi-My 同源，因此机制可以直接借鉴。

- **percho**（`Jaxton07/percho`）：Electron + React 19 + Tailwind 4 + Zustand，npm workspaces 三包（shared / backend / desktop）。定位"高度自定义 GUI"。
- **pi-agent-desktop**（`Chasen-Liao/pi-agent-desktop`，v0.8.9）：Electron + Next.js App Router（standalone）渲染，衍生自 `agegr/pi-web`。定位"个人极简版 Codex"。

---

## 1. 两者架构对比（以及对本项目的含义）

| 维度 | Pi-My（我们） | percho | pi-agent-desktop |
|---|---|---|---|
| 壳 | **Tauri 2**（Rust） | Electron | Electron |
| 前端 | Svelte 5 | React 19 | React（Next.js） |
| SDK 运行位置 | Node sidecar（子进程，NDJSON） | Electron 主进程**内** | Next.js 服务器进程**内** |
| 传输 | Tauri IPC（事件 + invoke） | Electron IPC | **HTTP + SSE**（loopback 端口） |
| 启动耗时 | 快（无 HTTP 服务器） | 快 | **分钟级**（issue #32，双闸门 + 60s 超时） |
| 打包复杂度 | 中（复制 node.exe + SDK） | 中 | **极高**（5 个修复脚本） |
| 测试 | **0** | 0（有 biome check） | **100 个测试文件** |

**关键结论**：Pi-My 的**架构选择其实是三者中最优的**——Tauri 没有 Electron 的体积，也没有 pi-agent-desktop 那套"为了在本地跑一个 Web 服务器"而付出的巨大代价。**不要迁到 Electron，也不要引入 loopback HTTP/SSE 传输**。

真正该抄的是**进程内的机制**（事件瘦身、权限引擎、队列 CAS、测试姿态）。

---

## 2. 最有价值的可移植机制（按优先级）

### 2.0 ⭐⭐⭐ 先看 SDK 提供了什么：`RpcClient` / `runRpcMode` / `toJsonEvent`

**这是本次调研最重要的结论：Pi-My 手写的大量协议层代码，SDK 已经提供。**

实测（在 `PI/` 目录下）：

```
node -e "import('@earendil-works/pi-coding-agent').then(m=>console.log(Object.keys(m).filter(x=>/Json|Rpc/i.test(x))))"
→ ["RpcClient","runRpcMode"]
```

| SDK 提供 | 位置 | 说明 |
|---|---|---|
| `RpcClient` | `dist/modes/rpc/rpc-client.d.ts`（254 行接口） | 类型安全的内嵌客户端：spawn CLI 进程 + 全部命令 + 事件订阅 |
| `runRpcMode` | `dist/modes/rpc/rpc-mode.js` | 服务端：stdin JSON 命令 → stdout 事件/响应 |
| `toJsonEvent` | `dist/modes/json-event.js` | **官方事件瘦身**（`rpc-mode.js:266` 已在用） |
| `RpcCommand` | `dist/modes/rpc/rpc-types.d.ts` | 完整命令联合类型 |
| `JsonAgentSessionEvent` | 同上 | 瘦身后的事件类型 |

**`RpcClient` 比 Pi-My 手写协议更强的地方**（逐条对照 `rpc-client.d.ts`）：

| 能力 | Pi-My | RpcClient |
|---|---|---|
| 事件瘦身 | ❌ | ✅ 内置 |
| 进程退出时 reject 所有 pending | ❌（P0-6） | ✅ `rejectPendingRequests` |
| `waitForIdle`（等 `agent_settled`） | ❌（靠 3 分钟看门狗猜） | ✅ |
| `getAvailableThinkingLevels` | ❌（硬编码 7 档） | ✅ |
| `getCommands`（扩展命令/skill） | ❌（硬编码 10 条） | ✅ |
| `getTree` / 分支树导航 | ⚠️ 部分 | ✅ |
| `compact` / `setAutoCompaction` / `abortRetry` | ⚠️ 未接线 | ✅ |
| `exportHtml` | ❌（只导 JSON） | ✅ |
| `getState` 完整状态快照 | ⚠️ 只有 session_stats | ✅ |
| 扩展 UI 桥 + `extension_error` | ❌ | ✅ |
| stdout backpressure | ❌ | ✅ |

**但不要整体替换**，原因：

1. **一个 RPC 进程只管理一个会话**，与 Pi-My 的多会话 `Map` 模型（`sidecar/index.mjs:18`）不符；
2. 会丢掉 Pi-My **独有**的大半能力：文件读写、Git 面板、商店生态、生图、视觉桥、局域网观察、桌宠、SDK 自更新；
3. `RpcClient` 需要 spawn **CLI 进程**（`cliPath`），而 Pi-My 现在是**在 sidecar 进程内直接 import SDK**，更轻。

**正确策略**：**保留自建 sidecar 架构，只借鉴 `RpcClient` 的机制**（见 P0-A2）。中长期若要重构，可考虑"`RpcClient` 托管 Agent + 自建非 Agent 能力"的混合架构。

---

### 2.1 ⭐⭐⭐ 事件瘦身 —— 但**首先应该用 SDK 自带的**

**问题背景（percho 实测）**：SDK 的 `message_update` 每条 delta 都携带**两份全量累积快照**（顶层 `message` + `assistantMessageEvent.partial`）。流式期按 delta 条数**平方放大**。percho 记录的事故原文：

> `0.4.6 冻结事故：3 分钟 12.7GB trace / renderer 堆爆`

#### 关键发现：SDK **自己就提供了**这个瘦身函数

percho 是**自己写**的（因为它绕开了官方出口），但 SDK 早已内置：

```js
// @earendil-works/pi-coding-agent/dist/modes/json-event.js:16-28
export function toJsonEvent(event) {
    if (event.type !== "message_update") return event;
    return {
        type: "message_update",
        usage: event.message.usage,        // 保留累积 usage（用量统计需要）
        assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
    };
}
```

官方注释（`json-event.d.ts:25-30`）：

> *Remove cumulative assistant snapshots from streaming wire events. `message_start` provides the initial message, deltas build it, and `message_end` provides the final authoritative message.*

**且 SDK 的 RPC 模式已经默认启用**：`rpc-mode.js:266` → `output(toJsonEvent(event))`。

**但该模块未从主入口导出**（实测 `'toJsonEvent' in m === false`），所以正确做法是**照抄这 29 行**，而不是深路径 import（那正是参考项目挨批的做法）。

#### percho 的**第二层**瘦身仍然值得抄

官方的 `toJsonEvent` **只处理 `message_update`**。percho 额外发现 `tool_execution_end` / `message_start` / `message_end` / `turn_end` 会对大 `result`（如 read 图片的 base64）**重复携带四份**：

> `实测 504KB×4 ≈ 2MB/次，小时级累计把 renderer 压垮`

percho 的处理（`event-slim.ts:65-118`）：

- 文本块 > 16KB → 截断保头 4KB
- 图片 base64 > 512B → 换占位符 `[image data stripped: NB]`
- **`details` 一律不动**（todos / subagent / edit patch / show_image 的数据源都在这）

**结论**：Pi-My 的 P0-1 修复 = **照抄 SDK 的 `toJsonEvent`（29 行）+ percho 的第二层截断**。这比"移植 percho 118 行"更准确、更不易腐坏。

---

### 2.2 ⭐⭐⭐ 权限规则引擎（percho `permissions/`）—— Pi-My 权限功能的正确性根基

Pi-My 现在只有"三模式 + 按工具名确认"（`PI/sidecar/policy.ts`，33 行）。percho 的 `permissions/` 是**一个完整的、经过踩坑的子系统**，5 个模块职责清晰：

| 模块 | 职责 | 为什么重要 |
|---|---|---|
| `pattern.ts` | `allow/ask/deny` × 通配模式求值；`*` 全局兜底；**后命中生效** | 表达力从"工具名"升级到"工具名 + 参数模式" |
| `bash-chain.ts` | 引号感知切段；`$( )`/反引号提取；`sh -c`/`eval` 剥壳；**命令链取最严段** | `cd x && rm -rf y`、`echo $(rm -rf y)` 无法绕过 |
| `tmp-zone.ts` | 系统临时区判定 + `rm` 目标提取；**fail-safe**（判不中就弹窗） | 不打断 agent 临时工作流，又不误放行 |
| `config.ts` | `~/.pi/agent/permissions.json` 读写；mtime 缓存；非法回退默认 | 用户可手改，改完即时生效 |
| `gate.ts` | 会话内"总是允许"（同 title）+ 待决请求快照 | 减少重复弹窗 |

**默认配置的设计哲学值得照抄**（`config.ts:33-73`）：**宽松 + 高危兜底**。

```ts
rules: {
  "*": "allow",                    // 默认放行，效率优先
  bash: {
    "*": "allow",
    "sudo *": "ask",
    "rm -rf *": "ask", "rm -fr *": "ask", "rm -r *": "ask",
    "mkfs*": "ask", "dd *": "ask", "shred *": "ask",
    "git push --force*": "ask", "git reset --hard*": "ask", "git clean -f*": "ask",
    "curl * | sh*": "ask", "wget * | bash*": "ask",
    // 自保护：触及权限/信任/凭证配置的命令必确认
    "*permissions.json*": "ask", "*auth.json*": "ask", "*trust.json*": "ask",
  },
  // edit/write 改这些文件也要确认
  edit:  { "*permissions.json": "ask", "*auth.json": "ask", ... },
  write: { ... },
}
outside: { read: "allow", write: "ask", temporary: "allow" }   // 读写分离
```

**三个精妙点**：

1. **读写分离**：路径越界时 `read` 默认放行、`write` 默认确认。注释论证得很到位——*"拦读不换安全只损效率"*。
2. **`allowAlways` 的粒度是"父目录前缀"而非精确文件**（`pattern.ts:159-167`）：精确到文件会导致"换一个文件又弹"。同时有 `tooBroadDir` 守卫，**绝不因记忆键放大到整个家目录**。
3. **`suggestPattern`** 让 bash 的记忆粒度是 `rm -rf*` 而不是 `rm*`（`pattern.ts:177-195`）。

**移植建议**：不要整包照搬（约 1000 行），但**这三个文件优先**：`pattern.ts` + `bash-chain.ts` + `config.ts`。它们都是**纯函数、零 IO、可单测**——正好补上 Pi-My 的测试空白。

---

### 2.3 ⭐⭐⭐ 测试姿态（pi-agent-desktop，100 个测试文件）

这是**Pi-My 与参考项目差距最大的一项**（0 vs 100）。值得直接抄的具体做法：

| 做法 | 文件 | 价值 |
|---|---|---|
| **纯函数抽离** | `components/chat-input/submit-action.ts`（9 行，零 React） | 把"Enter 插话 / Alt+Enter 排队 / Shift+Enter 与输入法合成不响应"这个产品决策变成可测函数 |
| **断言构建脚本内容** | `package.test.ts` | `assert.match(pkg.scripts["build:standalone"], /smoke-standalone-server\.mjs/)` → 删掉承重脚本会**测试失败** |
| **隔离临时目录冒烟测试** | `smoke-standalone-server.mjs` | 复制到独立临时目录跑，避免仓库级 `node_modules` 掩盖打包缺失依赖（issue #14 的验收标准） |
| **事件→patch 纯函数** | `hooks/agent-session/agent-event-apply.ts` | 事件归约逻辑与 React 解耦，可单测；副作用以"描述符"返回 |
| **`node --test` + `--test-force-exit`** | `package.json` | 零依赖；注释明确警告"不加 `--test-force-exit` 会因为句柄不释放而挂住" |
| **CI 断言产物数量** | `.github/workflows/desktop-packages.yml` | 发布前若资产数 ≠ 10 则失败 |

**对 Pi-My 的直接映射**：

| pi-agent-desktop 的模块 | Pi-My 应测的对应物 |
|---|---|
| `submit-action.ts` | `App.svelte:1951-1967` `handleKeydown` 的分支逻辑 |
| `agent-event-apply.ts` | `App.svelte:1220-1263` 的事件归约 |
| `follow-up-queue.ts` | `App.svelte:1723-1745` 的 queue 操作 |
| `approval-policy.ts` | `PI/sidecar/policy.ts`（已是纯函数，**立刻可测**） |
| `path-policy.ts` | `PI/sidecar/index.mjs` 的 `readWorkspaceFile`/`assertEcoTogglePath` |

---

### 2.4 ⭐⭐ 队列的乐观并发（CAS）—— 防止排队消息错乱

**percho 的 `follow-up-queue.ts`（78 行，纯函数）** 与 **pi-agent-desktop 的 `lib/follow-up-queue.ts`** 思路一致：

```ts
reorder(orderedIds: string[], expectedRevision: number): FollowUpQueueSnapshot {
  if (expectedRevision !== this.revision) throw new Error("Follow-up queue changed; refresh and try again");
  if (orderedIds.length !== this.items.length || new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some(id => !this.items.some(item => item.id === id)))
    throw new Error("Follow-up queue order must contain every queued item exactly once");
  ...
  this.revision += 1;
}
```

**要点**：每次变更 `revision++`；重排是**比较并交换**，版本不符就拒绝；并校验 id 集合是**全集的排列**。快照只暴露 `attachmentCount`，**不带图片字节**。

Pi-My 现在的 `moveQueue(index, dir)` 是**按钮上移/下移**（`App.svelte:1731-1740`），没有 revision、没有拖拽、没有持久化。若要加拖拽重排（参考项目都有），**必须同时引入 revision**，否则拖拽期间到达新消息会导致顺序错乱。

---

### 2.5 ⭐⭐ 扩展 UI 桥（`extension-ui-bridge.ts`）—— 决定"插件能不能用"

**pi-agent-desktop issue #31 是这方面最好的教材**：用户反馈"插件在 Pi CLI 里能用，桌面端不能用"，维护者回复：

> "这个桌面端只对最小规模的 Pi harness 做了适配哦，因为太多插件了，适配不过来"

根因是 `ExtensionUIContext` 的实现里**约 25 个方法是 no-op 空壳**，所以任何依赖 `setWidget`/`setFooter`/`setStatus`/`custom`/主题的插件**静默失效，且无任何诊断**。

**percho 踩过更具体的坑**（issue #28，已修复）：

> 桌面端注入的 `ui.theme` 是字符串而非 Theme 对象，导致**所有 MCP 服务器永久无法连接**
> （`pi-mcp-adapter` 在 `updateStatusBar` 里调 `ui.theme.fg("accent", ...)` 直接抛 `TypeError`）

percho 的修复方式值得抄（`session/ui-context.ts:17-75`）：**构造一个真实的 `Theme` 类实例**（40+ 个色字段全给），而不是手写 pass-through 对象——注释点明：*"进了一支扩展调用 `italic()`/`getFgAnsi()` 还是会崩"*。

**percho 其余几个诚实性设计**：

- `ui.custom()` 无宿主时返回 `undefined` 并**留日志**（对应其 issue #36："静默返回 undefined，无日志、无可见错误"）；
- `setTheme` **诚实返回失败**：`{ success: false, error: "Theme switching is managed by Percho" }`，注释解释*"假成功会让扩展据返回值分支误判"*；
- `select/input/editor` 无宿主时返回 `undefined`（契约的"用户取消"），**不伪造"第一项/空串"当作真实输入**。

**对 Pi-My 的含义**：Pi-My 用的是 `DefaultResourceLoader` + `extensionFactories`，**但没有传 `uiContext`**。这意味着第三方扩展若调用 `ctx.ui.confirm(...)` 会怎样？**需要实测**——这是一个潜在的静默失效点，也是 P1-5 权限之外的另一个"扩展兼容性"缺口。

---

### 2.6 ⭐⭐ 有界重启与崩溃恢复（pi-agent-desktop）

| 机制 | 位置 | 要点 |
|---|---|---|
| 渲染进程崩溃恢复 | `electron/main.ts:467-496` | `getNextCrashReloadState({now, reason, attempts, isQuitting})`：**60 秒窗口内最多 3 次**重载，超限则显示错误页而非白屏 |
| 服务重启 | `electron/main.ts:216-247` | `getNextRestartState` 同样限次，超限转 `stopped` 并给出可见提示 |
| 进程树清理 | `electron/process-tree.ts` | Windows `taskkill /PID x /F /T` |

**对 Pi-My 的直接价值**：P0-4（sidecar 崩溃后永久失能）与 P0-3（PTY 孤儿进程）正好对应这两条。**限次**这个设计很关键——无脑自动重启会变成崩溃循环。

---

### 2.7 ⭐ 子代理与工具的其他可抄点

| 机制 | 来源 | 说明 |
|---|---|---|
| `show_image` 工具 | percho `tools/show-image.ts` | 让 agent 主动发图到对话区，**图片只走 `details`，不进模型上下文**（省 token），最多 9 张、单张 10MB |
| 上下文蒸发 | percho `tools/context-evaporation/` | 到龄的工具输出自动变紧凑 stub；默认开启，长会话不超预算。约 28KB 实现，复杂 |
| 长期记忆 | pi-agent-desktop `lib/ltm/` | 项目级 SQLite；**FTS5 `trigram` 分词器**（默认 `unicode61` 完全无法匹配中日韩子串）；`is_latest`/`parent_id` 取代链 |
| 会话分叉到 Git worktree | pi-agent-desktop `lib/git-worktree.ts` | 1321 行，最防御性的模块：ownership UUID + reflog 标记 + 三重身份复核 + **fail-closed 清理** |
| i18n | pi-agent-desktop `lib/i18n/` | en + zh-CN，40KB 字典 |
| Windows 原子写 | pi-agent-desktop `lib/atomic-write.ts` | `rename` 重试 `EPERM`/`EACCES` **100 × 25ms**（并发读会阻塞 rename），最后兜底直接写 |

**注意 percho 与 pi-agent-desktop 都把"FTS5 迁移"当成重要成果**——因为 `CREATE VIRTUAL TABLE IF NOT EXISTS` **永远无法改变分词器**，`rebuild` 也只重新索引。唯一路径是 drop → recreate → repopulate，并用 `PRAGMA user_version` 守卫。若 Pi-My 未来做记忆功能，这个坑必踩。

---

## 3. 两个项目的 BUG 与不合理之处（供我们规避）

### 3.1 percho

| 类型 | 内容 | 对我们的启示 |
|---|---|---|
| **BUG（已修）** | issue #28：`ui.theme` 是字符串而非 Theme 对象 → **所有 MCP 服务器永久无法连接** | 提供 `uiContext` 时必须用**真实类实例**，不能省字段 |
| **BUG（已修）** | issue #21：subagent 工具 schema **缺顶层 `type: object`** → OpenAI 兼容协议（DeepSeek 等）请求**全部 400** | 自定义工具 schema 必须严格符合 JSON Schema；**要按最严格的 provider 测** |
| **BUG（已修）** | issue #36：`ui.custom()` 在 RPC 模式**静默返回 undefined**，无日志 | 所有降级路径**必须留日志** |
| **BUG（未修）** | issue #32：扩展内部异常宿主**日志零线索** | 扩展调用要包 try/catch 并记录来源（percho 用 stack 启发式归因扩展名） |
| **BUG（已修）** | issue #47：subagent **静默忽略** Pi agent 定义中的 `thinking` | 配置项要真实生效，或明确报错 |
| **设计缺陷** | **零测试文件**，但 `package.json` 声明了 `test` 脚本（`--workspaces --if-present`，实际无测试） | 有测试脚本 ≠ 有测试；CI 里要真的跑 |
| **未完成项** | issue #72：UI 插件**缺少持久化通道**（桌宠记不住拖拽位置） | 插件状态要能落盘 |
| **未完成项** | issue #71：Windows 关窗最小化到托盘**只实现了 macOS** | 平台功能要逐平台验证 |
| **未完成项** | issue #74：文件路径菜单找不到入口（默认折叠 + 仅 hover 出现） | 可发现性不能靠 hover |
| **未完成项** | issue #58：**没有字体大小设置** | 无障碍基础项 |

### 3.2 pi-agent-desktop

| 类型 | 内容 | 对我们的启示 |
|---|---|---|
| **BUG（已修，严重）** | issue #14：v0.8.0 打包版 `GET /api/health` → 200，但其他接口全 500，`ERR_MODULE_NOT_FOUND pi-ai/dist/index.js` | **健康检查必须真的 import 业务依赖**，否则是假绿灯 |
| **BUG（已修，严重）** | issue #21：API key 只写进**内存** override，每个请求都丢 → "配了 key 却说无效" | 配置必须**持久化到磁盘**（`auth.json`） |
| **BUG（已修）** | issue #20/#33：对话中**随机白屏**；另一个终端同时跑 Pi 时白屏（原子写 + SQLite busy 重试 + 错误边界） | 并发写同一批配置文件必须原子化 |
| **BUG（未修，严重）** | issue #32：**启动分钟级**（用户明确说"期望秒级"） | 架构性代价；**Pi-My 不该引入 loopback HTTP** |
| **BUG（未修）** | issue #31：插件在 CLI 能用、桌面端不能用；维护者承认"适配不过来" | 扩展兼容性是长期成本；**要么真支持，要么明确报错** |
| **BUG（未修）** | issue #53：自定义 provider 的 key 被报无效（零维护者响应） | 自定义 provider 路径要有集成测试 |
| **技术债** | `applyDeepSeekXhighWorkaround` 直接改写 `agent.state.thinkingLevel`，TODO 注释写"Tracked in upstream pi issue"**但没有链接** | hack 必须留可追踪的 issue + 移除条件 |
| **技术债** | 通过 `as unknown as` 强制转换调用 SDK **私有** `_rewriteFile()`（3 处） | 别依赖私有 API；宁可提 PR 上游 |
| **技术债** | `lib/session-export.ts:14` 直接 import `../node_modules/.../dist/core/export-html/index.js`，**绕过 exports map** | 深路径 import 会在 SDK 小版本升级时断 |
| **技术债** | `outputFileTracingIncludes` 硬编码；`extraResources` 的 `filter:["**/*"]` **静默排除 node_modules**；16 个包的 electron-updater 闭包手写 | 打包产物必须**冒烟测试**，不能只在开发环境验证 |
| **架构代价** | Next.js standalone 需要 **5 个修复脚本**，每个都对应一次真实故障 | 复杂度会自我繁殖；**选简单架构** |

---

## 4. 明确**不要**复制的东西

| # | 不要抄 | 原因 |
|---|---|---|
| 1 | **Electron 替换 Tauri** | Tauri 更小更快；Pi-My 现在的壳选择是对的 |
| 2 | **loopback HTTP + SSE 传输** | 这是 pi-agent-desktop 全部复杂度（端口占用、健康轮询、双闸门、5 个打包脚本、分钟级启动）的**根因**。Tauri IPC 天然不需要。**但 SSE 的事件形状值得抄** |
| 3 | **Next.js standalone 打包链** | 5 个脚本 + 只对宿主架构 trace + 符号链接解引用……每次 Next/Turbopack 升级都是回归风险 |
| 4 | **`serverExternalPackages` 外置 SDK** | 会强迫手工重建依赖闭包 |
| 5 | **SDK 私有 API / 深路径 import** | `_rewriteFile()`、`inner.agent.state`、`dist/core/export-html/index.js` |
| 6 | **percho 的 12.7GB 事故教训，但不抄它的教训** | 也就是：**绝不在流式路径上转发全量快照** |
| 7 | **`parseFn(URL \| URLSearchParams \| string)` 三态 API** | 防御过度、意图模糊 |
| 8 | **三个布尔量控制事件顺序** | pi-agent-desktop 用 `pendingAgentEnd`/`suppressQueuedDispatchOnSettled`/`settled` 三个互相作用的标志控制 `agent_end`/`agent_settled`/队列的次序，过于微妙；应用**单调递增的 run 代数**替代 |
| 9 | **percho 的 `test` 脚本声明** | 声明了却不写测试，比不声明更糟（给出虚假安全感） |

---

## 5. 结论：Pi-My 的融合定位

**Pi-My 已有的优势应保留**：
- Tauri（体积/启动/内存）
- 皮肤系统（5 套设计令牌，两个参考项目都没有）
- 应用内 SDK 自更新（`loadPiSdk`，设计优于两者）
- 内置 `pi install` / OAuth，**无需全局 CLI**（两个参考项目都要求或依赖外部环境）
- 视觉桥 + 生图 + 桌宠 + 局域网观察（功能面最宽）

**该补的三件事**（按顺序）：
1. **稳定性**：事件瘦身（2.1）+ sidecar 自愈 + PTY 修复 → 让应用"不会坏"
2. **正确性**：权限引擎（2.2）+ 工具集语义 → 让 full 模式"敢用"
3. **防回归**：测试地基（2.3）→ 让后续所有改动"不会悄悄坏"

三者的具体落地计划见 `03-fusion-roadmap.md`。
