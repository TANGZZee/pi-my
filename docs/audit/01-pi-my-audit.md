# Pi-My 自身审计报告（BUG / 不合理设计 / 优化点）

- **审计对象**：`D:\Project\Pi-My\PI`（v0.2.10，Tauri 2 + Svelte 5 + Node sidecar）
- **审计基线**：commit `a972239`，工作区干净（`git status` 为空）
- **复核方式**：通读全部源码（`PI/src/*.svelte`、`PI/src/*.ts`、`PI/sidecar/*.mjs`、`PI/src-tauri/src/lib.rs`、`PI/scripts/*`），并对 SDK 类型定义逐条比对
- **重要澄清**：仓库根目录（`D:\Project\Pi-My\src`、`src-tauri`、`sidecar`）是**已废弃的旧原型**，实际项目在 `PI/` 子目录。本报告只针对 `PI/`。

---

## 0. 执行摘要

Pi-My 的**功能面已经相当宽**（皮肤系统、权限三模式、子代理、商店生态、OAuth 登录、用量统计、局域网观察、桌宠、生图、视觉桥、SDK 自更新），很多能力甚至超出两个参考项目。但工程底子薄，问题集中在三类：

| 类别 | 数量 | 最严重的一条 |
|---|---|---|
| **P0 正确性 BUG** | 6（+1 补充发现） | `message_update` 未瘦身 → 流式期 IPC 载荷平方放大（percho 曾因此 3 分钟产出 12.7GB trace 并压爆渲染进程） |
| **P1 结构性问题** | 7 | 零测试 / 零 lint / 零 typecheck，而参考项目有 100 个测试文件 |
| **P2 优化点** | 9 | 单 chunk 1.12 MB、markdown 每个 delta 全量重渲染 |

**一句话结论**：Pi-My 的问题不是"功能不够"，而是**没有把 SDK 的真实契约当回事**（P0 全部源于此）+ **没有任何回归防线**（P1 的根因）。

**两个最重要的发现**（都来自"去看 SDK 到底提供了什么"）：

1. **SDK 自带官方事件瘦身函数 `toJsonEvent`**（`dist/modes/json-event.js`，29 行），官方 RPC 出口已在用（`rpc-mode.js:266`）。Pi-My 绕开官方出口自建订阅，才丢掉这层保护 → **P0-1 是"回归正轨"，不是"发明优化"。**
2. **SDK 主入口已导出 `RpcClient` / `runRpcMode`**，其能力在 11 个方面强于 Pi-My 手写的协议层（瘦身、进程退出清 pending、`waitForIdle`、可用思考档位、`getCommands`、`getTree`、`compact`、`exportHtml`、扩展 UI 桥、扩展错误上报、背压）。**但不建议整体替换**（单进程单会话 + 会丢掉 Pi-My 独有的文件/Git/商店/生图能力）→ 见 P0-1b。

> 这两点说明：**先读 SDK 的公开接口，再动手写**。参考项目（尤其 pi-agent-desktop）在同类问题上吃过亏（issue #14 打包缺依赖、#21 key 只存内存、"适配不过来"），而 Pi-My 目前的问题多数本可以避免。

---

## 0.1 P0-A 实施与独立审查记录（已完成）

**实施内容**：新增 `PI/sidecar/event-slim.mjs`（纯函数，零依赖）；`index.mjs` 的内联 `summarizeEvent` 改为导入；新增 `PI/tests/event-slim.test.mjs`；`package.json` 加 `test`/`prepare:dev` 脚本；`prepare-resources.mjs` 加**产物 import 自检**与 `--sidecar-only` 模式；`tauri.conf.json` 的 `beforeDevCommand` 接入 sidecar 同步。

**两位独立审查员（不同切入角度）的结论与处置**：

| 审查员 | 结论 | 该审查员发现的真问题 | 处置 |
|---|---|---|---|
| 正确性/数据丢失 | 有条件合入 | ✅ **测试阈值脆弱**：`perEvent < 300` 测的是"当前实现的字节数"而非不变量；SDK 真实 `usage` 含 `cost` 时单事件可达 285B，余量仅 5% | ✅ 改为不变量断言（体量与累积长度无关）+ 补 3 条测试 |
| 正确性/数据丢失 | 同上 | ✅ **验收基线口径错误**：被删的内联版**已剥 `partial`**，真实基线是 10.18MB 而非 20MB，降幅 94.7% 而非 98.5% | ✅ 已按真实基线重写并标注更正 |
| 正确性/数据丢失 | 同上 | ✅ **顶层 `text` 是死载荷**（零消费者），且 `thinking_end` 时语义错位，让事件体量翻倍 | ✅ 已删除该别名 |
| 正确性/数据丢失 | 同上 | ✅ 变异测试 3 个存活：降级丢 `contentIndex`、不告警、死载荷 | ✅ 补测试后 **3 个全部被杀死** |
| 打包/运行时/性能 | 有条件合入 | ✅ **新文件未入 git → 干净克隆构建出无法启动的安装包** | ✅ 已 `git add`（并把自检加入构建脚本） |
| 打包/运行时/性能 | 同上 | ✅ **`tauri dev` 加载旧 sidecar 副本**，改动在 dev 下不生效（静默验证失效） | ✅ 加 `--sidecar-only` + 接入 `beforeDevCommand` |
| 打包/运行时/性能 | 同上 | ✅ **`agent_end.messages` 是第 5 个 toolResult 载体**（注释误写"四份"），累积整个 run，实测 20 张图单行可达 20MB | ✅ 已加瘦身分支 + 测试 |
| 打包/运行时/性能 | 同上 | ✅ 独立复现 -98.5%（相对无瘦身基线） | 已按正确基线更正为 94.7% |

**审查员确认无误的关键点**（含其实测）：
- 瘦身逻辑**无数据丢失**：逐个字段核对了全部下游消费者
- **输入不可变**：所有 6 类事件的输入对象均未被就地改写 —— 这点很关键，SDK 在 `_emit()` **之后**才用 `event.message` 做持久化，就地改写会污染会话历史
- `toolcall_start` 取工具名的正确性：逐一核对了 **全部 7 个 provider** 的发射点，全部"先 push 块再用该块索引发射"，故恒能取到
- 官方 `toJsonEvent` 确实未从主入口导出（`ERR_PACKAGE_PATH_NOT_EXPORTED`），内联理由成立
- 性能**净改善**：高频路径 `message_update` 快约 20×（3.3µs vs 65µs）；`tool_execution_update` 在小结果时慢 4.5µs，但该路径受 SDK 节流限制最多 10 次/秒（≈45µs/秒），且一旦超过 16KB 阈值立即转为净收益

**未闭合项（已知，非本次阻塞）**：
1. **无真实 LLM 端到端流式验证** —— 环境里 provider 返回 402（余额不足），无法产生真实 `message_update`。已做的替代验证：真实 sidecar 进程启动 + `init` 成功、打包产物用真实 `node.exe` 加载成功、模块身份与行为实测（5245B → 145B）。
2. 真实 agentic run 的降幅只有 ~65%（vs delta 场景的 94.7%），因 `message_end(assistant)`、`tool_execution_start.args`、`turn_end.message` 仍原样携带。后续可优化（估计能把降幅推向 90%+）。
3. `setWarnHandler` 是可被覆盖的模块级可变状态；当前无风险，建议未来改为参数注入。

