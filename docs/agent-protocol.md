// Agent 接入指南（Pi-My ↔ Hermes / 任意外部 agent）
//
// Pi-My sidecar 的原生接口就是 **NDJSON over stdin/stdout**——桌面端（Tauri）
// 自己也是这么接的。外部 agent（如 Hermes）走完全相同的通道与协议，
// 拿到与主界面**等价的全量能力**。
//
// 本文件是给 agent 开发者的接入说明 + 可直接复用的 Node 客户端。

## 一、启动

```bash
# sidecar 是纯 Node 脚本，无 UI 依赖，任何 Node ≥ 24 进程都能拉起
node PI/sidecar/index.mjs
```

由**调用方**负责拉起进程并持有 stdin/stdout（sidecar 是被动的：stdin 关闭即退出）。
Hermes 侧示例：`spawn(node, [sidecarPath])` 并保留两个管道。

首次启动会加载 SDK 与扩展（本机实测 6-25 秒），此后每条请求毫秒级响应。

## 二、协议

一行一个 JSON，\n 分隔（NDJSON）。方向与形状：

```
→ 请求：{"id": 1, "type": "<请求类型>", "payload": {...}}
← 响应：{"type": "response", "id": 1, "ok": true, "result": {...}}
        {"type": "response", "id": 1, "ok": false, "error": "原因"}
← 事件：{"type": "event", "sessionId": "...", "event": {"type": "...", ...}}
← 其他：{"type": "confirm_request" | "ui_dialog_request" | "login_prompt" | ...}
```

要点：
- **id 由调用方生成**（自增数字即可），响应按 id 关联——允许并发乱序收发
- 请求**默认串行处理**（顺序即语义）；`oauth_login`/`ui_dialog_response`/`mcp_test` 例外
- 长请求有服务端超时（见 PI/src/rpc-policy.ts 的 TIMEOUT_BY_TYPE 表）
- 事件流是推拉的混合：订阅后自动推送，无需轮询

## 三、最小协作流程

```
1.  {"id":1,"type":"init","payload":{"cwd":"D:/your/project"}}          ← 必须第一条
2.  {"id":2,"type":"create_session","payload":{"sessionId":"hermes-1","cwd":"D:/your/project","mode":"ask"}}
3.  {"id":3,"type":"prompt","payload":{"sessionId":"hermes-1","text":"帮我看下 src/auth 的登录逻辑","behavior":"followUp"}}
4.  ← 持续收 event：message_update（思考/正文 delta）、tool_execution_*（工具步骤）
5.  ← agent_end 表示本轮结束；此后可用 session_stats 读 token 用量
6.  需要 agent 参与决策时：sidecar 会发 confirm_request（权限确认），
    回 {"id":..,"type":"confirm_response","payload":{"confirmId":"..","ok":true}}
7.  {"id":9,"type":"abort","payload":{"sessionId":"hermes-1"}}          ← 随时可停
```

## 四、全量能力清单（93 种请求类型，按域分组）

- **会话**：create_session / open_session / fork_session / close_session / list_sessions / list_all_sessions / rename_session / archive 相关 / compact_session
- **对话**：prompt / steer / abort / queue 相关 / set_mode（plan|ask|full）/ set_model / set_thinking
- **读取**：session_stats / get_state（Token/缓存/容量/费用快照）/ read_file / read_file_chunk（大文件分块）/ list_files / git_status / git_diff
- **导出**：export_session（JSON）/ export_session_html / export_session_md
- **长期记忆**：memory_remember / memory_search / memory_list / memory_supersede / memory_delete
- **子代理**：spawn 会话 + /scout 等 agent 定义（走 prompt + sessions）
- **MCP**：mcp_list / mcp_save / mcp_test
- **系统**：info（版本/目录/provider 概览）/ log_tail / open_url / open_dir
- **工具调用**：与主界面同源——LLM 自动调用 read/bash/edit/write/grep/find/ls/show_image

完整字段与超时见两处权威源：
- 请求处理：`PI/sidecar/index.mjs` 的 `handle()`（每类一个 `if (type === '...')` 分支）
- 超时策略：`PI/src/rpc-policy.ts`（**agent 侧也应按此表设超时**，避免误判）

## 五、权限确认（agent 必须实现）

`mode: "ask"` 下写文件/危险命令会发：

```
← {"type":"confirm_request","sessionId":"...","confirmId":"c1","toolName":"bash","summary":"rm -rf ..."}
→ {"id":N,"type":"confirm_response","payload":{"confirmId":"c1","ok":true}}
```

**超时不回**会在 sidecar 侧按取消处理（权限引擎 fail-safe），不会卡死协议。
全自动 agent 可统一回 `ok: true`（等价主界面"完全访问"），或按 toolName 实现策略。

## 六、可复用 Node 客户端

```js
// pi-my-agent-client.mjs —— Hermes 可直接 import
import { spawn } from 'node:child_process'

export function connectPiMy(sidecarPath, cwd) {
  const child = spawn(process.execPath, [sidecarPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  const handlers = []          // 事件订阅
  let seq = 0
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.type === 'response' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      else for (const h of handlers) h(m)
    }
  })
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${type}`)) }, 120000)
    pending.set(id, (m) => { clearTimeout(timer); m.ok ? resolve(m.result) : reject(new Error(m.error)) })
    child.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
  })
  return {
    request,
    onEvent: (fn) => handlers.push(fn),
    close: () => child.kill(),
    // 便捷方法
    init: () => request('init', { cwd }),
    createSession: (id) => request('create_session', { sessionId: id, cwd, mode: 'ask' }),
    send: (sessionId, text) => request('prompt', { sessionId, text, behavior: 'followUp' }),
    steer: (sessionId, text) => request('prompt', { sessionId, text, behavior: 'steer' }),
    stop: (sessionId) => request('abort', { sessionId }),
    state: (sessionId) => request('get_state', { sessionId }),
  }
}

// Hermes 侧用法：
// const pi = connectPiMy('PI/sidecar/index.mjs', 'D:/your/project')
// pi.onEvent((m) => { if (m.type === 'event' && m.event.type === 'message_update') process.stdout.write(m.event.delta ?? '') })
// await pi.init(); await pi.createSession('hermes-1'); await pi.send('hermes-1', '任务...')
```

## 七、与 LAN HTTP 接口的取舍

| | NDJSON stdin/stdout | LAN HTTP |
|---|---|---|
| 适用 | **同机 agent**（Hermes 等） | 手机/跨机人 |
| 能力 | 全量 93 种 | 只读+受控可写 |
| 鉴权 | 无需（进程父子关系即信任） | 随机 token |
| 多轮 | 长连接，事件实时推 | 2 秒轮询 |

Hermes 这类同机 agent **不要走 HTTP**：NDJSON 能力全、无需管理 token、事件实时。
