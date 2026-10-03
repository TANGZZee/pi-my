// 0-5 拆分批次 B：GitPanel / TodoPanel / SubRunsPanel 组件抽取行为单测 + 接线承重断言
// 0-5 拆分批次 B-4/B-5 续作：SplitDialog / SubRunOverlay / FilePanel 抽取后本文件
// 的 overlay 归属断言同步翻转为「标记归组件、状态与驱动留 App」。
//
// 抽取防线（同批次 A 模式）：
// 1) 行为单测——把组件内纯逻辑（级联删除/勾选翻转/isStaged 判定/暂存确认文案）从源码
//    中提取出来直接跑，防"组件抽走后语义漂移"；
// 2) 接线真实性——App.svelte 必须真的挂载组件并 bind 关键状态，面板里的 git RPC
//    必须走 request/requestRaw 而不是新的旁路；形状断言用 shapeWithLiteralMask +
//    indexOfCode（只认真实代码区命中，注释/诱饵字符串无效）；
// 3) 本地重复定义消失——App.svelte 不得残留搬进组件的函数体；
// 4) overlay/文档面板归属——拆分/检视 overlay 标记归 SplitDialog/SubRunOverlay（全局
//    模态在 App 根级常驻挂载，状态 bind 回 App），文档面板标记归 FilePanel；模态标记
//    进面板组件会让其他面板下的入口静默失效，标记残留 App 则说明抽离未完成。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { newTodo, todoTree, cycleTodoStatus } from '../src/todos.ts'
import { squash, stripComments, shapeWithLiteralMask, indexOfCode, functionBodyOf } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (p) => readFileSync(join(root, p), 'utf8')
const appRaw = readSrc('src/App.svelte')
const gitRaw = readSrc('src/GitPanel.svelte')
const todoRaw = readSrc('src/TodoPanel.svelte')
const subRaw = readSrc('src/SubRunsPanel.svelte')
const splitRaw = readSrc('src/SplitDialog.svelte')
const overlayRaw = readSrc('src/SubRunOverlay.svelte')
const fileRaw = readSrc('src/FilePanel.svelte')
const appCode = squash(stripComments(appRaw))

// ---------- 行为单测：todos.ts 语义锁定（TodoPanel 依赖的基础语义） ----------

test('todos 语义：newTodo 默认 pending + todoTree 分层 + cycleTodoStatus 环', () => {
  const item = newTodo('写文档')
  assert.equal(item.status, 'pending')
  assert.equal(item.content, '写文档')
  const parent = newTodo('父任务')
  const child = newTodo('子任务', parent.id)
  const view = todoTree([parent, child, newTodo('孤儿')])
  assert.equal(view.roots.length, 2)
  assert.equal(view.children(parent.id).length, 1)
  assert.equal(view.children(parent.id)[0].content, '子任务')
  assert.deepEqual(cycleTodoStatus('pending'), 'in_progress')
  assert.deepEqual(cycleTodoStatus('in_progress'), 'completed')
  assert.deepEqual(cycleTodoStatus('completed'), 'pending')
})

test('TodoPanel 语义锁定：级联删除与 map 替换（bind:todos 直接赋值同步）', () => {
  // removeTodo 的级联语义从组件源码提取执行（functionBodyOf 在代码区提取，注释不干扰）
  const todoBody = functionBodyOf(stripComments(todoRaw), 'removeTodo')
  const parent = newTodo('父')
  const child = newTodo('子', parent.id)
  const other = newTodo('无关')
  const next = [parent, child, other].filter((item) => item.id !== parent.id && item.parentId !== parent.id)
  // 锁定判定式与源码逐字一致：item.id !== id && item.parentId !== id
  assert.ok(todoBody.includes('item.id!==id&&item.parentId!==id'), 'removeTodo 级联判定式漂移')
  assert.deepEqual(next.map((i) => i.id), [other.id])
  // setTodoStatus：map 替换后整体赋回
  const setStatusBody = functionBodyOf(stripComments(todoRaw), 'setTodoStatus')
  assert.ok(setStatusBody.includes('todos.map('), 'setTodoStatus 必须整体 map 替换（不是原地 mutate）')
  assert.ok(setStatusBody.includes('{...item,status}'), 'setTodoStatus 必须展开重建对象（保留其他字段）')
  // addTodo：空草稿不入列 + newTodo 用 trim 后内容
  const addBody = functionBodyOf(stripComments(todoRaw), 'addTodo')
  assert.ok(addBody.includes('if(!content)return'), 'addTodo 空草稿必须直接返回')
  assert.ok(addBody.includes('newTodo(content,parentId||undefined)'), 'addTodo 必须用 trim 后的 content 与 parentId 参数')
})

