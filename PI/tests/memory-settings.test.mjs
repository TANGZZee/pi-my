/**
 * 记忆设置页承重测试（2-2 记忆功能 → 设置「能力 → 记忆」页接线）：
 * - Settings.svelte：记忆页注册（Tab 联合 + NAV 能力组 + 懒加载）、
 *   数据链（memory_list/memory_search/memory_remember/memory_delete RPC 调用、
 *   busy 门闩、操作后刷新）、内容全文显示（memory-content 样式 + 长文折叠）、
 *   pi-memory 扩展说明卡（两套记忆系统不混淆）。
 * - sidecar：memory_* RPC 已存在（list/search/remember/delete/supersede 全通）。
 * 视图 A = squash(stripComments(raw))（含字面量）；计数用 countCodeHits（防字面量诱饵）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { squash, stripComments, shapeWithLiteralMask, indexOfCode, functionBodyOf } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function viewA(relative) {
  return squash(stripComments(readFileSync(join(root, relative), 'utf8')))
}

/** 防诱饵计数：只统计「真实代码区」的命中（字符串/注释里的同形文本不计入）。 */
function countCodeHits(rawSource, needle) {
  const { shape, literal } = shapeWithLiteralMask(stripComments(rawSource))
  let count = 0
  let pos = 0
  for (;;) {
    const idx = indexOfCode(shape, literal, needle, pos)
    if (idx < 0) break
    count += 1
    pos = idx + 1
  }
  return count
}

const settingsA = viewA('src/Settings.svelte')
const settingsRaw = readFileSync(join(root, 'src/Settings.svelte'), 'utf8')
const sidecarA = viewA('sidecar/index.mjs')

// ---------- 页面注册 ----------

test('记忆页注册：Tab 联合 + NAV 能力组 + 懒加载', () => {
  // Tab 联合类型含 'memory'（countCodeHits 防止字面量诱饵顶替）
  assert.ok(countCodeHits(settingsRaw, "|'memory'") >= 1, "Tab 联合缺少 'memory'")
  // NAV 能力组里注册「记忆」入口（agents/imagegen/context/failover/memory/git 同组）
  // M-M 修补：countCodeHits 防字面量诱饵（viewA 保留字符串内容，const __decoy = "['memory','记忆']" 能骗过 includes）
  assert.ok(countCodeHits(settingsRaw, "['memory','记忆']") >= 1, 'NAV 缺少记忆入口')
  // 懒加载：打开记忆页才拉数据（与 mcp/vision 同款响应式语句）
  assert.ok(settingsA.includes("if(open&&tab==='memory')voidloadMemories()"), '记忆页缺懒加载')
})

// ---------- 数据链 ----------

test('记忆页数据链：list/search 双模式 + busy 门闩 + 操作后刷新', () => {
  // loadMemories：空查询 = memory_list 浏览；有查询 = memory_search
  const loadFn = functionBodyOf(stripComments(settingsRaw), 'loadMemories')
  assert.ok(loadFn.includes("rpc('memory_list',{limit:200})"), 'loadMemories 缺 memory_list 浏览路径')
  assert.ok(loadFn.includes("rpc('memory_search',{query:q,limit:100})"), 'loadMemories 缺 memory_search 路径')
  // M-K 修补：精确赋值形态（`memoryMode=` 连自赋值 memoryMode=memoryMode 都命中）
  assert.ok(loadFn.includes("memoryMode='search'") && loadFn.includes("memoryMode='browse'"), 'loadMemories 必须按分支置 memoryMode search/browse')
  // M-J 修补：门闩必须紧跟声明头（包进 if(false){} 死块后门闩不再处于首位）
  // 注意 functionBodyOf 含 "function name(...){" 前缀，用声明头+门闩连续形态断言
  assert.ok(loadFn.startsWith('functionloadMemories(){if(!rpc||memoryBusy)return'), 'loadMemories busy 门闩必须紧跟声明头（死代码包裹即失效）')
  // 新增：memory_remember（必填校验 + tags 解析 + 成功后清空草稿 + 刷新）
  const addFn = functionBodyOf(stripComments(settingsRaw), 'addMemory')
  assert.ok(addFn.includes("rpc('memory_remember',{content,tags})"), 'addMemory 缺 memory_remember 调用')
  // M-B 修补：content 必填校验（空内容直接拦截，不发 RPC）
  assert.ok(addFn.includes("if(!content){memoryNotice='记忆内容不能为空';return}"), 'addMemory 缺 content 必填校验')
  // M-I2 修补：整体赋值形态（split 结果必须就是传给 rpc 的 tags；void 死代码保活不再命中）
  assert.ok(addFn.includes('consttags=memoryTagsDraft.split(/[,，\\s]+/)'), 'addMemory tags 必须来自 split 解析（整体赋值形态）')
  // M-O 修补：成功后清空两个草稿（残留草稿会让用户误以为未提交）
  assert.ok(addFn.includes("memoryDraft=''") && addFn.includes("memoryTagsDraft=''"), 'addMemory 成功后必须清空草稿')
  assert.ok(addFn.includes('awaitloadMemories()'), 'addMemory 成功后必须刷新列表')
  // 删除：memory_delete + 刷新
  const delFn = functionBodyOf(stripComments(settingsRaw), 'deleteMemoryEntry')
  assert.ok(delFn.includes('rpc(\'memory_delete\',{id:entry.id})'), 'deleteMemoryEntry 缺 memory_delete 调用')
  assert.ok(delFn.startsWith('functiondeleteMemoryEntry(entry:MemoryEntry){if(!rpc||memoryBusy)return'), 'deleteMemoryEntry busy 门闩必须紧跟声明头')
  assert.ok(delFn.includes('awaitloadMemories()'), 'deleteMemoryEntry 成功后必须刷新列表')
  // 反死代码哨兵（M-J/M-L 兜底）：三个函数体内不允许出现 if(false) 死块保活
  for (const [name, body] of [['loadMemories', loadFn], ['addMemory', addFn], ['deleteMemoryEntry', delFn]]) {
    assert.ok(!body.includes('if(false)'), `${name} 函数体内出现 if(false) 死块（needle 保活嫌疑）`)
  }
})

