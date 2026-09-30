# Pi-My 融合实施计划（Roadmap）

> 输入：`01-pi-my-audit.md`（自身 BUG/问题）、`02-reference-projects.md`（可移植机制）
> 原则：**先修正确性，再补能力，最后才是功能对齐**。每个阶段都有独立可验收的产出。

---

## 阶段进度

| 阶段 | 状态 | 备注 |
|---|---|---|
| **P0 止血（6 项）** | ✅ **已完成** | 经 5 位独立审查员审查 |
| **第 0 批扩展修复（9 项）** | 🔶 **5/9** | 0-1、0-2、0-3、0-4、0-8 已完成；剩 0-5、0-6（部分）、0-7、0-9 |
| **P1 地基** | 🔶 部分完成 | 测试地基已建（108 条：含 6 条 sidecar 集成）；**typecheck 已引入**（0-2）；App.svelte 未拆（0-5） |
| **P2 正确性（权限引擎）** | ✅ **0-3 已完成** | `sidecar/permissions/` 五模块 + 门控扩展；28 条测试 |
| **P3 / P4** | ⏸ 待排期 | 见 `04-feature-menu.md` |

### 第 0 批进度明细

| 项 | 状态 | 说明 |
|---|---|---|
| 0-1 假命令 | ✅ | `src/slash-commands.ts` 注册表 + `runSlashCommand` 按 kind 分派；sidecar 新增 `compact_session` / `export_session_html`；10 条测试（含"每条命令必有分派分支"的结构性断言） |
| 0-2 typecheck | ✅ | `typescript@5` + `svelte-check@4` + `tsconfig.json` + `npm run verify`；**首跑抓到 4 个真实潜伏错误**（含 `AgentEnvelope` 未声明——与 `abandoned` 同类）；变异验证能抓到未定义变量 |
| 0-3 权限引擎 | ✅ | `sidecar/permissions/` 五模块；28 条测试；`cd x && rm -rf y`、`echo $(…)`、`sh -c`、`curl \| sh` 全部拦住；临时区 fail-safe 豁免 |
| 0-4 uiContext | ✅ | 真实 `Theme` 实例（percho #28 的教训）；未实现方法记日志去重；通用对话框桥 + 前端 UI；13 条测试 |
| 0-5 拆 App.svelte | ⏸ | 2700+ 行 |
| 0-6 打包/CI | ✅ | `prepare-resources.mjs` 自动发现 .ts + 自检收紧；**GitHub Actions CI**（前端 check/test/自检/build + Rust 测试，含 timeout-minutes 与 permissions:read）；Rust job 干净克隆 P0 已修（tauri-build resources glob 0 匹配 panic）；承重断言改为**行为验证**（真实启动打包产物，替代可被绕过的源码 grep，审查证实 6/11 逃逸） |

### 第 1 批进度（percho 特性）