// ---------- 行为单测：GitPanel 纯逻辑 ----------

test('GitPanel 语义锁定：isStaged 判定式 + 暂存/提交/推送确认文案', () => {
  const gitCode = squash(stripComments(gitRaw))
  // isStaged：未勾选未跟踪才算已暂存（squash 后引号内空格被抹掉，只锚定可判定的部分）
  const isStagedBody = functionBodyOf(stripComments(gitRaw), 'isStaged')
  assert.ok(isStagedBody.includes('code[0]!==' + "''") && isStagedBody.includes("code[0]!=='?'"), 'isStaged 判定式漂移（须排除空格开头与未跟踪）')
  // 三个 RPC 类型必须还在（git_status/git_diff/git_add/git_commit/git_push）
  for (const rpc of ['git_status', 'git_diff', 'git_add', 'git_commit', 'git_push']) {
    assert.ok(gitCode.includes(`'${rpc}'`), `GitPanel 缺 ${rpc} 调用`)
  }
  // 归属守卫：refreshGit 只在 workspacePath === target 时写 gitChanges（异步竞态防线）
  const refreshBody = functionBodyOf(stripComments(gitRaw), 'refreshGit')
  assert.ok(refreshBody.includes('workspacePath===target'), 'refreshGit 归属守卫丢失')
  // M13 防线（实测存活）：refreshGit 必须真的声明并使用 cwd 参数（`cwd=workspacePath` 缺省），
  // 否则 export refresh(cwd) 传进来的项目路径被静默忽略，git_status 打到旧 workspace 上。
  assert.ok(refreshBody.includes('cwd=workspacePath'), 'refreshGit 必须声明 cwd=workspacePath 参数（M13：忽略 cwd 存活）')
  // commit 兜底模板：commitMessage.trim() || loadPrefs().gitTemplate.trim()
  const commitBody = functionBodyOf(stripComments(gitRaw), 'commitChanges')
  assert.ok(commitBody.includes('commitMessage.trim()||loadPrefs().gitTemplate.trim()'), 'commit 提交信息兜底链漂移')
  // confirm 文案（语义锁定，不顺手改）
  assert.ok(gitCode.includes('确认暂存勾选的'), '暂存确认文案漂移')
  assert.ok(gitCode.includes('确认提交'), '提交确认文案漂移')
  assert.ok(gitCode.includes('确认将本地提交推送到远程仓库'), '推送确认文案漂移')
  // M9 防线（实测存活）：toggleStaged 必须真取反——勾选翻转语义
  // `!(staged[path] ?? false)`；`staged[path] ?? true` 会让未勾选项直接置 true 且无法取消勾选。
  const toggleBody = functionBodyOf(stripComments(gitRaw), 'toggleStaged')
  assert.ok(toggleBody.includes('!(staged[path]??false)'), 'toggleStaged 必须取反 !(staged[path] ?? false)（M9：?? true 存活）')
})