test('记忆页 sidecar 通道：memory_* RPC 处理器与超时策略存在', () => {
  // sidecar 五个 RPC 全通（search/list/remember/supersede/delete）
  for (const type of ['memory_search', 'memory_remember', 'memory_list', 'memory_supersede', 'memory_delete']) {
    assert.ok(countCodeHits(readFileSync(join(root, 'sidecar/index.mjs'), 'utf8'), `type==='${type}'`) === 1, `sidecar 缺 ${type} RPC`)
  }
  // 前端只用四个（supersede 留给模型工具链），data 通道纯净：不经过 sendRequest
  // M-A 修补：精确计数（每个类型恰 1 处调用点；死代码重复调用/分流错乱都会改变计数）
  for (const type of ['memory_search', 'memory_list', 'memory_remember', 'memory_delete']) {
    assert.equal(countCodeHits(settingsRaw, `rpc('${type}'`), 1, `前端 ${type} 调用点必须恰 1 处`)
  }
})

// ---------- 内容显示 ----------

test('记忆页内容显示：全文渲染 + 长文折叠 + 展开状态 keyed by id', () => {
  // 内容块必须渲染 entry.content（class 样式而非内联——可折叠）
  assert.ok(settingsA.includes('.memory-content{white-space:pre-wrap'), '缺 memory-content 样式（全文显示）')
  assert.ok(settingsA.includes('{entry.content}'), '缺 entry.content 渲染')
  // 长文（>400 字符）默认折叠，可展开/收起
  assert.ok(settingsA.includes('entry.content.length>400'), '缺长文折叠阈值判断')
  // M-E2 修补：折叠属性完整形态（含闭合花括号；后缀 &&false 污染即失配）
  assert.ok(settingsA.includes('class:collapsed={memoryExpanded[entry.id]!==true}'), '折叠 class 绑定必须 keyed by id 且无后缀污染')
  // M-F 修补：写侧断言（读侧 keyed-by-id 只保证读；写侧恒定键会让所有卡片共享展开状态）
  assert.ok(settingsA.includes('memoryExpanded[entry.id]=memoryExpanded[entry.id]!==true'), '展开按钮必须写 keyed by entry.id（恒定键=状态永久失效）')
  assert.ok(settingsA.includes("'展开全文'"), '缺展开按钮文案')
  assert.ok(settingsA.includes("'收起'"), '缺收起按钮文案')
  // 折叠样式：max-height 限高（132px ≈ 6 行）+ 展开态滚动
  assert.ok(settingsA.includes('.memory-content.collapsed{max-height:132px;overflow:hidden'), '缺折叠限高样式')
  assert.ok(settingsA.includes('.memory-content{'), '缺内容块样式')
  // 超时策略（rpc-policy）已登记 memory_*（前端等待不至于裸抛）
  const policyA = viewA('src/rpc-policy.ts')
  for (const type of ['memory_search', 'memory_list', 'memory_remember', 'memory_delete']) {
    assert.ok(policyA.includes(`${type}:`), `rpc-policy 缺 ${type} 超时登记`)
  }
})

// ---------- pi-memory 说明卡 ----------

test('记忆页 pi-memory 说明卡：两套记忆系统不混淆', () => {
  // 说明卡必须点明 pi-memory 是独立 npm 扩展（Markdown 记忆），卸载不影响本页数据
  assert.ok(settingsA.includes('关于pi-memory扩展'), '缺 pi-memory 说明卡标题')
  assert.ok(settingsA.includes('另一套'), '说明卡未点明「另一套」')
  assert.ok(settingsA.includes('卸载不影响本页数据'), '说明卡未说明卸载隔离性')
  // MEMORY.md 路径提示（用户可按图索骥找到 pi-memory 的数据文件）
  assert.ok(settingsA.includes('MEMORY.md'), '说明卡缺 MEMORY.md 路径提示')
})

// ---------- 防诱饵自检 ----------

test('防诱饵自检：字面量里的 memory_list 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='memory_list'\""))
  assert.equal(indexOfCode(shape, literal, "type==='memory_list'"), -1)
})