| 项 | 状态 | 说明 |
|---|---|---|
| 1-1 权限规则引擎 | ✅ | 与 0-3 同源完成（`sidecar/permissions/` 五模块 + 门控扩展 + 项目级记忆） |
| 1-2 上下文蒸发 | ✅ | **SDK 原生 auto-compaction 默认开启**（`compaction?.enabled ?? true` 已核实）——"蒸发"核心能力天然具备；本轮补齐可见性与控制权：`compaction_start/end` 事件接 UI（"正在压缩上下文"状态行，此前透传被忽略用户只见卡住）+ `get/set_auto_compaction` RPC + finishRun 清理 |
| 1-3 show_image | ✅ | `sidecar/tools/show-image.ts`：图片只走 `details` 不进模型上下文；9 条测试；前端对话区渲染 + 点击放大 |
| 1-4 子代理体系 | 🔶 | 已有 `/scout` + 并行拆分；只读检视/per-agent 模型档位待补（对应 U5） |
| 1-5 UI 插件系统 | ✅ | 声明式插件协议（`ui-plugins.ts`：slot/component/tone/fields，数据非代码，前端永不 eval 插件 JS）；HTML 白名单清洗（剥全部属性，a/script/iframe 整体拒绝）；`PluginCard.svelte` 渲染 + timeline 槽位接线；E2E 实测扩展 `pi.sendMessage(customType: "ui.plugin", triggerTurn:false)` → 事件流 → 前端数据完整；10 条协议测试；开发指南 `docs/audit/05-ui-plugins.md` |
| 1-6 局域网可写 | ✅ | **安全修复先行**：token 从 URL query 改为 `x-pi-token` header（API 不再接受 query token，退出浏览器历史；引导页保留 query 进入）；`lan.mjs` 新增可写模式（默认关闭）：`/api/prompt|steer|stop|confirm` 四接口 + 待决权限确认枚举（`pendingConfirmsBySession`，与主界面同语义）；设置页"允许远程写入"开关（切换重新生成 token）；页面升级为遥控界面（选中会话/发消息/停止/确认权限卡）；**5 条 E2E**（只读 403/鉴权/状态语义/请求体校验/确认回答） |
| 1-7 统一报错系统 | ✅ | 错误卡 + 一键重试桥（已有）；**新增自动重试状态行**（`auto_retry_start/end` 事件 → 显示"自动重试（第 N 次）· 原因"，此前用户只看到卡住） |
| 1-8 peekState/get_state | ✅ | sidecar 新增 `get_state`：聚合 SDK 官方 `getSessionStats`/`getContextUsage` + 模式/队列/工具集/运行态的单一快照（peekState 语义，只读）；供 U4 状态栏面板复用 |
| 1-9 真实 Theme 实例 | ✅ | 与 0-4 同源完成 |
| 1-7b provider 失败无反馈 + 永久 Thinking | ✅ | **真实用户报障**（"模型提供商出错，但没有反馈错误信息，一直还是 thinking"）。根因（真实 SDK 复现确证）：provider 失败时 SDK **不抛异常、也不发 `type:'error'`**，只产出一条 `stopReason:'error'` + `errorMessage` 的 assistant 终态消息，随后照常发 `agent_end(willRetry:false)` / `agent_settled`；前端只读 `willRetry`、只处理 `type:'error'` ⇒ 错误文本整条丢弃。叠加两处放大：看门狗在**每个**事件入口无条件续期 180s（`auto_retry_*`/`compaction_*` 心跳可无限续期）、`sidecar-failed` 分支只 fail pending 请求而**从不清理 running 槽**（放弃重启后永远不会有 `agent_settled`）。修复：`run-slot.ts` 新增 `assistantErrorFrom`（从终态消息提取，`stopReason!=='error'` 一律返回空串，**用户主动中止不报错**）+ `describeProviderError`（5 类常见错误→可执行中文归因）；`App.svelte` 改**暂存 + 终态消费**（`message_end`/`turn_end`/`auto_retry_end` 暂存，`agent_end` 且不重试 / `agent_settled` / `type:'error'` 三处消费，避免"错误闪现后被重试覆盖"）；看门狗跳过 `auto_retry_*` 续期；新增 `abortRunningRuns()` 统一清理（`onSidecarRestarted` 与 `sidecar-failed` 共用，后者是本 bug 最直接的成因）。**验证**：新增 `tests/provider-error-e2e.test.mjs` 2 条**真实 SDK** E2E（本地 404 server + 本地 SSE 成功 server，真跑 `createAgentSession`，真实事件→真实 `summarizeEvent`→前端纯函数，断言用户可见文案），单测 + 1 条 event-slim 承重断言。**两轮对抗性审查（独立子代理）后加固**：审查者用真 SDK + 本地 503 server 复现出一个**本次新引入的误报**——重试退避期间点 Stop，SDK 发 `auto_retry_end{finalError:"Retry cancelled"}`，被当成 provider 故障弹红条 → 新增 `isCancellationText`（整串匹配 SDK 固定取消文案，真实网络错误不误伤）并在 `stop()` 收尾显式补 `error:''`（`patchSlot` 是浅合并，漏字段会让红条残留）；审查者另证 **M11/M12 覆盖真空**——把暂存函数体整个清成 `return`，61/61 测试照样全过（wiring 只做源码文本匹配、e2e 是手写复刻）→ 把 `stashProviderError`/`removeProviderError`/`takeProviderError` 抽为 `run-slot.ts` 纯函数、组件只留薄壳、e2e 复刻改调用真实函数，新增 8 条行为级单测并**逐项变异验证**（M11 变异 5 fail、M12 变异 2 fail）。另新增 `tests/provider-error-wiring.test.mjs`（12 条源码接线断言，M3 缺口）。四项变异（M3/A/B/C）全部被 wiring 拦住；`npm run verify` 全绿 |
| 0-7 markdown 增量 | ✅ | `src/markdown-incremental.ts` 闭合前缀缓存；**增量与全量逐字符一致**（14 条测试，含审查 3 类攻击用例的回归保护与硬性 `reused` 断言） |
| 0-8 僵死探活 | ✅ | Rust 侧 `STALL_THRESHOLD=360s`（高于前端最长 300s，避免打架）+ `agent_outstanding` 计数；4 条单测；**已修 outstanding 双计数** |
| 0-9 code-split | ✅ | xterm/Pixi/Live2D 动态加载；**主包 1113KB → 277KB（−75%）**；新增 `LazyPet.svelte`；xterm 加载失败有用户可见提示 |