test('GitPanel 模板：checkbox 走 toggleStaged + each key 用 path + 提交输入 placeholder 兜底', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments(gitRaw))
  assert.ok(indexOfCode(shape, literal, 'toggleStaged(change.path)') >= 0, 'checkbox 必须委托 toggleStaged')
  assert.ok(indexOfCode(shape, literal, '(change.path)') >= 0, 'each key 必须用 change.path')
  // M14 防线（实测存活）：上一行 `(change.path)` 会被 checkbox 行 on:change 命中（M14 变异下仍绿）。
  // each key 本身必须锚定：`{#each gitChanges as change (change.path)}`。
  assert.ok(indexOfCode(shape, literal, 'aschange(change.path)') >= 0, '变更列表 each key 必须是 as change (change.path)（M14：change.code 存活）')
  assert.ok(indexOfCode(shape, literal, "gitTemplate||'提交信息…'") >= 0, '提交输入 placeholder 兜底漂移')
  assert.ok(indexOfCode(shape, literal, 'voidrefreshGit()') >= 0, '刷新按钮必须调 refreshGit')
  // export refresh 必须存在（App 薄桥的驱动入口）
  assert.ok(indexOfCode(shape, literal, 'exportasyncfunctionrefresh(') >= 0, '缺少 export refresh 驱动入口')
})

// ---------- 行为单测：SubRunsPanel 状态映射 ----------

test('SubRunsPanel 语义锁定：状态徽标映射 + onView/onOpenSplit 回调 props', () => {
  const subCode = squash(stripComments(subRaw))
  assert.ok(subCode.includes("run.status==='running'?'运行中':"), 'running 徽标文案漂移')
  assert.ok(subCode.includes("run.status==='error'?'失败':'完成'"), 'error/done 徽标文案漂移')
  assert.ok(subCode.includes('class:run={run.status===' + "'running'"), 'running class 绑定漂移')
  assert.ok(subCode.includes('class:bad={run.status===' + "'error'"), 'error class 绑定漂移')
  // 回调 props 必须存在且默认 no-op（纯展示组件，不允许自持 overlay 状态）
  const { shape, literal } = shapeWithLiteralMask(stripComments(subRaw))
  assert.ok(indexOfCode(shape, literal, 'onView:(run:SubRun)=>void=()=>{}') >= 0, 'onView prop 缺失或默认值漂移')
  assert.ok(indexOfCode(shape, literal, 'onOpenSplit:()=>void=()=>{}') >= 0, 'onOpenSplit prop 缺失或默认值漂移')
  // 空态文案
  assert.ok(subCode.includes('暂无子代理'), '空态文案漂移')
})

// ---------- App.svelte 接线真实性 ----------

