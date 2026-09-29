# Pi-My 下一步决策清单（请你勾选）

> 用法：看完下面三部分，回我一句"第 N 项做 / 不做"即可（也可以只挑编号）。
> 我已经把每项都核实过**技术可行性**和**当前缺口**，编号即后续实施顺序。

---

## 第 0 部分：先修什么（这些是已审计出的缺陷，建议全做）

这些不是新功能，是"现在就坏着"或不合理的地方。**建议全部修完再谈新特性**。

| 编号 | 问题 | 现状证据 | 工作量 |
|---|---|---|---|
| **0-1** | 🔴 **`/compact`、`/export`、`/workspace` 是假的** | 打 `/compact` 会弹「选择工作区」——命令面板列出 10 条，但只有 5 条有分支，其余全落到 `else void chooseWorkspace()`（`App.svelte:1731-1736`）。而 SDK 的 `compact()`/`exportHtml()` 都可用却**未接线** | 小 |
| **0-2** | 🔴 **引入 typecheck，堵住"未定义变量进产物"** | 项目无 `typescript`、无 `svelte-check`、无 `tsconfig.json`。上一轮 `abandoned` 未定义变量就是这样进了产物，35 个测试全绿也没抓到 | 小 |
| **0-3** | 🟠 **权限从"按工具名"升级为"工具名 × 参数"** | 现在 `bash` 一律弹窗、名单外工具静默放行；`cd x && rm -rf y` 无法识别危险段。percho 的规则引擎可直接借鉴 | 中 |
| **0-4** | 🟠 **扩展 UI 桥（`uiContext`）没接** | SDK 的 `createAgentSession` 接受 `uiContext`（已确认），Pi-My 三处调用**都没传** → 第三方扩展调 `ctx.ui.confirm/select/input` 全部失效。这也是 pi-agent-desktop issue #31「插件在 CLI 能用、桌面端不能用」的同源问题 | 中 |
| **0-5** | 🟠 **`App.svelte` 2557 行单体 + 7 份重复代码** | 7 个 `clickOutside*` action 逐字重复（约 130 行） | 中 |
| **0-6** | 🟠 **打包脚本硬编码 + 无 CI** | `prepare-resources.mjs` 硬编码 `D:\Node\node.exe` 与 SDK 版本；`resources/` 被 gitignore → 干净克隆无法构建 | 小 |
| **0-7** | 🟡 **markdown 每个 delta 全量重渲染** | `MarkdownView.svelte:8` 每次从头解析整段；长回复 O(N²) CPU | 中 |
| **0-8** | 🟡 **`pending` 超时策略未覆盖"活着但僵死"** | P0-B 只覆盖"进程死了/写不进去"。进程活着但不响应时（如上一轮修掉的 OAuth 死锁那类）仍会卡住 | 小 |
| **0-9** | 🟡 **单 chunk 1.12 MB** | xterm / pixi.js / Live2D 全打进主包，无 code-split | 小 |

---

## 第 1 部分：从 **percho** 值得借鉴的（按价值排序）

percho = Electron + React，定位"高度自定义 GUI"。它的**子系统设计**质量很高。