---

## 0.2 P0-B/C/D/F 实施与独立审查记录（已完成）

**实施内容**：
- **P0-B** sidecar 崩溃自愈 + 请求 id 归属（`lib.rs`：`RestartTracker` 限次重启、id 不再被 Rust 覆盖、`sidecar-restarted`/`sidecar-failed` 事件）
- **P0-C** PTY 跨块 UTF-8 解码（`lib.rs`：`take_valid_utf8` + 1MiB 内存护栏）
- **P0-D** 终端常驻挂载 + Windows 进程树清理（`App.svelte`、`Terminal.svelte`、`kill_pty_tree`）
- **P0-F** 按请求类型分档的超时（`rpc-policy.ts`，72 种类型全登记）+ 可测的重启分区逻辑

**审查员发现的真问题（全部已修复）**：

| 严重度 | 问题 | 处置 |
|---|---|---|
| 🔴 | **`abandoned` 未声明** → 每次重启抛 `ReferenceError`，导致"已自动重启"通知永不显示 | 改用 `aborted.length`；已确认产物中无该标识符 |
| 🔴 | **`take_valid_utf8` 单次只消费一批非法字节** → GBK/二进制输出下每块只前进 1 字节，1MB 输入只吐出 17 字符且**缓冲无界增长 + O(n²)**。这是**我引入的回归**（旧实现虽然乱码但不积压） | 改为循环消费全部可判定字节；加 1MiB 护栏 + 分块兜底冲刷；补 6 条边界测试（连续非法字节/GBK/二进制/内存有界） |
| 🔴 | **OAuth 登录死锁**（既有）：`oauth_login` 串行 await 用户授权，而 `login_prompt_response` 也走同一串行循环 → 永远排不上队，sidecar 从此不再响应任何请求（进程还活着，P0-B 自愈覆盖不到） | 把 `oauth_login` 摘出串行循环（`NON_BLOCKING_REQUESTS`）；`handle` 自带 try/catch 与 reply |
| 🟠 | **`onMount(async () => {...})` 的清理函数从不注册**（既有）：Svelte 只在回调返回 `function` 时注册，async 返回的是 Promise → `pty_kill`/`unlisten`/`dispose` 全部失效。**我之前的注释还声称修好了它** | 两个组件都改为同步外壳 + 内部 IIFE；已用 Svelte 编译器验证产物中存在同步 `return () => {...}` |
| 🟠 | **正则提取请求类型 `[a-z_]+` 不含数字** → 新增 `fetch_models_v2` 这类命名会**静默漏报**（正是测试想防的场景） | 放宽为 `[\w-]+`，并同时支持 `else if` / `switch case` / 双引号 |
| 🟡 | 终端常驻挂载放到 `.workspace-content` 外 → 成为 `.workspace` 第 3 个 grid item，撑出隐式列 | 移入 `.workspace-content` 内部；已用 DOM 层级检查确认嵌套深度正确 |
| 🟡 | `patchSlot(..., { file: undefined } as never)` 向不存在的字段写入 | 删除该无效写入 |

**审查员确认无误的关键点**：
- **无锁顺序反转/死锁**：唯一多锁嵌套是 `state → stamps`，`RestartTracker` 从不反向取锁；`emit` 前已 `drop(guard)`
- **双重 settle 守卫有效**（实测 `resolve` 恰好调用一次）
- **遍历中修改 Map 安全**（先收集 survivors 再 clear 重建）
- **前端 id 归属必然一致**（Rust 仅在前端缺失 id 时回退；sidecar 原样回传）
- **`keepId` 时序正确**（Rust 先 write 再 emit；连理论竞态都无害）
- **`RestartTracker` 窗口语义正确**、`Instant` 单调不受改时影响
- 策略表 **72/72 覆盖**，前端实际发送的 66 种类型 **0 个未登记**

**仍未闭合**：
1. 无真实 GUI 端到端验证（无法在本环境启动 Tauri 窗口交互）——`kill_pty_tree` 的实际杀树效果、终端布局视觉表现均未真机验证
2. **无 typecheck / lint**（项目无 `typescript`、无 `svelte-check`、无 `tsconfig.json`）——这正是 `abandoned` 能进入产物的根因。**建议引入 `svelte-check` 或 `tsc --noEmit`**；本次未安装新依赖（未获授权）
3. `Terminal.svelte` 的 `disposed` 标记现已真正生效，但其"创建过程中被卸载"路径无自动化测试

---

## 1. 架构与数据流（现状事实）

```
Svelte 前端 (PI/src)
  │  invoke('agent_request', {request:{id,type,payload}})   ← 唯一的请求出口
  │  listen('agent-message')                                ← 唯一的事件入口
  ▼
Tauri Rust (PI/src-tauri/src/lib.rs)
  │  stdin 写一行 JSON / stdout 读一行 JSON（NDJSON，按 id 关联）
  ▼
Node sidecar (PI/sidecar/index.mjs, 1136 行)
  │  内嵌 Pi SDK：createAgentSession + DefaultResourceLoader
  ▼
~/.pi/agent/sessions/**/*.jsonl
```

**关键事实**：

- 前端只有 **2 个** `invoke` 命令面（`agent_request`、`pty_*`），所有 sidecar 请求都走 `agent_request` 一个通道（`PI/src/App.svelte:1160`、`:1171`）。sidecar 侧目前有 **60+ 种**请求类型（`PI/sidecar/index.mjs:745-1175`），但**没有类型契约文件**，全靠字符串字面量。
- 事件流是**逐条转发的原始 SDK 事件**（`lib.rs:132-142` → `App.svelte:1186-1264`），没有中间 reducer 层、没有瘦身层。
- 会话状态分两处：前端 `runState: Record<string, RunSlot>`（`App.svelte:78`）+ sidecar `sessions: Map`（`index.mjs:18`）。**两者没有版本号/序号做一致性校验**。

---

## 2. P0 正确性 BUG（按严重度排序）

### P0-1 🔴 `message_update` 未瘦身：流式期 IPC 载荷爆炸

**证据**

SDK 的 `message_update` 事件同时携带**两份全量累积快照**：

```ts
// PI/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:597-601
export interface MessageUpdateEvent {
    type: "message_update";
    message: AgentMessage;                    // ← 全量累积快照（第二份）
    assistantMessageEvent: AssistantMessageEvent;   // ← 内含 partial 全量快照
}
```

`AssistantMessageEvent` 的每个 delta 分支都带 `partial: AssistantMessage`（`pi-ai/dist/types.d.ts:410-455`），即**每收到一个 token，就附带一份"到目前为止的完整回复"**。

而 Pi-My 的 `summarizeEvent` 只**改写了子字段**，顶层 `message` 与 `assistantMessageEvent.partial` 全部原样透传：

```js
// PI/sidecar/index.mjs:105-111
function summarizeEvent(event) {
  const copy = { ...event }                    // ← 浅拷贝，message/partial 仍是全量引用
  if (copy.type === 'message_update' && copy.assistantMessageEvent) {
    const inner = copy.assistantMessageEvent
    return { ...copy, delta: inner.delta, text: inner.text, thinking: inner.thinking,
             assistantMessageEvent: { type: inner.type, delta: inner.delta, ... } }
             // ↑ 新对象只留了 4 个字段，但 copy.message 仍然是全量快照！
  }
  ...
}
```