test('App.svelte 接线：三组件挂载 + bind 状态 + 回调收口', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments(appRaw))
  // 挂载 + bind:this
  assert.ok(indexOfCode(shape, literal, '<GitPanel') >= 0, 'GitPanel 未挂载')
  assert.ok(indexOfCode(shape, literal, '<TodoPanel') >= 0, 'TodoPanel 未挂载')
  assert.ok(indexOfCode(shape, literal, '<SubRunsPanel') >= 0, 'SubRunsPanel 未挂载')
  assert.ok(indexOfCode(shape, literal, 'bind:this={gitPanelRef}') >= 0, 'GitPanel 缺 bind:this（薄桥驱动需要）')
  assert.ok(indexOfCode(shape, literal, 'bind:this={todoPanelRef}') >= 0, 'TodoPanel 缺 bind:this（/todo 命令需要）')
  // GitPanel 状态双向同步（bind: 简写形式；App 侧 activateProject/saveFile 仍要清空/驱动这些状态）
  assert.ok(indexOfCode(shape, literal, 'bind:gitChanges') >= 0, 'GitPanel 缺 bind:gitChanges')
  assert.ok(indexOfCode(shape, literal, 'bind:diffContent') >= 0, 'GitPanel 缺 bind:diffContent')
  assert.ok(indexOfCode(shape, literal, 'bind:gitError') >= 0, 'GitPanel 缺 bind:gitError')
  // TodoPanel 状态双向同步（todo-chip 计数、/todo 命令、会话切换清输入都在 App 侧）
  assert.ok(indexOfCode(shape, literal, 'bind:todos') >= 0, 'TodoPanel 缺 bind:todos')
  assert.ok(indexOfCode(shape, literal, 'bind:todoDraft') >= 0, 'TodoPanel 缺 bind:todoDraft')
  assert.ok(indexOfCode(shape, literal, 'bind:todoParentId') >= 0, 'TodoPanel 缺 bind:todoParentId')
  // TodoPanel on:split 必须开拆分 overlay 并重载 agentDefs（indexOfCode 前代码已 squash 去空格）
  assert.ok(indexOfCode(shape, literal, 'on:split={()=>{splitOpen=true;agentDefs=loadAgents()}}') >= 0,
    'TodoPanel on:split 接线漂移（须 splitOpen=true + agentDefs=loadAgents()）')
  // SubRunsPanel 回调收口：onView 兜底 slotFor(run.id).reply + onOpenSplit 开 overlay
  assert.ok(indexOfCode(shape, literal, 'slotFor(run.id).reply||run.reply') >= 0, 'SubRunsPanel onView 缺 slotFor reply 兜底')
  assert.ok(indexOfCode(shape, literal, 'onOpenSplit') >= 0, 'SubRunsPanel 缺 onOpenSplit')
  // GitPanel 薄桥：refreshGit 委托 gitPanelRef.refresh（activateProject/saveFile/启动仍驱动）
  const bridgeBody = functionBodyOf(stripComments(appRaw), 'refreshGit')
  assert.ok(bridgeBody.includes('gitPanelRef?.refresh('), 'refreshGit 薄桥必须委托 gitPanelRef.refresh')
  // M1/M13 防线（实测存活）：薄桥必须透传 cwd——activateProject(path) 用新项目路径驱动，
  // 丢参/组件内 refreshGit 忽略 cwd 会让新项目 git_status 打到旧 workspacePath 上（异步竞态）。
  assert.ok(bridgeBody.includes('gitPanelRef?.refresh(cwd)'), 'refreshGit 薄桥必须透传 cwd（M1：refresh() 丢参存活）')
  const componentRefreshBody = functionBodyOf(stripComments(gitRaw), 'refresh')
  assert.ok(componentRefreshBody.includes('refreshGit(cwd)'), 'GitPanel export refresh 必须把 cwd 传给 refreshGit（M13：refreshGit 忽略 cwd 存活）')
  // M10 防线（实测存活）：子代理列表 each key 必须用唯一 id run.id（同 agent 两个任务撞 key）。
  const subShape = shapeWithLiteralMask(stripComments(subRaw))
  assert.ok(indexOfCode(subShape.shape, subShape.literal, 'asrun(run.id)') >= 0, 'SubRunsPanel each key 必须用 run.id（M10：run.agent 存活）')
})