| 编号 | 特性 | 为什么值得 | 我们的现状 | 工作量 |
|---|---|---|---|---|
| **1-1** | ⭐ **逐工具权限规则引擎**（allow/ask/deny × 通配模式） | 本审计中**最值得移植**的模块。含 bash 命令链解析：引号感知切段 + `$( )`/反引号提取 + `sh -c`/`eval` 剥壳，**命令链取最严段** → `cd x && rm -rf y`、`echo $(rm -rf y)` 都拦得住。还有默认配置哲学"宽松 + 高危兜底"、`allowAlways` 按父目录前缀记忆、临时区豁免（fail-safe） | 只有 33 行 `policy.ts`，按工具名匹配 | 中 |
| **1-2** | ⭐ **上下文蒸发**（到龄工具输出自动变紧凑 stub） | 长会话不超上下文预算，默认开启。约 28KB 实现（分段/分级/图片 stub/批量报告） | 无。Pi-My 只有被动显示用量环 | 大 |
| **1-3** | ⭐ **`show_image` 工具**（agent 主动发图到对话区） | 图片只走 `details`，**不进模型上下文**（省 token）；单张 10MB、最多 9 张。比"所有工具结果都渲染成噪音"体验好 | 无。生成图只能手动看 | 小 |
| **1-4** | **子代理体系**（内置 scout + 自定义 agent 定义 + 并行任务 + 只读检视子会话） | percho 的子会话落在 `sessions-subagents/` 与主历史物理隔离，`openSession` 据此判定只读 | 有前端拼装的 `/scout`，但非 SDK 原生、无只读隔离、无 per-agent 模型/思考档位 | 中 |
| **1-5** | **UI 插件系统**（可替换工具调用卡、桌宠浮动层、扩展设置面板） | 极高的可定制性；percho 用它实现桌宠 | 有桌宠但与 UI 插件解耦，无法替换工具卡 | 大 |
| **1-6** | **局域网伴侣的"可写"能力** | percho 支持手机浏览器远程发送 prompt / 停止生成 / 审批权限（可选开启） | `lan.mjs` **只读**，且 token 走 URL query（会进浏览器历史） | 中 |
| **1-7** | **统一报错系统**（错误卡一键重试、自动重试状态行、渲染进程崩溃恢复） | 错误不再是死胡同 | 有错误显示，但无一键重试、无崩溃恢复 | 中 |
| **1-8** | **`peekState` / `get_state` 双入口**（轮询不续命） | 防止侧栏轮询让所有会话永生 | 无此概念 | 小 |
| **1-9** | **`ExtensionUIContext` 用真实 `Theme` 类实例** | percho issue #28：`ui.theme` 给成字符串 → **所有 MCP 服务器永久无法连接**。必须给真实类实例（40+ 色字段全给） | 见 0-4 | 含在 0-4 |

---

## 第 2 部分：从 **pi-agent-desktop** 值得借鉴的

pi-agent-desktop = Electron + Next.js，定位"个人极简版 Codex"。**它的工程纪律最好**（100 个测试文件）。

| 编号 | 特性 | 为什么值得 | 我们的现状 | 工作量 |
|---|---|---|---|---|
| **2-1** | ⭐ **测试姿态**（100 个测试文件、`node --test`、`package.test.ts` 断言构建脚本内容、隔离临时目录冒烟测试） | 我们最大的差距（我们只有 35 个测试，且上一轮暴露的 2 个真 bug 都是"测试全绿却漏掉"）。`package.test.ts` 的思路：**把"删掉一个承重脚本"变成测试失败** | 刚开始建（35 个） | 中 |
| **2-2** | ⭐ **长期记忆 LTM**（项目级 SQLite + FTS5 trigram + 取代链） | 跨会话记忆；**FTS5 迁移是它最好的东西**（`CREATE VIRTUAL TABLE IF NOT EXISTS` 永远无法改分词器，只能 drop→recreate→repopulate，用 `PRAGMA user_version` 守卫）。中文用 CJK bigram Dice 而非 Jaccard | 无 | 大 |
| **2-3** | ⭐ **会话分叉到 Git worktree** | 隔离的分支工作副本；`git-worktree.ts` 1321 行，最防御性模块：ownership UUID + reflog 标记 + 三重身份复核 + **fail-closed 清理** | 只有普通分叉，无 worktree | 大 |
| **2-4** | **队列 CAS 重排 + 拖拽** | `revision` 乐观并发；重排校验 id 全集排列；快照只带 `attachmentCount` 不带图片字节。我们只有"上移/下移"按钮、无 revision | 有 `queue` 但无 CAS、无拖拽 | 小 |
| **2-5** | **会话导出 HTML / Markdown** | 我们现在只导出 JSON（`export_session`）。**已确认 SDK 的 `session.exportToHtml()` 可直接用**（无需深路径 import），却未接线 | 仅 JSON | 小 |
| **2-6** | **分支导航器（可视化会话树）** | SDK 的 `getTree()` 可直接用；我们只有"分支 N/M"下拉 | 有简化版下拉 | 小 |
| **2-7** | **Extension UI Bridge**（confirm/select/input/editor/notify + 超时/AbortSignal 的类型正确默认值） | 与 0-4 同源；它的实现方式（Map<id,Deferred> + UUID 关联 + 超时回落正确默认值而非 reject）值得抄 | 无 | 见 0-4 |
| **2-8** | **用量/额度面板**（4 个 provider 适配器 + 120s 缓存 + 15s 防抖） | Codex 5h/7d 窗口、DeepSeek 余额、OpenRouter credits、Anthropic OAuth usage | 有本地 token 统计，无上游额度 | 中 |
| **2-9** | **有界崩溃/服务重启** | 60 秒窗口内限次重启，超限转可见错误页而非白屏 | **上一轮已实现**（`RestartTracker`） | ✅ 已完成 |
| **2-10** | **MCP 服务器管理 UI** | 全局 + 项目级 MCP 配置与测试 | 无 | 中 |
| **2-11** | **i18n**（en + zh-CN，40KB 字典） | 若要多语言需先抽文案 | 全中文硬编码 | 中 |
| **2-12** | **文件查看器虚拟化 + 语法高亮** | 大文件不卡；我们现在 512KB 硬上限、无高亮 | 有限制 | 中 |
| **2-13** | **`atomic-write`（Windows rename 重试 100×25ms）** | 并发读会阻塞 rename；对"另一个终端同时跑 Pi 导致白屏"（其 issue #33）有效 | 无 | 小 |
| **2-14** | **项目信任机制**（Project Trust 409 握手 + 授权弹窗） | 加载项目级扩展/Skill 前先要信任 | 无 | 中 |