**主包体积**：1113 KB → **277 KB**（gzip 322→97 KB）。xterm（332KB）、Live2D+pixi（518KB）切成独立 chunk 按需加载。

**第 0 批已全部派独立子代理审查（6 位审查员，两轮覆盖 0-1..0-4 与 0-7/0-9）。**

### P0 完成清单（每项都有测试与独立审查）

| P0 | 内容 | 验证方式 |
|---|---|---|
| P0-1 | `message_update` 事件瘦身 | 20 条单测；实测 2000 delta 载荷 −94.7% |
| P0-1b | 补充发现：SDK 自带 `toJsonEvent`；`RpcClient` 可借鉴 | 落到 `04-feature-menu.md` 供决策 |
| P0-2 | `set_mode` 工具集语义（含 plan 中创建的会话） | 14 条纯函数测试 + 3 条集成测试；双向切换实测 |
| P0-3 | 终端面板常驻 + PTY 进程树清理 | DOM 层级检查 + Rust 编译 |
| P0-4 | sidecar 崩溃自愈 + 请求 id 归属 | 9 条 Rust 测试（含重启限次/窗口过期/锁中毒） |
| P0-5 | PTY 跨块 UTF-8 解码 | 14 条 Rust 测试（含 GBK/二进制/内存有界） |
| P0-6 | 请求超时（72 种类型分档） | 22 条测试（含与 sidecar 请求类型的交叉校验） |

**审查过程中被抓住并修复的真实缺陷**（合计 9 个，其中 4 个由审查员发现）：
事件瘦身基线口径错误、脆弱字节阈值、顶层 `text` 死载荷、`agent_end` 第 5 个载体遗漏、新文件未入 git、`tauri dev` 加载旧副本、`abandoned` 未定义、`take_valid_utf8` 无界积压回归、**OAuth 死锁**、**forkSession 审批绕过（安全）**、**openSession 模式丢失（安全/UX）**。

---


### 第 2 批进度（pi-agent-desktop 特性）

