# UI 插件开发指南（1-5）

UI 插件让 Pi 扩展在桌面端对话区渲染**结构化卡片**，而不只是纯文本。

## 快速开始

在你的 Pi 扩展（`~/.pi/agent/extensions/*.ts` 或项目 `.pi/extensions/`）里：

```ts
import type { PluginDisplay } from '...'

export default function (pi) {
  pi.registerCommand('build-status', {
    description: '展示构建结果卡片',
    handler: async (args, ctx) => {
      // 关键：sendMessage 挂在 pi 上（不是 ctx），且 triggerTurn: false 只展示不触发 LLM
      await pi.sendMessage({
        customType: 'ui.plugin',       // 保留前缀 "ui." 仅框架自己可用
        content: '',
        display: {
          title: '构建结果',
          component: 'card',           // card | text | html
          slot: 'timeline',            // timeline | float | settings | status
          tone: 'ok',                  // accent | warn | danger | ok
          fields: [
            { label: '状态', value: '成功' },
            { label: '耗时', value: '3.2s' },
            { label: '产物', value: 'dist/main.js' },
          ],
        },
      }, { triggerTurn: false })
    },
  })
}
```

用户在对话框输入 `/build-status`，对话区出现结构化卡片。

## 组件形态

| component | 用途 | 数据来源 |
|---|---|---|
| `card`（缺省） | 键值对网格 | `display.fields[]` 或自动从 `details` 对象派生 |
| `text` | 等宽文本块（日志/代码片段） | `display.body` 或 `content` 文本 |
| `html` | 受控 HTML（表格/列表/加粗） | `display.body`，经白名单清洗：20 种标签、**剥除全部属性** |

## 槽位

| slot | 位置 | 当前状态 |
|---|---|---|
| `timeline`（缺省） | 对话流内 | ✅ 已渲染 |
| `float` / `settings` / `status` | 浮层/设置页/状态栏 | 协议已预留，渲染随需求开放 |

## 信任与安全边界

- 扩展运行在 Node 侧，受 **Project Trust** 把关（项目级扩展首次加载需确认）
- 插件消息是**声明式数据，不是代码**——前端永不 eval 插件 JS
- `html` 形态经 `sanitizeHtml` 清洗：白名单标签、剥除全部属性（任何属性都可能是载荷）、`script/iframe/a` 等直接整体拒绝
- `ui.` 前缀是保留命名空间，第三方扩展的 customType 不能以 `ui.` 开头（防劫持内置渲染）

## 尺寸限制

单条消息字段 ≤24 个、label ≤64 字符、body ≤20000 字符，超出部分静默截断（fail-safe，不报错不炸 UI）。

## 事件流原理

`pi.sendMessage(..., { triggerTurn: false })` → SDK `sendCustomMessage` → `_appendCustomMessage` → 发出 `message_start`/`message_end`（`role: "custom"`）→ sidecar 原样透传 → 前端 `normalizePluginMessage` 规范化 → `PluginCard` 渲染。消息同时持久化在会话 jsonl 里（`custom_message` 条目），历史回放可见。