**为什么是 BUG**：设回复最终长度 N，流式分 k 个 delta，则总传输量是 **O(N·k) = O(N²)**。

**实测复现（2000 个 `text_delta`，SDK 真实 `usage` 形状）**：

| 基线 | 体量 | 说明 |
|---|---|---|
| A. 无瘦身层（SDK 原始事件） | 20.16 MB | 理想参照 |
| **B. 改动前内联版** | **10.18 MB** | **本次改动的真实前状态**——它已剥掉 `partial`，但顶层 `message` 仍是全量快照 |
| C. 实施 P0-A 后 | 0.54 MB | 对 **B** 降 **94.7%**（19×） |

> ⚠️ **口径更正**：本报告初版曾称"500 个 delta 放大 22×（1096KB vs 50KB）""降幅 98.5%"。经独立审查指出，那两个数字的分母不可比（"50KB"是所有 delta 之和即有用内容，而非线上体量），且基线取的是"无瘦身层"而非真实的改动前状态。**正确结论是：对真实前状态降 94.7%，对无瘦身基线降 97.3%。**

percho 实测的事故是：**3 分钟 12.7GB trace / renderer 堆爆**（见其 `packages/backend/src/session/event-slim.ts:3-12`）。表现为：长回复时界面卡顿、内存飙升、甚至渲染进程崩溃。

**修复（最优解：直接照抄 SDK 自己的 `toJsonEvent`）**

⚠️ **重要发现**：SDK **已经自带**了这个瘦身函数，而且逻辑写在注释里，明确说明它就是为了解决同一个问题：

```js
// PI/node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js:16-28
export function toJsonEvent(event) {
    if (event.type !== "message_update") return event;
    if (event.message.role !== "assistant") {
        throw new Error("message_update message is not an assistant message");
    }
    return {
        type: "message_update",
        usage: event.message.usage,                              // ← 保留累积 usage（用量统计需要）
        assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
    };
}
```
```js
// 同文件 :1-15 —— 剥掉 partial，并把 toolcall_start 的 partial 提炼成 id/toolName
function toJsonAssistantMessageEvent(event) {
    if (event.type === "toolcall_start") {
        const toolCall = event.partial.content[event.contentIndex];
        if (toolCall?.type !== "toolCall") throw new Error(...);
        const { partial: _partial, ...deltaEvent } = event;
        return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
    }
    if (!("partial" in event)) return event;
    const { partial: _partial, ...deltaEvent } = event;
    return deltaEvent;
}
```
其官方注释（`json-event.d.ts:25-30`）写得非常清楚：

> *Remove cumulative assistant snapshots from streaming wire events. `message_start` provides the initial message, deltas build it, and `message_end` provides the final authoritative message. Cumulative usage, tool-call ids, and tool names remain available because their size is constant.*

**并且 SDK 的 RPC 模式已经默认启用了它**：

```js
// PI/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:266
unsubscribe = session.subscribe((event) => {
    output(toJsonEvent(event));      // ← 官方 RPC 出口就在做瘦身
```

**结论**：这不是一个"需要自己设计的优化"，而是 **Pi-My 用错了 SDK 的用法**——它绕开官方出口自己订阅了原始 `session.subscribe`，于是丢掉了官方已经处理好的瘦身。

**推荐做法（按优先级）**：

1. **首选**：在 `summarizeEvent` 里**照抄这 29 行逻辑**（它是纯函数，无依赖）。不要深路径 `import`，因为该模块**未从 package 主入口导出**（实测 `'toJsonEvent' in m === false`），而参考项目正因深路径 import 挨批。
   - 关键差异：照抄版要**额外保留 `usage`**（`sessionStats` 的用量统计依赖它），并把 `toolcall_start` 的 `partial` 提炼为 `{id, toolName}`。
   - 注意 `toolcall_start` 的校验会 `throw`——Pi-My 现在的代码是宽容的，移植时要决定是抛还是降级（建议降级为 `{type}` + 记日志）。
2. **同时**处理第二层：`tool_execution_end` / `message_start` / `message_end` / `turn_end` 的大 `result`（read 图片的 base64）会被**四份快照重复携带**（percho 实测 504KB × 4 ≈ 2MB/次）。SDK 的 `toJsonEvent` **不管这一层**，需自行按 percho 的 `slimBulkyEvent` 思路截断（文本保头 4KB、图片 data 换占位符，**`details` 一律不动**）。
3. **中期选项**：考虑是否迁移到 SDK 的 `RpcClient`（见 P1-2 的补充说明）。

**验收**：构造一次长回复，测 `agent-message` 事件总字节数，应接近 O(N) 而非 O(N²)；并断言瘦身后对象不含 `message` 与 `partial` 字段。

---

### P0-1b 🟡 补充发现：SDK 已提供 `RpcClient`/`runRpcMode`，Pi-My 手写了等价物但缺功能

**证据**：Pi-My 的 sidecar 用 `createAgentSession` + 自建 NDJSON 协议（1136 行）。而 SDK **已经提供了一个完整的、类型安全的内嵌客户端**：

```ts
// PI/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts —— 主入口导出
export { RpcClient, runRpcMode, type JsonAgentSessionEvent, type RpcCommand, ... }
```

实测可从主入口导入：
```
node -e "import('@earendil-works/pi-coding-agent').then(m=>console.log(Object.keys(m).filter(x=>/Json|Rpc/i.test(x))))"
→ ["RpcClient","runRpcMode"]
```

`RpcClient`（`dist/modes/rpc/rpc-client.d.ts`，254 行接口）提供的能力，**与 Pi-My 手工实现的重叠部分**：

| RpcClient 方法 | Pi-My 对应 | Pi-My 是否更好 |
|---|---|---|
| `prompt/steer/followUp` | ✅ 有 | 持平 |
| `abort` | ✅ 有 | 持平 |
| `getState` | ⚠️ 只有 `session_stats`，无完整状态 | **RpcClient 更全** |
| `setModel/cycleModel/getAvailableModels` | ✅ 有（无 cycle） | 持平/略优 |
| `setThinkingLevel/getAvailableThinkingLevels` | ⚠️ 无"当前模型可用档位"查询 | **RpcClient 更优**（Pi-My 硬编码 7 档） |
| `compact/setAutoCompaction/abortRetry` | ⚠️ 有 `/compact` 斜杠命令但未接线 | **RpcClient 更优** |
| `fork/clone/getForkMessages` | ✅ 有 `fork_session` | 持平 |
| `getTree/navigate` | ⚠️ 无 | **RpcClient 更优** |
| `getSessionStats` | ✅ 有 | 持平 |
| `exportHtml` | ⚠️ 只导出 JSON | **RpcClient 更优** |
| `setSessionName` | ✅ 有 | 持平 |
| `getCommands`（扩展命令/skill） | ⚠️ 无 | **RpcClient 更优** |
| `waitForIdle` | ❌ 无（靠前端看门狗猜） | **RpcClient 更优** |
| 事件瘦身 | ❌ 无 | **RpcClient 更优** |
| 扩展 UI 桥（`extension_ui_request`） | ❌ 无 | **RpcClient 更优** |
| `extension_error` 上报 | ❌ 无 | **RpcClient 更优**（percho issue #32 正是"零线索"） |
| stdout backpressure | ❌ 无 | **RpcClient 更优** |
| 进程退出时 reject 所有 pending | ❌ 无（见 P0-6） | **RpcClient 更优** |
| 请求 id 管理 | ⚠️ 前端/Rust 两套计数器（见 P0-6） | **RpcClient 更优** |
| 文件读写 / Git / 商店 / 生图 / 视觉桥 / 局域网 / 桌宠 / SDK 自更新 | ✅ Pi-My 独有 | **Pi-My 更优** |