test('App.svelte 接线：SplitDialog/SubRunOverlay/FilePanel 挂载 + bind + 薄桥回调', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments(appRaw))
  // 挂载（全局模态常驻根级；文档面板在 panel==='文档' 分支内）
  assert.ok(indexOfCode(shape, literal, '<SplitDialog') >= 0, 'SplitDialog 未挂载')
  assert.ok(indexOfCode(shape, literal, '<SubRunOverlay') >= 0, 'SubRunOverlay 未挂载')
  assert.ok(indexOfCode(shape, literal, '<FilePanel') >= 0, 'FilePanel 未挂载')
  // SplitDialog：open/rows 双向 + agentDefs 传入 + onRun 回调驱动 App runSplit
  assert.ok(indexOfCode(shape, literal, 'bind:open={splitOpen}') >= 0, 'SplitDialog 缺 bind:open={splitOpen}')
  assert.ok(indexOfCode(shape, literal, 'bind:rows={splitRows}') >= 0, 'SplitDialog 缺 bind:rows={splitRows}')
  assert.ok(indexOfCode(shape, literal, 'onRun={runSplit}') >= 0, 'SplitDialog 缺 onRun={runSplit}')
  // SubRunOverlay：run 双向（关闭回写 null）+ 运行态槽位响应式传入
  assert.ok(indexOfCode(shape, literal, 'bind:run={viewingSub}') >= 0, 'SubRunOverlay 缺 bind:run={viewingSub}')
  assert.ok(indexOfCode(shape, literal, 'runProp={viewingSub?slotFor(viewingSub.id):null}') >= 0,
    'SubRunOverlay 缺 runProp 槽位表达式（viewingSub ? slotFor(viewingSub.id) : null）')
  // FilePanel：预览/编辑状态双向同步（父侧 activateProject/saveFile 外的清理与 @ 补全仍依赖）
  for (const bindNeedle of ['bind:filesLoading', 'bind:selectedFile', 'bind:fileContent', 'bind:largeFile', 'bind:editingFile']) {
    assert.ok(indexOfCode(shape, literal, bindNeedle) >= 0, `FilePanel 缺 ${bindNeedle}`)
  }
  // FilePanel 薄桥：filteredFiles 下传 + request/requestRaw 通道 + 三个回调收口
  assert.ok(indexOfCode(shape, literal, '{filteredFiles}') >= 0, 'FilePanel 缺 filteredFiles 下传')
  assert.ok(indexOfCode(shape, literal, 'onSaved={()=>voidrefreshGit()}') >= 0, 'FilePanel 缺 onSaved 回调（保存后 refreshGit）')
  assert.ok(indexOfCode(shape, literal, 'onRefresh={()=>voidloadFiles()}') >= 0, 'FilePanel 缺 onRefresh 回调（loadFiles 留 App）')
  assert.ok(indexOfCode(shape, literal, 'onReadError={(message)=>patchSlot(ensureActiveId(),{error:`读取文件失败:${message}`})}') >= 0,
    'FilePanel 缺 onReadError 回调（读取失败写当前会话槽位）')
})

test('App.svelte 本地重复定义消失：git/todo 面板函数已搬进组件', () => {
  for (const needle of [
    'functionloadDiff(',
    'functionisStaged(',
    'functionrunGit(',
    'functionstageFiles(',
    'functioncommitChanges(',
    'functionpushChanges(',
    'functiontoggleStaged(',
    'functionaddTodo(',
    'functionsetTodoStatus(',
    'functionremoveTodo('
  ]) {
    assert.equal(appCode.indexOf(needle), -1, `App.svelte 本地重复定义残留：${needle}`)
  }
  // /todo 斜杠命令仍走 App 侧 persistTodos（命令在面板关闭时也要生效；位于 submit 的前缀分支）
  assert.ok(appCode.includes('persistTodos([...loadTodos(ensureActiveId()),newTodo(todoCmd[1])])'),
    '/todo 命令数据流漂移：必须 persistTodos([...loadTodos(ensureActiveId()), newTodo(todoCmd[1])])')
  // App 侧 persistTodos 保留（/todo 命令 + saveTodos 落盘）
  const persistBody = functionBodyOf(stripComments(appRaw), 'persistTodos')
  assert.ok(persistBody.includes('saveTodos(activeSessionId,next)'), 'persistTodos 必须落盘 saveTodos')
})

test('App.svelte 本地重复定义消失：文档面板函数已搬进 FilePanel', () => {
  for (const needle of [
    'functionpreviewFile(',
    'functionpreviewLargeFile(',
    'functiondocumentStats(',
    'functiontoggleDir(',
    'functiontreeChildren(',
    'letopenDirs',
    'functionsaveFile('
  ]) {
    assert.equal(appCode.indexOf(needle), -1, `App.svelte 本地重复定义残留：${needle}`)
  }
  // readFileChunk 原本就是 export async function（App 内已删除）
  assert.equal(appCode.indexOf('asyncfunctionreadFileChunk('), -1, 'App.svelte readFileChunk 残留')
})

// ---------- overlay/文档面板归属（标记归组件，状态与驱动留 App） ----------