| 项 | 状态 | 说明 |
|---|---|---|
| 2-9 provider 额度面板 | ✅ | 基础版（usageStats/余额）随 P0-B；重置时间展示与周期估算已随 2-8 完成 |
| 2-13 原子写 | ✅ | `sidecar/atomic-write.mjs`：临时文件+rename+Windows EPERM 重试（可注入测试）+兜底直写；config.mjs 与归档列表已接入；6 条测试 |
| 2-4 队列 CAS | ✅ | `src/queue-cas.ts`：revision 乐观并发 + 重排/移除的 id 全集校验（防"复活"已出队的项）；队列项改带稳定 id；10 条测试含 drain/移除竞争时序还原 |
| 2-5 导出 HTML/MD | ✅ | HTML 已有（SDK exportToHtml）；**本轮补 Markdown**（export_session_md：对话轮次序列化+工具调用计数）；/export md|json|html 三格式 |
| 2-6 分支导航器 | ✅ | 分支下拉升级为**树形视图**（buildSessionRows 缩进层级 + └/● 标记），只看当前根、排除归档 |
| 2-14 Project Trust | ✅ | SDK `resolveProjectTrust` 钩子 + 信任弹窗（fail-safe：超时=拒绝）+ `pi-my-project-trust.json` 持久记忆 + `trust_project`/`get_project_trust` RPC + 测试逃生口 `PI_TRUST_ALL`；E2E 断言完整流程 |
| **附带发现并修复：主循环死锁** | ✅ | `for await (const line of rl)` 在任一请求 await 期间不读后续行——弹窗回答/登录回执永远排不上队。改为 `rl.on("line")` 事件驱动 + 串行链（顺序语义不变）。这是比 2-14 本身更重要的修复 |
| 2-12 文件查看器虚拟化 | ✅ | `read_file_chunk` 分块协议（流式扫描只留窗口，单行>4000 字符截断标记）+ `VirtualFile.svelte` 虚拟滚动（总高占位+可视窗口渲染+滚动节流）；>512KB 文件自动切虚拟化预览（此前直接报错）；E2E 验证 30000 行 53ms 拉窗 |
| 2-8 用量/额度面板 | ✅ | 见 U4：`provider_quotas` RPC（allSettled 并发探针，单个失败不影响其他）+ 周期估算与倒计时 |
| 2-3 worktree 分叉 | ✅ | `create_worktree_fork`：`git worktree add -b pi-my/<label>` + SDK `SessionManager.forkFrom`（cwd=worktree）+ 失败回滚（删 worktree/分支）；分支导航器底部入口 🌳；E2E 实测真仓库建 worktree 并在内部可见文件 |
| 2-7 扩展桥增强 | ✅ | 对话框超时回落**按 kind 的正确默认值**（confirm→false、select→第一项、input/editor→undefined，移植 pi-agent-desktop 语义）；`dialog_expired.fallback` 协议字段 + 前端 toast 提示 |
| 2-2 长期记忆 LTM | ✅ | `sidecar/memory.mjs`：`node:sqlite` + FTS5 trigram（中文 ≥3 字 MATCH、2 字回退 LIKE、混合词 AND+LIKE）；项目隔离；**取代链**（可追溯）；`user_version` schema 守卫；5 RPC + 7 单测 |
| 2-11 i18n | 🔶 第一阶段完成 | `src/i18n.ts`：无依赖框架（回退链 en→zh→key、{n} 插值、语言广播、字典合并）+ 核心域 zh/en 字典（通用/live 标签/状态栏/队列/分支/重试/图片）+ `prefs.language` + 设置页切换 + live 标签两处接线；**5 条测试**（含回退链与广播契约）。存量 10755 中文字符按域渐进迁移（新 UI 必须走 t()） |
| 其余 2-x | ✅ 全部完成或已有替代 | 2-1 测试姿态（累计 232 条）、2-9 随 P0-B 基础版 |
| **第 2 批总结** | ✅ 14 项全部处理：12 项完整实现 · 1 项第一阶段（i18n）· 1 项基础版（2-9 额度基础随 P0-B，深化随 2-8 完成） |
### 第 3 批进度（用户新增需求）

| 项 | 状态 | 说明 |
|---|---|---|
| U1 系统托盘 + 最小化到托盘 | ✅ | Rust `setup_tray`（图标/菜单/tooltip/左键恢复）；关窗默认隐藏到托盘；**审查后补齐设置页开关**（get/set_tray_minimize 接线，乐观更新失败回滚） |
| U2 Apple 布局 + 液态思考球 | ✅ | 新增 `ThinkingOrb.svelte`（5 组谐波扰动的液态光球 + 高光流动 + 内部气泡）；设置页可选"液态思考球/经典原子"（`prefs.thinkingOrb`）；主会话与子会话检视两处生效 |
| U3 对话中途切换模型 | ✅ | `set_model` 中途可调；模型选择器按来源标记（`source: extension` 的 provider 带"扩展"徽标）；sidecar 放行扩展注册的 provider（1-8 轮已做） |
| U4 状态栏面板 | ✅ | sidecar `get_state` + `session-state.ts` + 运行状态区；**2-8 深化：Provider 额度区**（并发探针拉取各 provider 额度 + 周期化重置时间估算 + 人类可读倒计时；`quota-reset.ts` 9 条测试，真实字段优先/不虚构语义） |
| U5 内置子代理 | ✅ | 只读检视已通（事件按 sessionId 路由到子运行槽，运行卡片→只读浮层实时看思考/工具/回复）；**本轮补 per-agent 模型与思考档位覆盖**（AgentDef.model/thinking，spawn 时下发给子会话） |

### 第 4 批进度（UI/前端）

| 项 | 状态 |
|---|---|
| 液态玻璃主题 | ⏸ | 与 Atom 二选一的 ThinkingOrb 已落地（U2），玻璃材质皮肤待做 |
| 设置页 UI/交互优化 | ⏸ |
## 总体节奏

| 阶段 | 主题 | 目标 | 改动范围 |
|---|---|---|---|
| **P0** | 止血 | 应用"不会坏" | `sidecar/index.mjs`、`src-tauri/src/lib.rs`、`Terminal.svelte` |
| **P1** | 地基 | 改动"不会悄悄坏" | 新增 `tests/`、`shared/protocol.ts`、拆 `App.svelte` |
| **P2** | 正确性 | full 模式"敢用" | `sidecar/permissions/`（新增） |
| **P3** | 体验对齐 | 追上参考项目的高频体验 | 队列 CAS、拖拽、会话树、用量面板 |
| **P4** | 差异化 | 放大 Pi-My 独有优势 | 皮肤、商店、桌宠、SDK 自更新 |