**结论**：**不建议整体替换**（会丢掉 Pi-My 独有的文件/Git/商店/生图等一大半能力，且 RPC 每个进程只管理一个会话，与 Pi-My 的多会话 `Map` 模型不符）。但**强烈建议借鉴它的这几处**：

1. **事件瘦身**（即 P0-1）
2. **退出时拒绝所有 pending 请求**（`rpc-client.js:431-436` `rejectPendingRequests`）——正对 P0-6
3. **`extension_ui_request` / `extension_ui_response` 桥**——正对 P2-B
4. **`extension_error` 上报**——把扩展异常暴露到 UI，而不是静默吞掉
5. **`waitForIdle`**（等 `agent_settled`）——比现在的 3 分钟看门狗可靠
6. **`getAvailableThinkingLevels`**——不要硬编码 7 档（`App.svelte:162` 的 `THINKING_LEVELS` 对所有模型一视同仁，而不同模型支持档位不同）
7. **`getCommands`**——让 `/` 命令面板列出扩展命令与 skill，而不是硬编码 10 条（`App.svelte:1900-1911`）

> **如果未来要重写 sidecar**：可以考虑"用 `RpcClient` 托管 Agent 会话 + 自建的非 Agent 能力（文件/Git/商店）保留为独立请求类型"的混合架构。但这属于中长期重构，不建议在 P0 阶段做。

---

### P0-2 🔴 `set_mode` 会静默重置会话工具集，且 plan 模式丢失只读工具

**证据**

```js
// PI/sidecar/policy.ts:7-19
export const PLAN_TOOLS = ['read', 'grep', 'find', 'ls']
export function effectiveToolsForMode(mode, sessionTools) {
  if (mode === 'plan') return PLAN_TOOLS
  return sessionTools          // ← ask/full 返回传入集合
}
```

```js
// PI/sidecar/index.mjs:62
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']   // ← 缺 grep/find/ls

// PI/sidecar/index.mjs:954-963
if (type === 'set_mode') {
  entry.mode = payload.mode
  entry.session.setActiveToolsByName(effectiveToolsForMode(payload.mode, DEFAULT_TOOLS))
}
```

**三处问题**：

1. **从 plan 切回 ask/full 后，工具集被重置为硬编码的 4 个**，用户在 SDK 侧配置过的工具（如 MCP 工具、自定义工具）**永久丢失**，直到会话重建。
2. **plan 模式下 `grep/find/ls` 实际不可用**——`PLAN_TOOLS` 声明要它们，但会话创建时若走 `createSession(mode='ask')` 再 `set_mode('plan')`，`setActiveToolsByName` 请求的 `grep/find/ls` 可能根本不在 SDK 的注册表里（取决于 SDK 是否内置这些名字），属于**靠字符串巧合工作**。
3. `set_mode` **不校验会话是否存在**：`if (entry)` 为空时直接回 `{mode}` 成功，前端以为切换生效了。

**修复**：保存会话原始工具集快照，切换时以"原始集 ∩ 模式允许集"计算，而不是硬编码常量。

```js
// 会话创建时记录
entry.baseTools = session.getActiveToolNames()   // SDK 公开 API
// 切换时
const next = entry.mode === 'plan'
  ? entry.baseTools.filter(n => PLAN_TOOLS.includes(n))
  : entry.baseTools.filter(n => !modeDisabled(entry.mode, n))
entry.session.setActiveToolsByName(next)
```

同时 `set_mode` 应返回 `{ ok:false, reason:'会话不存在' }` 而非伪造成功。

**参考**：percho 的 `toolNamesForPreset` + `effectiveToolsForMode` 是纯函数，且 `set_tools` 走 `get_tools` 拿真实注册表（`permissions` 与 `gate.ts` 分离），不硬编码。

---

#### ✅ P0-2 修复记录（含一次自我推翻）

**实施过程中的关键实测发现**（推翻了最初的修复方案）：

1. **SDK 的注册表在创建时就被永久裁剪**。实测：`createAgentSession` 不传 `tools` 时，SDK 内置注册 **8 个**工具（`read`/`bash`/`powershell`/`edit`/`write`/`grep`/`find`/`ls`），再叠加用户已装扩展注册的工具；传了 `tools` → 注册表被裁剪成该列表，且 `getAllTools()` **之后也只反映裁剪结果**。
   > ⚠️ 更根本的发现：`tools:` 白名单会把**扩展/MCP 工具一并过滤掉**。所以在 Pi-My 里，扩展工具从来就不在注册表中（这也是为什么"避免抹掉 MCP 工具"这个说法不成立——P0-2 的真实受害者只有 `bash/edit/write` 与 `grep/find/ls`）。
2. **第一版修复有漏洞**（自查时发现）：我原本用"累积 `getAllTools()` 结果"当基准。但如果会话**在 plan 模式下创建**，创建时传的就是 `PLAN_TOOLS`，累积基准里根本没有 `bash` → 切到 ask/full **永远拿不回来**。实测确认：
   ```
   在 plan 中创建 -> 切 ask: ["read","grep","find","ls"]    ← 拿不回 bash！
   ```
3. **最终方案**：创建时注册**并集** `BASE_TOOLS`（核心集 ∪ 只读集），plan 的只读限制改由**创建后** `setActiveToolsByName` 施加。这样注册表始终完整，任何初始模式都能**双向**切换。

**实测验证**（三种创建模式 × 双向切换）：

| 创建模式 | 切 plan | 切 ask | 有 bash | 有 grep |
|---|---|---|---|---|
| ask | 4 个只读 | 7 个 | ✅ | ✅ |
| plan | 4 个只读 | 7 个 | ✅ | ✅ |
| full | 4 个只读 | 7 个 | ✅ | ✅ |

**顺带修掉的一个更严重的 BUG**（不在原审计里）：`openSession`（重新打开已有会话）**没传 `resourceLoader` / `extensionFactories`** → **重开的会话丢失审批扩展**，即 ask 模式的高危工具确认**静默失效**（用户以为还在确认，实际全放行）。已改为与 `createSession` 一致，并实测重开后工具数为 7、与新建一致。
`forkSession` 也有同源的"按模式裁剪"缺陷，一并改为并集 + 创建后收紧。

**新增测试**：`PI/tests/policy.test.mjs`（14 条），覆盖双向切换、`BASE_TOOLS` 无重复、`plan` 中创建的会话切 ask 能拿回 `bash`（即上述漏洞的回归保护）。

#### ✅ 独立审查（第 5 位审查员）追加发现的 3 个真实缺陷

审查员用真实 spawn + 变异测试独立复核后，又找出 3 个我漏掉的问题，**全部已修**：