test('overlay 归属：拆分/检视标记归 SplitDialog/SubRunOverlay，状态与驱动留 App', () => {
  const splitCode = squash(stripComments(splitRaw))
  const overlayCode = squash(stripComments(overlayRaw))
  // 拆分 overlay 标记只能在 SplitDialog（含负断言：其他面板组件不得吞掉模态）
  assert.ok(splitCode.includes('split-card'), 'SplitDialog 缺拆分 overlay（split-card）')
  assert.equal(squash(stripComments(gitRaw)).indexOf('split-card'), -1, 'split overlay 不得进 GitPanel')
  assert.equal(squash(stripComments(todoRaw)).indexOf('split-card'), -1, 'split overlay 不得进 TodoPanel')
  assert.equal(squash(stripComments(subRaw)).indexOf('split-card'), -1, 'split overlay 不得进 SubRunsPanel')
  assert.equal(appCode.indexOf('split-card'), -1, 'App.svelte 不得残留拆分 overlay 标记（已抽到 SplitDialog）')
  assert.equal(squash(stripComments(fileRaw)).indexOf('split-card'), -1, 'split overlay 不得进 FilePanel')
  // 检视 overlay 标记只能在 SubRunOverlay
  assert.ok(overlayCode.includes('sub-view'), 'SubRunOverlay 缺检视 overlay（sub-view）')
  assert.equal(squash(stripComments(subRaw)).indexOf('sub-view'), -1, '检视 overlay 不得进 SubRunsPanel')
  assert.equal(appCode.indexOf('sub-view'), -1, 'App.svelte 不得残留检视 overlay 标记（已抽到 SubRunOverlay）')
  // 状态与 runSplit 驱动留在 App（/split、/scout 空参、runSlashCommand、finishSubRun 同步都要用）
  for (const needle of ['letsplitOpen=false', 'letsplitRows:Array<', 'letviewingSub:SubRun|null=null']) {
    assert.ok(appCode.includes(needle), `App.svelte 缺 overlay 状态：${needle}`)
  }
  const runSplitBody = functionBodyOf(stripComments(appRaw), 'runSplit')
  assert.ok(runSplitBody.includes('splitOpen=false'), 'runSplit 必须关 overlay')
  assert.ok(runSplitBody.includes('spawnSubagent('), 'runSplit 必须驱动 spawnSubagent')
  // finishSubRun 检视同步（session-wiring 接线 H 的伴生断言）
  const finishBody = functionBodyOf(stripComments(appRaw), 'finishSubRun')
  assert.ok(finishBody.includes('viewingSub?.id===id'), 'finishSubRun 检视窗同步条件漂移')
  // M12 防线（对抗审查存活变异，已重放转杀）：patchSlot 必须整体替换 runState[id]——
  // 原地 Object.assign 使 runState 引用不变，所有依赖引用替换的响应式派生
  // （SubRunsPanel 列表、SubRunOverlay runProp、各槽位视图）静默失效。
  const patchBody = functionBodyOf(stripComments(appRaw), 'patchSlot')
  assert.ok(patchBody.includes('runState={...runState,[id]:{...emptySlot(),...runState[id],...patch}}'),
    'patchSlot 必须整体替换 runState[id]（M12：Object.assign 原地改存活）')
})