---

## 第 3 部分：建议的推进顺序

如果你不想逐条挑，我建议这样：

**第一批（先做，全部属于"修缺陷"）**
0-1、0-2、0-3、0-4、0-6

理由：0-1/0-2 是明确的坏东西；0-3/0-4 决定"权限敢不敢用、插件能不能用"，是正确性根基；0-6 决定"能不能复现构建"。

**第二批（结构改善）**
0-5、0-7、0-8、0-9、2-1、2-4

理由：拆 App.svelte 降低后续成本；2-1 补测试姿态；2-4 顺手补齐队列。

**第三批（新增能力，选做）**
1-3、1-1 的剩余部分、2-5、2-6、1-8、2-13、2-8

**第四批（大工程，需要专门排期）**
1-2（上下文蒸发）、2-2（长期记忆）、2-3（worktree）、1-5（UI 插件）、2-10（MCP）、2-11（i18n）

---

## 需要你确认的三件事

1. **第 0 部分是否全做？**（我建议全做）
2. **第 1、2 部分你挑哪几个编号？**（可以只挑 2-3 个，我会按批次推进）
3. **是否同意"每批都派独立子代理审查 + 跑测试和构建"**这个流程？（上一轮证明它有效——审查员抓到了 4 个我自己没发现的真 bug，包括一个我引入的性能回归）

---

## 附：我核实过的技术可行性（避免选了做不了）

| 能力 | 结论 |
|---|---|
| `uiContext` 注入 | ✅ `createAgentSession` 接受，三处调用都没传 |
| `compact()` / `setAutoCompactionEnabled()` / `abortRetry()` | ✅ AgentSession 上有，**全部未接线** |
| `getTree()` / `createBranchedSession()` | ✅ 有（后者已接线，前者未用） |
| `getActiveToolNames()` / `setActiveToolsByName()` | ✅ 有（修 0-3 时会用到，避免硬编码工具集） |
| `exportHtml` | ✅ **已确认**：`AgentSession.exportToHtml(outputPath?, options?)` 直接可用，**无需深路径 import**（深路径那个 `exportFromFile` 才需要，参考项目正因这么做挨批）。当前只导出 JSON |
| 会话分叉 | ✅ `getUserMessagesForForking()` + `createBranchedSession()`（已用） |