| 严重度 | 问题 | 后果 | 处置 |
|---|---|---|---|
| 🔴 **安全** | **`forkSession` 对象身份分裂**（`index.mjs:459` vs `:486`）：审批扩展闭包捕获的是 `entry`，而 `sessions.set` 存的是**另一个字面量对象** → 扩展读到的 `mode` 永远停在 fork 时的值 | 从 `full`/`plan` 分叉出的会话切到 `ask` 后，`bash/edit/write` **不弹确认框直接执行**——用户以为有逐次确认 | 改为 `Object.assign(entry, ...)` + `sessions.set(id, entry)`，三处会话创建路径现在身份一致 |
| 🔴 **安全/UX** | **`openSession` 硬编码 `DEFAULT_MODE`** 且不回传 `mode` | 用户处于 plan 时打开别的会话再切回（或侧车重启 rebind），sidecar 实际变成 ask、写工具全开，而 UI 仍显示"计划模式：只能读和搜索" | `openSession(id, file, requestedMode)` 接受并沿用请求模式，返回值带上 `mode`；前端两个调用点传入当前模式并据此校正 UI |
| 🟠 健壮性 | `toolsForModeSwitch` 在基准为空时返回 `[]` | 探测失败时 agent **什么工具都没有**（比旧实现更糟） | 空/非法基准退化为 `BASE_TOOLS`，并补测试 |

另删除了两处死代码（`creationToolsForMode`、`isReadOnlyTool`——只有测试引用、生产零调用），并修正了一处与实测不符的注释。

**审查员的独立实测纠正了我的一个错误归因**：我曾说"SDK 默认注册 25 个内置工具"，实测 SDK 内置只有 **8 个**（read/bash/powershell/edit/write/grep/find/ls），那个 25 = 8 + 我本机已装的 17 个扩展工具。已按事实修正文档。

**新增集成测试**（`PI/tests/sidecar-integration.test.mjs`，6 条）：真实 spawn sidecar 用 NDJSON 驱动，覆盖模式切换、`plan` 中创建、不存在的会话、`open_session` 的 mode 往返。这填补了审查员指出的关键盲区——上述三个缺陷**纯函数单测一个都抓不到**，只有真跑 sidecar 才暴露。已用变异测试验证该套件确实能抓到 `openSession` 的 mode 丢失。

**审查员确认的部分**：12 个变异体全部被纯函数测试捕获；P0-2 核心缺陷独立复现确认已修（`HEAD` 版 `plan→ask` 只剩 `read`，当前版恢复全部工具）。

---

### P0-3 🔴 文件监听/终端在面板切换时泄漏（PTY 进程堆积）

**证据**

```svelte
<!-- PI/src/App.svelte:2306-2307 -->
{:else if panel === '终端'}
  <Terminal visible={panel === '终端'} />
```

```ts
// PI/src/Terminal.svelte:17-49
onMount(async () => {
  ptyId = await invoke<number>('pty_spawn', { shell })    // ← 每次都真的开一个 shell
  unlisten = await listen('pty-output', ...)              // ← 每次都注册一个全局监听
  return () => {
    if (ptyId !== undefined) void invoke('pty_kill', { id: ptyId })   // ← 异步，不 await
    unlisten?.()
  }
})
```

**为什么是 BUG**：`{#if}/{:else if}` 每次切走再切回都会**销毁并重建** `Terminal` 组件，即每切一次面板就 `pty_spawn` 一个新 shell 并 `pty_kill` 旧的。

- `pty_kill` 是 `void`（不 await）且 Rust 侧 `pty_kill` 只调 `child.kill()`（`lib.rs:249-255`），**没有等待进程真正退出**；Windows 上 `cmd.exe` 常有子进程残留 → **孤儿进程堆积**。
- `unlisten` 在 `await listen(...)` 完成前若组件已销毁，`unlisten` 仍是 `undefined`，**监听器永久泄漏**（每次切换泄漏一个）。`listen` 是异步的，切面板比它快就会踩中。
- 终端**不保留历史**：切走再回来是一个全新 shell，用户之前的工作目录、正在跑的命令全部丢失。

**修复**（三选一，推荐 1+3）：
1. 用 `{#if}` 改成**常驻挂载 + CSS 隐藏**（`display:none`），组件不销毁，PTY 不重开。
2. 组件内加"单例守卫"，避免并发 spawn。
3. Rust 侧 `pty_kill` 改为等待退出 + 杀进程树（Windows `taskkill /PID x /T /F`，percho 就是这么做的：`electron/process-tree.ts`）。

---

### P0-4 🟠 sidecar 崩溃后**永久失能**，无法自动恢复

**证据**

```rust
// PI/src-tauri/src/lib.rs:167-179
fn agent_request(state: State<'_, Mutex<Option<Sidecar>>>, request: Value) -> Result<u64, String> {
    let instance = sidecar.as_mut().ok_or("Pi Agent 尚未启动")?;   // ← 一旦为 None 就永远报错
```
```rust
// PI/src-tauri/src/lib.rs:263-274 —— 启动失败时 manage(None)，之后没有任何重试路径
Err(error) => { ...; app.manage(Mutex::new(None::<Sidecar>)); }
```
```rust
// PI/src-tauri/src/lib.rs:138-141 —— 子进程退出只发一条前端提示，不重启
let _ = handle.emit("agent-message", json!({ "type":"event", "event":{"type":"error","message":"Pi Agent sidecar 已退出"} }));
```

**为什么是 BUG**：sidecar 是**唯一**的 Agent 通道。它一旦因为 OOM、未捕获异常、或 `node` 被外部杀掉而退出，`Sidecar.child` 仍留着已死进程的句柄，`stdin` 写入会失败；即使用户点"重试"也没有任何重建路径。**整个应用必须重启**。参考项目对此都有明确的恢复策略（pi-agent-desktop 有 `getNextRestartState` 60 秒窗口内限次重启，percho 有 single-flight + stream-guard）。

**修复**：在 `agent_request` 检测写入失败/`try_wait()` 非空时**惰性重启** sidecar，并给一个 5 秒窗口内的重启限次（防崩溃循环）。

---

### P0-5 🟠 PTY 输出按 8KB 切块做 `from_utf8_lossy`，中文会被打碎成 `�`

**证据**

```rust
// PI/src-tauri/src/lib.rs:216-222
let mut buffer = [0u8; 8192];
match reader.read(&mut buffer) {
    Ok(length) => {
        let data = String::from_utf8_lossy(&buffer[..length]).to_string();  // ← 块边界可能切在多字节字符中间
        let _ = handle.emit("pty-output", json!({ "id": id, "data": data }));
```

**为什么是 BUG**：`read` 的返回长度与 UTF-8 字符边界**无关**。一个 3 字节的中文字符若正好跨在两次 `read` 之间，两次 `from_utf8_lossy` 都会把它替换成 `U+FFFD`（`�`）——**字符永久损坏，无法通过重新拼接恢复**。中文 Windows 上命令行输出中文、`git log` 中文提交信息、`npm` 中文错误都会随机出现乱码，且难以复现。

**修复**：保留跨块的**尾字节缓冲**，只在确认是完整 UTF-8 序列时才解码。

```rust
let mut pending: Vec<u8> = Vec::new();
// ... read 后 pending.extend_from_slice(&buffer[..length]);
// 求出 pending 中最大的合法 UTF-8 前缀长度 valid，emit pending[..valid]，保留 pending[valid..]
// 用 std::str::from_utf8(&pending).err().map(|e| e.valid_up_to()) 得到 valid
```