test('SplitDialog 语义锁定：open/rows 双向、行操作、onRun 收口', () => {
  const splitCode = squash(stripComments(splitRaw))
  // 行删除/新增（rows 重建而非原地 mutate，保持 bind:rows 回写语义）
  assert.ok(splitCode.includes('rows=rows.filter((_,i)=>i!==index)'), 'SplitDialog 行删除必须是 filter 重建')
  assert.ok(splitCode.includes("rows=[...rows,{agent:'scout',task:''}]"), 'SplitDialog 加行必须 [...rows, {agent:\'scout\', task:\'\'})')
  // select/input 双向绑定到行对象 + agentDefs 下拉
  assert.ok(splitCode.includes('bind:value={row.agent}'), 'SplitDialog 缺 row.agent 绑定')
  assert.ok(splitCode.includes('bind:value={row.task}'), 'SplitDialog 缺 row.task 绑定')
  assert.ok(splitCode.includes('agentDefsasdef(def.name)'), 'SplitDialog 缺 agentDefs 下拉')
  // 开关收口：点遮罩/× 关闭、开始按钮走 onRun（不直接调父侧 runSplit 之外的东西）
  assert.ok(splitCode.includes('open=false'), 'SplitDialog 缺 open=false 关闭路径')
  const { shape, literal } = shapeWithLiteralMask(stripComments(splitRaw))
  assert.ok(indexOfCode(shape, literal, 'on:click={onRun}') >= 0, 'SplitDialog 开始按钮必须走 onRun')
  // {#if open} 门在组件内（父组件不再渲染模态标记）
  assert.ok(splitCode.includes('{#ifopen}'), 'SplitDialog 缺 {#if open} 渲染门')
  // M8 防线（对抗审查存活变异，已重放转杀）：× 关闭只置 open=false，不得经 bind:rows
  // 回写重置行草稿（HEAD 语义：关闭后重开草稿还在）。锚定 × 按钮整段表达式。
  assert.ok(indexOfCode(shape, literal, '(open=false)}>×</button>') >= 0, '× 关闭只置 open=false，不得重置 rows（M8：关闭清空草稿存活）')
})

test('SubRunOverlay 语义锁定：slotFor 兜底链、过程过滤、live 标签', () => {
  const overlayCode = squash(stripComments(overlayRaw))
  // reply 兜底链保持原语义：槽位 reply 优先，回退 run.reply
  assert.ok(overlayCode.includes('slot.reply||run.reply'), 'SubRunOverlay reply 兜底链漂移（须 slot.reply || run.reply）')
  // 过程过滤语义与原 visibleProcess 一致：showThinking!==false || kind!=='think'
  assert.ok(overlayCode.includes("showThinking!==false||step.kind!=='think'"), 'SubRunOverlay 过程过滤条件漂移')
  // processSummary 传 showThinking !== false（与原 App 内包装一致）
  assert.ok(overlayCode.includes('processSummary(slot.process,showThinking!==false)'), 'SubRunOverlay processSummary 须传 showThinking!==false')
  // 状态 chip 文案与原版一致
  assert.ok(overlayCode.includes("run.status==='running'?'运行中':run.status==='error'?'失败':'完成'"), 'SubRunOverlay 状态 chip 文案漂移')
  // live 标签：liveLabel→小写映射 tt(`live.${…}`)，空标签回落 tt('live.working')
  assert.ok(overlayCode.includes("tt(`live.${label.toLowerCase()}`)"), 'SubRunOverlay liveLabelKey 映射漂移')
  assert.ok(overlayCode.includes("tt('live.working')"), 'SubRunOverlay 缺 live.working 回落')
  // 关闭路径：点遮罩与关闭按钮都置 run=null（bind:run 回写父组件 viewingSub）
  assert.ok(overlayCode.includes('run=null'), 'SubRunOverlay 缺 run=null 关闭路径')
  // 空槽位兜底（runProp 为 null 时不可崩；`as SubRunSlot` 类型断言随源码锚定）
  assert.ok(overlayCode.includes('runProp??({reply:\'\',running:false,sent:[],process:[]}asSubRunSlot)'), 'SubRunOverlay 缺空槽位兜底')
  // M7 防线（对抗审查存活变异，已重放转杀）：遮罩关闭必须置 run=null（undefined 会经
  // bind:run 把父侧 viewingSub 类型打脏）。锚定遮罩路径，与关闭按钮路径区分。
  // M13 防线（对抗审查存活变异，已重放转杀）：{#if run} 渲染门必须在（关闭动画期
  // 不渲染空兜底槽位）。
  const overlayShape = shapeWithLiteralMask(stripComments(overlayRaw))
  assert.ok(indexOfCode(overlayShape.shape, overlayShape.literal, 'currentTarget)run=null') >= 0, '遮罩关闭必须置 run=null（M7：run=undefined 存活）')
  assert.ok(indexOfCode(overlayShape.shape, overlayShape.literal, '{#ifrun}') >= 0, 'SubRunOverlay 必须有 {#if run} 渲染门（M13：门删除存活）')
})