**硬约束**：每个阶段结束必须 `npm run build` 通过 + 新增测试全绿。没有测试的改动不允许合入 P1 之后的阶段。

---

## 阶段 P0：止血（建议先做，1–2 天）

### P0-A 事件瘦身 ⭐ 最高优先级 —— ✅ **已完成（含独立审查）**

> **状态**：已实施，并通过 2 位独立审查员（不同切入角度）的对抗性审查。实施记录与逐条处置见 `01-pi-my-audit.md` §0.1。
> **实测收益**：2000 个 delta 场景，真实基线 **10.18 MB → 0.54 MB（-94.7%，19×）**；对无瘦身基线 -97.3%。
> **新增防线**：20 个单测（`npm test`）+ 构建期 sidecar import 自检。

- **目标**：消除流式期 O(N²) 载荷放大。
- **关键认知**：**SDK 自带官方瘦身函数 `toJsonEvent`**（`dist/modes/json-event.js`，29 行），官方 RPC 出口已在用（`rpc-mode.js:266`）。Pi-My 绕开官方出口自己订阅原始 `session.subscribe`，才丢掉这层保护。**这不是发明，是回归正轨。**
- **实施方式**：`PI/sidecar/event-slim.mjs`（纯函数，零依赖）
  - 照抄 `toJsonEvent` 语义（**不深路径 import**：该模块未从主入口导出，实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`）
  - 相比官方版**额外保留 `usage`**；`toolcall_start` 的 `partial` 提炼为 `{id, toolName}`
  - 官方在 `toolcall_start` 形状异常时会 `throw`；本实现**降级 + 告警**（更宽容，不打断流）
  - **第二层**：`tool_execution_end`/`message_start`/`message_end`/`turn_end`/`agent_end` 的大 `result` 被**五处**重复携带。官方 `toJsonEvent` 不管这层，按 percho `slimBulkyEvent` 思路截断：文本保头 4KB、图片 data 换占位符、**`details` 一律不动**（形状自定义无上界，无法安全通用截断）
  - **不再设顶层 `text`**：零消费者，且会让 `text_end`/`thinking_end` 体量翻倍
- **验收**：`PI/tests/event-slim.test.mjs`（20 条，全绿）
  - 白名单：瘦身后不含 `message`/`partial`
  - **不变量**：事件体量与累积长度无关（**不用硬编码字节阈值**——SDK 给 `usage` 加字段即误报）
  - **输入不可变**：绝不就地改写 SDK 事件（SDK 在 `_emit()` 之后才用 `event.message` 持久化）
  - 变异测试：3 个最初存活的变异体（降级丢 `contentIndex`、降级不告警、恢复死载荷）补测后全部被杀死
- **风险**：低。若前端依赖某个被剥字段，会立刻表现为 UI 缺数据。

**遗留未闭合项（已知，非阻塞）**：
1. 无真实 LLM 端到端流式验证 —— 环境 provider 返回 402（余额不足），无法产生真实 `message_update`
2. 真实 agentic run 降幅仅 ~65%（`message_end(assistant)`、`tool_execution_start.args`、`turn_end.message` 仍原样）→ 后续可推向 90%+
3. `setWarnHandler` 是模块级可变状态，建议未来改为参数注入

### P0-A2 借鉴 SDK `RpcClient` 的四项能力（不必整体替换）

**背景**：SDK 主入口已导出 `RpcClient`/`runRpcMode`（实测可 `import`）。它的接口比 Pi-My 手写协议**更全**，但**一个 RPC 进程只管理一个会话**，与 Pi-My 的多会话模型不符，且会丢掉文件/Git/商店/生图等独有能力。**因此不整体替换，只借鉴**：

| 借鉴项 | RpcClient 位置 | 解决 Pi-My 的哪个问题 |
|---|---|---|
| 退出时 `rejectPendingRequests` | `rpc-client.js:431-436` | **P0-6**（请求永久挂起）—— 正是"进程退出清空 pending"的官方做法 |
| `waitForIdle`（等 `agent_settled`） | `rpc-client.d.ts:239` | 替代 `App.svelte:401-411` 的 3 分钟看门狗猜测 |
| `getAvailableThinkingLevels` | `rpc-client.d.ts:133` | 替代硬编码 7 档（`App.svelte:162`）—— 不同模型支持的档位不同 |
| `getCommands` | `rpc-client.d.ts:234` | 替代硬编码 10 条 `/` 命令（`App.svelte:1900-1911`），可列出扩展命令与 skill |
| `extension_ui_request` 桥 + `extension_error` 上报 | `rpc-mode.js:260` | **P2-B**（扩展兼容性）+ 消除"静默失效" |

- **验收**：`waitForIdle` 生效后，移除 3 分钟看门狗不再有卡死误报。
- **注意**：这是 P1/P2 阶段的事，**不要塞进 P0**。

### P0-B sidecar 崩溃自愈 + 请求 id 归属

- **目标**：sidecar 退出后可自动恢复，而非要求重启应用。
- **改动**：
  - `PI/src-tauri/src/lib.rs`：`agent_request` 写入失败或 `try_wait()` 非空时**惰性重启** sidecar；加 60 秒窗口内**最多 3 次**重启上限（防崩溃循环，借鉴 pi-agent-desktop `getNextRestartState`）
  - 重启后**丢弃并重建** sidecar 句柄；向前端发 `sidecar-restarted` 事件
  - `PI/src/App.svelte`：收到 `sidecar-restarted` 时**清空 `pending` 并全部 reject**、重置 `requestSequence`、提示用户
- **验收**：
  - 手动 `taskkill` sidecar 进程 → 应用在数秒内可继续对话
  - 连续杀 4 次 → 第 4 次给出明确提示而非静默失败
- **风险**：中。重启会丢失 sidecar 内的会话运行时态（`sessions` Map），但会话文件仍在，前端应提示"会话已重连"。

### P0-C PTY UTF-8 边界修复

- **目标**：中文输出不再出现 `�`。
- **改动**：`PI/src-tauri/src/lib.rs`（`:216-227`）加跨块尾字节缓冲：
  ```rust
  let mut pending: Vec<u8> = Vec::new();
  // read 后 pending.extend_from_slice(&buffer[..length]);
  // let valid = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) => e.valid_up_to() };
  // emit pending[..valid]；pending.drain(..valid);
  ```
- **验收**：终端里执行输出含中文的命令（如 `git log` 中文提交、`type` 一个中文文件），连续切换面板 20 次无乱码。
- **风险**：低。

### P0-D 终端面板常驻化 + 进程树清理

- **目标**：消除孤儿 shell 与监听泄漏。
- **改动**：
  - `PI/src/App.svelte:2306-2307`：改用**常驻挂载 + CSS 隐藏**（`display:none`）而非 `{:else if}` 条件销毁；或对 `Terminal` 加 `<div style="display:none">` 包裹保持挂载
  - `PI/src/Terminal.svelte`：加"仅 spawn 一次"守卫；确保 `unlisten` 在 await 完成后立即调用（即使组件已销毁）
  - `PI/src-tauri/src/lib.rs` `pty_kill`：等待退出 + Windows `taskkill /PID x /F /T`
- **验收**：切换终端面板 20 次后，任务管理器中 `cmd.exe` 数量**恒为 1**。

### P0-E 修 `set_mode` 工具集语义

- **目标**：模式切换不丢失工具；plan 模式真的只读。
- **改动**：`PI/sidecar/index.mjs`
  - 会话创建时记录 `entry.baseTools = session.getActiveToolNames()`
  - `effectiveToolsForMode` 改为基于 `baseTools` 过滤，而非硬编码常量
  - `set_mode` 在会话不存在时返回 `{ ok: false, reason }` 而非伪造成功
- **验收**：`tests/policy.test.ts` 覆盖 plan→ask→plan 往返、会话不存在分支。

### P0-F `request()` 超时

- **目标**：单个请求卡住不再冻结 UI。
- **改动**：`PI/src/App.svelte:1157-1177` 加 30 秒超时 + `finally` 清理 `pending`，超时 reject 并提示。
- **验收**：手工让某个 sidecar 请求永不返回 → UI 在 30 秒内给出错误而非永久转圈。

---

## 阶段 P1：地基（建议 3–5 天）

### P1-A 测试地基 ⭐

- **目标**：从 0 到有防线。
- **改动**：
  - `PI/package.json` 加 `"test": "node --test tests/"`、`"typecheck": "tsc --noEmit"`、`"lint": "biome check ."`
  - 新增 `PI/tests/`（首批 5 个文件，见审计报告 P1-1）
  - 新增 `PI/package.test.ts` 式**构建脚本断言**（保证 `prepare-resources.mjs` 不被误删/误改）
- **验收**：`npm test` 全绿；删掉 `prepare-resources.mjs` 的一个关键步骤会让测试失败。
- **注意**：`node --test` 可能需要 `--test-force-exit`（pi-agent-desktop 的注释明确警告）。

### P1-B 协议类型契约

- **目标**：消除 60+ 种裸字符串请求。
- **改动**：新增 `PI/shared/protocol.ts`，定义请求/响应的判别联合；前端与 sidecar 同时引用；加 `assertNever` 兜底。
- **注意**：`prepare-resources.mjs` 目前用 esbuild 把 `.ts` 编成 `.js` 再替换 import（`:35-57`）。协议文件若被 sidecar 运行时引用，需加入该编译步骤；或做成纯 `types` 文件（仅 `import type`，运行时擦除）。
- **验收**：故意打错一个 `type` 字面量 → `tsc --noEmit` 报错。

### P1-C 拆分 `App.svelte`

- **目标**：2438 行 → 目标 < 500 行。
- **改动**（建议顺序，每步保持可运行）：
  1. 先抽 **7 份重复的 `clickOutside*`**（`:836-968`，约 130 行）为一个通用 action → 删 ~110 行
  2. 抽事件归约逻辑到 `run-state.ts`（纯函数，可测）
  3. 拆 `Composer.svelte`（textarea + 下拉菜单 + 附件 + mention）
  4. 拆 `WorkspacePane.svelte`（文件树 + Git + 待办 + 子代理）
  5. 拆 `SessionSidebar.svelte`
- **验收**：每步后 `npm run build` 通过且功能回归手工过一遍；最终 `App.svelte` < 500 行。

---

## 阶段 P2：权限引擎（建议 3–5 天）

### P2-A 移植 percho 权限三件套

- **目标**：从"按工具名确认"升级为"工具名 × 参数模式 × allow/ask/deny"。
- **改动**：新增 `PI/sidecar/permissions/`
  - `pattern.ts`（移植：通配匹配 + 规则求值 + `suggestPattern`）
  - `bash-chain.ts`（移植：引号感知切段 + 替换提取 + 包装剥壳）
  - `config.ts`（移植：`permissions.json` 读写 + mtime 缓存 + 默认配置）
  - 可选后做：`tmp-zone.ts`、`gate.ts`
- **改造点**：`PI/sidecar/approval-extension.ts` 改为调用规则引擎求值，而非 `needsAskConfirm(mode, toolName)` 的名单匹配。
- **默认配置**：照抄 percho 的"宽松 + 高危兜底"（`bash` 默认 allow，`rm -rf *`/`sudo *`/`git push --force*`/`curl * | sh*` 等 ask；`**/permissions.json`、`auth.json` 自保护）。
- **验收**：
  - `tests/permission.test.ts`：`cd x && rm -rf y` **取最严段**（不能因为 `cd x` 是 allow 就放过）
  - `echo $(rm -rf y)` 被拦
  - `sh -c 'rm -rf y'` 被拦
  - `git push` 放行、`git push --force` 弹窗
- **风险**：中。默认策略若过严会显著降低体验，建议**先以"只记录不拦截"模式上线观察一周**（dry-run），再转正式拦截。

### P2-B `uiContext` 补全（扩展兼容性）

- **目标**：避免"插件静默失效"（pi-agent-desktop issue #31 的坑）。
- **改动**：`PI/sidecar/index.mjs` 的 `createAgentSession` 传入完整 `uiContext`：
  - `theme` 必须是**真实 `Theme` 类实例**（percho 教训：字符串会让 MCP 全挂）
  - `confirm` 桥到现有 `confirmBridge`
  - `select`/`input`/`editor` 桥到新的前端弹窗
  - 未实现的降级**必须留日志**（对应 percho issue #32/#36）
- **验收**：装一个会调用 `ui.confirm` 的第三方扩展，确认弹窗出现；调用未实现方法时日志有记录。

---

## 阶段 P3：体验对齐（建议 1–2 周）

| 项 | 借鉴来源 | 要点 |
|---|---|---|
| **队列 revision CAS + 拖拽重排** | 两者都有 | `revision++` 乐观并发；重排校验 id 集合是全集的排列；快照不带图片字节 |
| **`Enter` 插话 / `Alt+Enter` 排队 抽成纯函数** | `submit-action.ts`（9 行） | 把产品决策变成可测函数 |
| **会话树 / 分支导航器** | pi-agent-desktop `BranchNavigator` | Pi-My 已有 `activeBranchSiblings` 雏形，补可视化 |
| **会话导出 HTML / Markdown** | pi-agent-desktop | Pi-My 现在只导出 JSON（`export_session`） |
| **用量/额度面板** | pi-agent-desktop `upstream-usage` | 4 个 provider 适配器 + 120s 缓存 + 15s 防抖 |
| **内置终端保留历史** | —— | 配合 P0-D 常驻化自然解决 |
| **文件查看器虚拟化** | pi-agent-desktop `file-viewer-virtualization` | 大文件不卡（Pi-My 现在 512KB 硬上限） |
| **`show_image` 工具** | percho `tools/show-image.ts` | 图片只走 `details`，省 token |
| **可发现性修正** | percho issue #74 教训 | 关键入口不能只靠 hover |

---

## 阶段 P4：差异化（持续）

放大 Pi-My **独有**的优势（两个参考项目都没有）：

1. **皮肤系统**：5 套设计令牌已领先，可加"导入/导出皮肤 JSON"、跟随系统主题的细腻过渡。
2. **应用内 SDK 自更新**（`loadPiSdk`）：设计优于两者，补**回滚按钮**（当前只能升不能退）。
3. **零外部依赖的登录/装插件**：`pi install` 走内嵌 SDK，不需要全局 CLI——这是相对 pi-agent-desktop 的实质优势，值得在 README 强调。
4. **Tauri 的体积/启动优势**：与 pi-agent-desktop 的分钟级启动（issue #32）形成对比，可作为定位差异点。

---

## 验收总表

| 阶段 | 必须通过的验收 |
|---|---|
| P0 | 长回复不卡（字节数线性）；杀 sidecar 可自愈；终端中文无乱码；切面板无孤儿进程；模式切换不丢工具；请求不永久挂起 |
| P1 | `npm test` 全绿；`tsc --noEmit` 无错；打错协议字段编译期报错；`App.svelte` < 500 行 |
| P2 | 命令链/替换/包装三类绕过用例全部被拦；默认策略 dry-run 一周无严重误拦 |
| P3 | 每项功能有对应测试；无回归 |
| P4 | —— |

---

## 建议的下一步（立即可做）

1. **只做 P0-A（事件瘦身）**：改动局限在 `summarizeEvent` 一个函数，风险最低、收益最大。
2. 紧接着做 **P0-E（工具集语义）+ P0-F（请求超时）**：都是小范围、高确定性修复。
3. **P0-A/E/F 完成后立刻补 P1-A 的对应测试**，避免"修了但没防住"。
4. sidecar 自愈（P0-B）与 PTY 修复（P0-C/D）涉及 Rust，建议单独一个迭代，改完做一次完整的 `npm run tauri build` 冒烟。

---

## 附：不建议做的事

- ❌ 迁到 Electron（Tauri 更优）
- ❌ 引入 loopback HTTP + SSE（pi-agent-desktop 全部复杂度的根因）
- ❌ 追求"支持所有 Pi 扩展"（pi-agent-desktop 维护者已承认适配不过来）——只支持 `ui.confirm/select/input/editor/notify` 五件套，其余**明确报错**而非静默失效
- ❌ 在没有测试的情况下继续加功能

### Agent 接入接口（Hermes / 任意外部 agent，2026-09-28）

| 项 | 状态 | 说明 |
|---|---|---|
| NDJSON 协议文档 | ✅ | `docs/agent-protocol.md`：启动方式、协议形状、最小协作流程、93 种请求分域清单、权限确认问答、与 LAN HTTP 的取舍 |
| 可复用客户端 | ✅ | `PI/sidecar/agent-client.mjs`：`connectPiMy()`（id 关联/事件分发/超时/便捷方法），纯 .mjs 零依赖，Hermes 直接 import |
| 接入 E2E | ✅ | `PI/tests/agent-client.test.mjs`：协作全流程（init→create→send→事件→stop→state）+ 全量能力抽查（记忆/分块文件/MCP/导出）+ 协议健壮性（未知请求/未知会话明确报错），3 条全过 |
| 能力边界 | ✅ | 用户确认开放**全量能力**（93 种请求，等价 Tauri 通道）；同机进程信任模型，无需 token |

**验证**：250/250 测试全绿；类型检查零错误；构建通过；产物自检通过。