**参考**：pi-agent-desktop 用 SSE + `TextEncoder`，天然按字符处理，不存在此问题。

---

### P0-6 🟠 请求超时后 `pending` Map 泄漏，且响应可能错配

**证据**

```svelte
<!-- PI/src/App.svelte:1157-1166 -->
function request(type: string, payload = {}) {
  const id = ++requestSequence
  const promise = new Promise<unknown>((resolve) => pending.set(id, (res) => resolve(res.result)))
  void invoke('agent_request', {...}).catch((error) => {  // ← 只处理 invoke 失败
    const resolve = pending.get(id); pending.delete(id); resolve?.(...)
  })
  return promise
}
```

**两处问题**：

1. **没有超时**：若 sidecar 收到请求但从不回包（例如 `handle()` 里有一个永不 resolve 的 `await`，如 `prompt` 挂住的扩展钩子），`pending[id]` **永久泄漏**，且 `request()` 返回的 Promise 永不 settle → 调用方 `await` 永远挂起（`openSettings` 会一直转圈）。
2. **`requestSequence` 与 Rust 侧的 `next_id` 是两套独立计数器**（`App.svelte:173` vs `lib.rs:171-172`）。Rust 会在写入时**覆盖** `message["id"]`（`lib.rs:174`）。正常情况下两者从 1 同步递增，但**sidecar 重启后 Rust 的 `next_id` 重置为 1**，而前端 `requestSequence` 继续递增——此后前端发出的 id 与 sidecar 回包的 id **对不上**，所有 `request()` 全部永久挂起（前端表现为"卡死，什么都不响应"）。这是 P0-4 的连锁后果，但即使重启逻辑修好，也必须解决 id 归属问题。

**修复**：
- `request()` 加超时（如 30s）与 `finally` 清理，超时 reject 并在 UI 提示。
- **让前端只做关联、Rust 只做透传**：Rust 不要改写 `id`，或在重连后**重置前端 `requestSequence`** 并清空 `pending`（全部 reject）。
- 更彻底：用 `crypto.randomUUID()` 作为请求 id，彻底消除两套计数器。

---

## 3. P1 结构性问题

### P1-1 🔴 **零测试、零 lint、零 typecheck**（最严重的结构问题）

**证据**

```
PI/package.json scripts = {"dev","build","prepare:runtime","preview","tauri"}
PI/src, PI/sidecar 下的 *.test.* / *.spec.* 文件数 = 0
```

对比：

| 项目 | 测试文件数 | lint | typecheck |
|---|---|---|---|
| Pi-My | **0** | 无 | 无（`lang="ts"` 但无 `tsc --noEmit`） |
| pi-agent-desktop | **100** | eslint | `npx tsc --noEmit` |
| percho | 0（但有 `biome check`） | biome | `typecheck --workspaces` |

**为什么最严重**：本节 P0/P1 的其他问题**全部本可被测试拦下**。`effectiveToolsForMode`、`summarizeEvent`/瘦身、`follow-up queue` 的 CAS、路径校验（`assertEcoTogglePath`/`readWorkspaceFile`）都是**纯函数**，单测成本极低。`pi-agent-desktop` 甚至用 `package.test.ts` **断言构建脚本内容**，让"删掉一个承重脚本"变成测试失败——这种防回归思路值得直接抄。

**修复**：引入 `node --test`（零依赖，Node 24 自带）。首批 5 个测试文件：
1. `policy.test.ts` —— 三模式工具集矩阵（含 plan→ask 往返、会话不存在分支）
2. `event-slim.test.ts` —— 瘦身后字段白名单、O(N) 字节数断言
3. `paths.test.ts` —— `readWorkspaceFile`/`writeWorkspaceFile`/`assertEcoTogglePath` 的越界与 Windows 盘符用例
4. `git.test.ts` —— `git_status` 解析（`Rename` 两列格式、带空格路径）
5. `queue.test.ts` —— 排队消息的 revision CAS 与重排校验

---

### P1-2 🔴 无类型契约：60+ 种 sidecar 请求全靠字符串

**证据**：`PI/sidecar/index.mjs:745-1175` 是一个约 **430 行的巨型 if-else 链**，判据是裸字符串；前端 `request(type: string, payload = {})` 的 `payload` 是隐式 `{}`。两端**没有任何共享类型**。

**后果**：改一个 payload 字段名，编译器不会报错；打错一个字（`'list_sesions'`）在运行时才炸，且错误信息只是 `未知 sidecar 请求: xxx`。

**修复**：建 `PI/shared/protocol.ts`，定义判别联合（discriminated union）：

```ts
export type Request =
  | { type: 'init'; payload: { cwd: string } }
  | { type: 'prompt'; payload: { sessionId: string; text: string; behavior?: 'steer'|'followUp' } }
  | { type: 'set_mode'; payload: { sessionId: string; mode: AgentMode } }
  // ...
export type Response<R extends Request = Request> = { id: number; ok: true; result: ResultOf<R> } | { id: number; ok: false; error: string }
```

前端与 sidecar 同时 `import type`，并加一个 `assertNever` 兜底。**注意**：sidecar 是 `.mjs` 直跑（`prepare-resources.mjs:35-49` 用 esbuild 编译 `.ts`），所以这个文件要能被 esbuild 处理，或写成 `.d.ts` 只做编译期约束。

---

### P1-3 🟠 `App.svelte` 2438 行单体组件

**证据**：`PI/src/App.svelte` 2438 行，包含：窗口标题栏、三个侧栏、会话树构建、分支导航、消息时间线、composer、模型/思考/模式下拉、权限确认卡、Git 面板、文件树、待办、子代理、登录弹窗、生图、桌宠挂载、7 个重复的 `clickOutside*` action。**`clickOutside`/`clickOutsideCtx`/`clickOutsideThinking`/`clickOutsideMode`/`clickOutsideKind`/`clickOutsideBranch`/`clickOutsideMore` 是 7 份逐字重复的代码**（`App.svelte:836-968`，约 130 行），只有开头的布尔变量名不同。

**修复**：
- 抽一个 `useClickOutside(node, { onOutside })` 通用 action，删掉约 110 行。
- 按域拆分：`ChatPane.svelte`、`Composer.svelte`、`SessionSidebar.svelte`、`WorkspacePane.svelte`、`ModelMenu.svelte`、`Timeline.svelte`。目标 App.svelte < 500 行。
- 把 `runState` 的状态迁移逻辑抽成纯函数模块 `run-state.ts`（percho 的 `reducer.ts` / pi-agent-desktop 的 `agent-event-apply.ts` 都是纯函数 + 副作用描述符，可单测）。

---

### P1-4 🟠 sidecar 与前端状态无一致性校验

前端 `runState[id]` 与 sidecar `sessions.get(id)` 是两份独立状态，靠事件流"尽力同步"。典型失配场景：

- P0-6 的请求永久挂起 → 前端 `running: true`，sidecar 其实早已结束。
- `applySessionHistory` 有 `if (current.running || current.historyLoaded) return` 守卫（`App.svelte:373`），若首次加载时 `running` 恰好为真，**历史永久不加载**，界面空白。
- 前端有 3 分钟看门狗（`App.svelte:401-411`），但这是**猜测的超时**，不是真实状态。