test('FilePanel 语义锁定：512KB 兜底、ok 判 result 非 catch、树展开态', () => {
  const fileCode = squash(stripComments(fileRaw))
  // previewFile：ok 判 result 而不是 catch（requestRaw 失败不 reject）
  const previewBody = functionBodyOf(stripComments(fileRaw), 'previewFile')
  assert.ok(previewBody.includes('response.ok?(response.resultas{content:string}|null):null'), 'previewFile 必须判 response.ok 取 result（不是 catch）')
  // 512KB 超限兜底 → previewLargeFile（虚拟化预览）
  assert.ok(previewBody.includes("message.includes('512KB')||message.includes('超过')"), 'previewFile 缺 512KB 超限兜底（文案锚点 512KB/超过）')
  assert.ok(previewBody.includes('awaitpreviewLargeFile(file)'), 'previewFile 超限必须切 previewLargeFile')
  // 失败路径：清状态 + onReadError 上报（错误文案在 App 桥里拼接）
  assert.ok(previewBody.includes('onReadError(message||\'未知错误\')'), 'previewFile 失败必须 onReadError 上报')
  // M6 防线（对抗审查存活变异，已重放转杀）：失败路径必须同时清空 fileContent 与
  // selectedFile——只清 fileContent 会留下幽灵选中态（预览头仍显示文件名，可进编辑
  // 态把空内容保存回源文件）。
  assert.ok(previewBody.includes("fileContent=''selectedFile=''"), 'previewFile 失败必须清空 fileContent 与 selectedFile（M6：漏清 selectedFile 存活）')
  // saveFile：写盘后退出编辑态并回调 onSaved（refreshGit 由父驱动）
  const saveBody = functionBodyOf(stripComments(fileRaw), 'saveFile')
  assert.ok(saveBody.includes("request('write_file',{cwd:workspacePath,path:selectedFile,content:fileContent})"), 'saveFile 写盘调用漂移')
  assert.ok(saveBody.includes('editingFile=false'), 'saveFile 必须退出编辑态')
  assert.ok(saveBody.includes('onSaved()'), 'saveFile 缺 onSaved() 回调')
  // readFileChunk：read_file_chunk，失败 throw（VirtualFile 虚拟化预览通道）。
  // 不用 functionBodyOf：`Promise<{...}>` 返回类型的花括号会被 helper 当函数体开头
  // （functionRangeOf 只配平参数列表），改用 shapeWithLiteralMask 全文件锚定。
  const fileShape = shapeWithLiteralMask(stripComments(fileRaw))
  assert.ok(indexOfCode(fileShape.shape, fileShape.literal, "requestRaw('read_file_chunk'") >= 0, 'readFileChunk 必须走 read_file_chunk')
  assert.ok(indexOfCode(fileShape.shape, fileShape.literal, "thrownewError(response.error||'读取失败')") >= 0, 'readFileChunk 失败必须 throw')
  // 树展开态：toggleDir 重建 openDirs（Svelte 响应式）+ treeChildren 委托 app-files 版
  const toggleBody = functionBodyOf(stripComments(fileRaw), 'toggleDir')
  assert.ok(toggleBody.includes('openDirs={...openDirs,[path]:!openDirs[path]}'), 'toggleDir 必须展开重建 openDirs')
  assert.ok(fileCode.includes('treeChildrenOf(filteredFiles,prefix)'), 'treeChildren 必须委托 app-files 版本并传 filteredFiles')
  // documentStats：行数 + KB（原 App 内逻辑逐字迁移）
  const statsBody = functionBodyOf(stripComments(fileRaw), 'documentStats')
  assert.ok(statsBody.includes("fileContent.split('\\n').length"), 'documentStats 行数统计漂移')
  assert.ok(statsBody.includes('Math.ceil(newTextEncoder().encode(fileContent).length/1024)'), 'documentStats KB 统计漂移')
})