**修复**：给会话加单调递增的 `runGeneration`（每次 `agent_start` +1）与 sidecar 侧的 `state` 查询请求；前端在可疑时主动 `get_state` 对账。参考 pi-agent-desktop 的 `peekState()`/`get_state` 双入口设计。

---

### P1-5 🟠 权限拦截依赖可被"合法绕过"的字符串匹配

**证据**

```ts
// PI/sidecar/policy.ts:9
export const CONFIRM_TOOLS = ['bash', 'powershell', 'edit', 'write']
```
```ts
// PI/sidecar/approval-extension.ts:14-23
pi.on('tool_call', async (event) => {
  if (!needsAskConfirm(deps.getMode(), event.toolName)) return undefined
  const ok = await deps.requestConfirm({ ... })
  if (!ok) return { block: true, reason: '用户拒绝了此操作' }
})
```

**问题**：
1. **只按工具名匹配**，不看参数。`bash` 一律弹窗（体验差），而**任何不在名单里的工具一律放行**——若扩展注册了 `shell`/`exec`/`write_file` 之类的工具，**ask 模式下直接静默执行**。
2. **plan 模式只用"减少工具集"实现**，并未拦截 `bash`（`PLAN_TOOLS` 不含 `bash`，但见 P0-2，`setActiveToolsByName` 的可靠性存疑）。一旦有工具漏网，plan 模式就形同虚设。
3. 没有 `deny` 档、没有"总是允许该模式"记忆、没有审计日志。

**修复 / 借鉴**：percho 的 `permissions/` 是本审计中**最值得整体移植**的模块：
- `pattern.ts`：`allow/ask/deny` × 通配模式，`*` 全局兜底，**后命中生效**；
- `bash-chain.ts`：引号感知切段 + `$( )`/反引号提取 + `sh -c`/`eval` 剥壳，**命令链取最严段** → `cd x && git push` 与 `echo $(rm -rf y)` 都无法绕过；
- `tmp-zone.ts`：临时区豁免（fail-safe，判不中就弹窗）；
- `gate.ts`：会话内"总是允许"（同 title 记忆）+ 项目级持久化。

即使不整包移植，**至少应把"按工具名"升级为"按工具名 + 参数模式"**，并补 `deny` 档。

---

### P1-6 🟠 打包链路脆弱且与开发环境不一致

**证据**

```js
// PI/scripts/prepare-resources.mjs:19-25
const candidates = ['D:\\Node\\node.exe', process.execPath]   // ← 硬编码本机路径！
```
```js
// PI/scripts/prepare-resources.mjs:71-85
if (!existsSync(sdkDist)) {
  await writeFile(path.join(resources, 'package.json'), JSON.stringify({
    dependencies: { '@earendil-works/pi-coding-agent': '0.85.1' }   // ← 版本硬编码
  }))
  execFileSync(npmCmd(), ['install', '--omit=dev', ...])
}
```

**问题**：
1. **硬编码 `D:\Node\node.exe`** —— 换台机器构建必然走 `process.execPath`，但那可能是 `electron.exe` 或 nvm 的 node，行为不一致。这是纯粹的"能在我机器上跑"。
2. **SDK 版本三处硬编码**：`package.json`（`^0.85.1`）、`prepare-resources.mjs`（`0.85.1`）、以及运行时自更新逻辑依赖 npm 语义。三者会漂移。
3. **88.5 MB `node.exe` 每次打包复制**，`resources/node_modules` 全量复制，制作耗时与安装包体积都很大。
4. **`resources/` 全部被 `.gitignore`**（`PI/.gitignore:4-9`）→ **CI 无法从干净检出构建**，克隆仓库后 `npm run tauri build` 必然失败（因为 `resources/sidecar`、`node_modules` 都不在）。
5. **`prepare-resources.mjs` 把 `.ts` 编译成 `.js` 再字符串替换 import**（`:35-57`），脆弱且无测试。pi-agent-desktop 的 `package.test.ts` 正是为了防这类"承重脚本被误删"。

**修复**：
- 用 `process.execPath` 为主，`D:\Node\node.exe` 只作为可选覆盖（或读环境变量 `PI_MY_NODE`）。
- SDK 版本单一来源：从 `package.json` 读，注入到生成的 `resources/package.json`。
- 明确"首次构建需联网下载 node + SDK"的文档，或提供 `resources/.gitkeep` + 预检脚本给出清晰报错。
- 给 `prepare-resources.mjs` 加减法自检（如：产物存在性、版本一致性），并加进测试。

---

### P1-7 🟠 版本号混乱 + README 与实现不符

**证据**

| 声明处 | 版本 |
|---|---|
| `PI/package.json` | `0.2.10` |
| `PI/src-tauri/Cargo.toml` | `0.2.10` |
| `PI/src-tauri/tauri.conf.json` | `0.2.10` |
| `PI/README.md:75-76` | `Pi-My_0.1.0_x64-setup.exe` / `.msi` |
| 仓库根 `package.json` | `0.1.0` |

**问题**：三个 `0.2.10` 一致（好消息），但 README 的**下载文件名与安装包类型都是错的**——`tauri.conf.json` 只有 `windows.nsis.installerHooks`，**没有配 MSI**（虽然 `targets: "all"` 会尝试生成，但 README 承诺的 `.msi` 与 `_0.1.0_` 命名未经验证）。README 还宣称 Tauri 徽章但未提 Tauri 版本。

**修复**：README 的安装包表格改为从实际 `target/release/bundle/` 产物生成，或在 CI 中校验。版本号用脚本单点同步（`tauri.conf.json` 支持从 `package.json` 继承）。

---

## 4. P2 优化点

| # | 问题 | 证据 | 优化收益 |
|---|---|---|---|
| P2-1 | **markdown 每个 delta 全量重渲染** | `MarkdownView.svelte:8` `$: html = renderMarkdown(text)` + `markdown.ts:47` 每次从头解析整个字符串 | 长回复时 O(N²) CPU；应改为增量/分块渲染，或对未变化的行缓存（percho/pi-agent-desktop 都用了"消息固化 + 流式尾部单独渲染"） |
| P2-2 | **单 chunk 1.12 MB（gzip 320 KB）** | `npm run build` 输出 | 无 code-split；xterm、pixi.js、Live2D 全打进主包。应按需动态 `import()` |
| P2-3 | **7 份重复的 clickOutside action** | `App.svelte:836-968`，约 130 行 | 抽 1 个通用 action，删 ~110 行 |
| P2-4 | **`runState` 整体替换触发全量重算** | `App.svelte:437` `runState = {...runState, [id]: {...}}` | 每个 delta 都重建整个 map，会话多时开销大；应用 `$state` 细粒度或 Map |
| P2-5 | **文件树每次渲染过滤全表** | `App.svelte:247-253` `treeChildren` 是 O(n) 且对每个节点调用 | 文件多时 O(n²)；建一次前缀索引 |
| P2-6 | **`loadFiles` 递归无并发控制** | `index.mjs:460-475` 上限 400 条/深度 6 | 大仓库截断且无提示；应做增量/懒加载 |
| P2-7 | **`sessionStats` 每次遍历全部消息** | `index.mjs:578-610` | 每次 `refreshCtxStats` 都 O(消息数)；应增量累加 |
| P2-8 | **错误处理大量静默 `catch {}`** | 如 `App.svelte:1298-1300`、`index.mjs` 多处 | 用户遇到问题时零线索（percho issue #32 正是"扩展内部异常宿主日志零线索"） |
| P2-9 | **无 i18n** | 全中文硬编码 | 若要国际化需先抽文案；pi-agent-desktop 有完整 `lib/i18n/` |

---

## 5. 功能现状盘点（UI 实际支持 vs README 宣称）

| 功能 | 实现位置 | 状态 |
|---|---|---|
| 皮肤系统（5 套） | `PI/src/skins.ts` + `app.css` | ✅ |
| 权限三模式 + 确认桥 | `sidecar/policy.ts`、`approval-extension.ts` | ⚠️ 可用但按工具名匹配（见 P1-5） |
| 多会话 / 归档 / 置顶 / 重命名 / 删除 | `App.svelte:698-800` | ✅ |
| 会话分叉 | `index.mjs:373-429` `forkSession` | ⚠️ 依赖 `getUserMessagesForForking`，无测试 |
| 子代理（scout + 自定义） | `App.svelte:538-564`、`agents.ts` | ⚠️ 前端调度，非 SDK 原生 |
| 思考档位滑块（7 档） | `App.svelte:1131-1151` | ✅ |
| 模型搜索下拉 | `App.svelte:1100-1129` | ✅ |
| 上下文用量环 / 用量统计 | `index.mjs:578-672` | ✅ |
| 文件树 / 预览 / 编辑 | `App.svelte:2258-2278` | ⚠️ 512KB 上限、无语法高亮 |
| Git 面板（暂存/提交/推送） | `index.mjs:238-255`、`App.svelte:2279-2305` | ✅ 但无 branch/checkout |
| 内置终端 | `Terminal.svelte` + `portable-pty` | 🔴 见 P0-3、P0-5 |
| 待办 | `todos.ts` | ✅ |
| 商店生态（prompts.chat / skills.sh / npm） | `ecosystem.mjs` | ⚠️ 依赖三个第三方站点，无缓存与降级 |
| OAuth 登录 + `pi install` | `index.mjs:1154-1174`、`packageManager()` | ✅ 无需全局 CLI（比参考项目都好） |
| SDK 应用内自更新 | `index.mjs:270-315`、`loadPiSdk` | ✅ 设计不错 |
| 局域网观察 | `lan.mjs` | ⚠️ 只读；token 走 URL query（会进浏览器历史/日志） |
| 桌宠（Live2D + 精灵图） | `pets.ts`、`Live2DPet.svelte` | ✅ |
| 生图模式 | `index.mjs:674-692` | ✅ |
| 视觉桥 | `ecosystem.mjs:403-428` | ✅ |
| 附件（图片/文本） | `App.svelte:1454-1510` | ✅ 含剪贴板粘贴 |
| `@` 文件引用 / `/` 命令 | `App.svelte:1900-1948` | ✅ |
| 消息撤回重发 | `App.svelte:513-536` | ✅ |
| **测试 / lint / typecheck** | —— | 🔴 **完全没有** |

---

## 6. 最该先修的 10 件事

| 优先级 | 事项 | 理由 |
|---|---|---|
| 1 | **事件瘦身（P0-1）** | 唯一会让应用"崩"的问题，且修复范围小、收益巨大 |
| 2 | **建立测试地基（P1-1）** | 没有它，后面每一步都是在流沙上盖楼 |
| 3 | **sidecar 崩溃自愈 + 请求 id 归属（P0-4、P0-6）** | 决定应用是"偶尔坏"还是"坏了要重启" |
| 4 | **`set_mode` 工具集语义修正（P0-2）** | 权限功能的正确性根基 |
| 5 | **权限升级为模式 × 参数（P1-5）** | 直接决定"敢不敢用 full 模式" |
| 6 | **PTY UTF-8 边界修复（P0-5）** | 中文用户必踩，且是静默数据损坏 |
| 7 | **终端面板常驻化 + 进程树清理（P0-3）** | 消除孤儿进程与监听泄漏 |
| 8 | **协议类型契约（P1-2）** | 让重构安全，让新人可读 |
| 9 | **打包脚本去硬编码 + CI 可构建（P1-6）** | 没有可复现构建就没有发布 |
| 10 | **App.svelte 拆分（P1-3）** | 降低后续所有改动的成本 |

---

## 附录 A：本报告的关键证据文件

| 事实 | 文件:行 |
|---|---|
| `message_update` 带全量 `message` + `partial` | `PI/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:597-601`；`pi-ai/dist/types.d.ts:410-455` |
| 瘦身只改子字段、顶层 `message` 透传 | `PI/sidecar/index.mjs:105-111` |
| `DEFAULT_TOOLS` 缺 grep/find/ls | `PI/sidecar/index.mjs:62`；`PI/sidecar/policy.ts:7-19` |
| `set_mode` 重置为硬编码工具集 | `PI/sidecar/index.mjs:954-963` |
| PTY 8KB 块 `from_utf8_lossy` | `PI/src-tauri/src/lib.rs:216-222` |
| sidecar 不重启 | `PI/src-tauri/src/lib.rs:138-141`、`:167-179`、`:263-274` |
| Terminal 每次挂载都 spawn PTY | `PI/src/Terminal.svelte:17-49`；`PI/src/App.svelte:2306-2307` |
| `request()` 无超时、无 reject 路径 | `PI/src/App.svelte:1157-1177` |
| 两套独立 id 计数器 | `PI/src/App.svelte:173` vs `PI/src-tauri/src/lib.rs:171-172` |
| 7 份重复 clickOutside | `PI/src/App.svelte:836-968` |
| 打包硬编码 `D:\Node\node.exe` 与 SDK 版本 | `PI/scripts/prepare-resources.mjs:19-25`、`:71-85` |
| `resources/` 被 gitignore | `PI/.gitignore:4-9` |
| 版本号三处一致但 README 不符 | `PI/package.json`、`Cargo.toml`、`tauri.conf.json`、`PI/README.md:75-76` |
| 前端构建产物 1.12 MB | `npm run build` 输出 |
| 0 测试文件 | `PI/src`、`PI/sidecar` 下 `*.test.*` 计数 = 0 |

## 附录 B：本报告中引用的参考项目证据

| 事实 | 来源 |
|---|---|
| `message_update` 平方放大事故（3 分钟 12.7GB） | percho `packages/backend/src/session/event-slim.ts:3-12` |
| 工具瘦身白名单实现 | percho `event-slim.ts:13-46`、`:65-118` |
| 权限规则引擎（allow/ask/deny × 通配） | percho `permissions/pattern.ts` |
| bash 命令链解析（引号感知/替换/剥壳） | percho `permissions/bash-chain.ts` |
| 临时区豁免（fail-safe） | percho `permissions/tmp-zone.ts` |
| 权限门控 + 会话/项目记忆 | percho `permissions/gate.ts`、`permissions/extension.ts` |
| 100 个测试文件 / `node --test` / `package.test.ts` 断言构建脚本 | pi-agent-desktop 仓库 |
| Windows 进程树清理 `taskkill /T` | pi-agent-desktop `electron/process-tree.ts` |
| 有界崩溃/服务重启 | pi-agent-desktop `electron/main.ts:216-247`、`:467-496` |
| 事件→patch 纯函数 | pi-agent-desktop `hooks/agent-session/agent-event-apply.ts` |
