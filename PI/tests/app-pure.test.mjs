// 0-5 拆分批次 A：app-models.ts / app-files.ts 行为单测
//
// 抽取防线：断言的不只是"函数行为正确"，还包括"App.svelte 真的在用模块版"——
// 两轮对抗审查的教训是源码形状断言可被注释/诱饵欺骗，所以接线断言用
// shapeWithLiteralMask + indexOfCode（只认真实代码区命中）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  MODEL_SEPARATOR,
  THINKING_LEVELS,
  THINKING_LABELS,
  THINKING_HELP,
  DEFAULT_THINKING,
  MODE_LABELS,
  MODE_OPTIONS,
  modelKey,
  modelGroups,
  modelChoice,
  thinkingChoice,
  sessionMode
} from '../src/app-models.ts'
import { fileName, treeChildren, projectName, workspaceBase } from '../src/app-files.ts'
import { squash, stripComments, shapeWithLiteralMask, indexOfCode } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- app-models：常量 ----------

test('常量与 SDK 对齐：MODEL_SEPARATOR/THINKING_LEVELS/DEFAULT_THINKING', () => {
  assert.equal(MODEL_SEPARATOR, '\u0000')
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(DEFAULT_THINKING, 'medium')
  for (const level of THINKING_LEVELS) {
    assert.ok(THINKING_LABELS[level], `THINKING_LABELS 缺 ${level}`)
    assert.ok(THINKING_HELP[level], `THINKING_HELP 缺 ${level}`)
  }
  assert.deepEqual(MODE_OPTIONS.map((o) => o.value), ['plan', 'ask', 'full'])
  assert.equal(MODE_LABELS.plan, '计划')
})

// ---------- app-models：modelKey / modelGroups ----------

test('modelKey 用 \\u0000 分隔，provider/id 含常见标点也不碰撞', () => {
  assert.equal(modelKey({ provider: 'a', id: 'b' }), 'a\u0000b')
  // 旧式 "provider:id" 分隔在这组输入下会碰撞；\u0000 不会
  assert.notEqual(modelKey({ provider: 'x:y', id: 'z' }), modelKey({ provider: 'x', id: 'y:z' }))
})

test('modelGroups 按 provider 聚合并保序', () => {
  const list = [
    { provider: 'b', id: '1', name: 'B1', reasoning: false },
    { provider: 'a', id: '1', name: 'A1', reasoning: false },
    { provider: 'b', id: '2', name: 'B2', reasoning: true },
    { provider: 'a', id: '2', name: 'A2', reasoning: false }
  ]
  const groups = modelGroups(list)
  assert.deepEqual(groups.map((g) => g.provider), ['b', 'a'])
  assert.deepEqual(groups[0].items.map((m) => m.id), ['1', '2'])
  // 输入不被修改
  assert.equal(list.length, 4)
})

// ---------- app-models：modelChoice / thinkingChoice / sessionMode ----------

const MODELS = [
  { provider: 'p', id: 'm1', name: 'M1', reasoning: false },
  { provider: 'p', id: 'm2', name: 'M2', reasoning: true }
]

test('modelChoice：有会话记忆且模型仍在列表 → 用记忆；否则回退第一项', () => {
  const records = [{ id: 's1', model: modelKey(MODELS[1]) }]
  assert.equal(modelChoice(MODELS, records, 's1'), modelKey(MODELS[1]))
  // 记忆的模型不在列表（被删）→ 回退第一项
  assert.equal(modelChoice(MODELS, [{ id: 's1', model: 'gone\u0000x' }], 's1'), modelKey(MODELS[0]))
  // 无记忆 → 第一项；空列表 → ''
  assert.equal(modelChoice(MODELS, [], 's1'), modelKey(MODELS[0]))
  assert.equal(modelChoice([], [], 's1'), '')
})

test('thinkingChoice/sessionMode：缺省回落 medium / ask', () => {
  assert.equal(thinkingChoice([{ id: 's1', thinking: 'high' }], 's1'), 'high')
  assert.equal(thinkingChoice([], 's1'), 'medium')
  assert.equal(sessionMode([{ id: 's1', mode: 'plan' }], 's1'), 'plan')
  assert.equal(sessionMode([], 's1'), 'ask')
})

// ---------- app-files ----------

test('fileName 取 / 尾段（保留原语义：不切反斜杠）', () => {
  assert.equal(fileName('a/b/c.txt'), 'c.txt')
  assert.equal(fileName('only.txt'), 'only.txt')
  // 原实现只按 '/' 切 —— Windows 反斜杠路径整体返回（语义锁定，防止抽取时"顺手修复"改变行为）
  assert.equal(fileName('C:\\x\\y.txt'), 'C:\\x\\y.txt')
  assert.equal(fileName(''), '')
})

test('treeChildren：根层取无 / 条目，子层取带前缀的条目（原实现语义：返回完整 path，不剥前缀）', () => {
  const files = [
    { path: 'a.txt', kind: 'file' },
    { path: 'src', kind: 'directory' },
    { path: 'src/index.ts', kind: 'file' },
    { path: 'src/deep', kind: 'directory' },
    { path: 'src/deep/x.ts', kind: 'file' }
  ]
  assert.deepEqual(treeChildren(files, '').map((f) => f.path), ['a.txt', 'src'])
  // 原实现（App.svelte :313-319）返回的是原始 path（模板据此判目录/取 openDirs），不剥前缀——语义锁定
  assert.deepEqual(treeChildren(files, 'src').map((f) => f.path), ['src/index.ts', 'src/deep'])
  assert.deepEqual(treeChildren(files, 'src/deep').map((f) => f.path), ['src/deep/x.ts'])
  // 前缀必须是目录边界：'sr' 不匹配 'src/...'
  assert.deepEqual(treeChildren(files, 'sr'), [])
  // 不修改输入
  assert.equal(files.length, 5)
})

test('projectName/workspaceBase：双分隔符尾段与 "." 特例', () => {
  assert.equal(projectName('D:\\work\\my-app'), 'my-app')
  assert.equal(projectName('/home/u/proj/'), 'proj')
  assert.equal(projectName('weird'), 'weird')
  assert.equal(workspaceBase('.'), '当前目录')
  assert.equal(workspaceBase('D:\\work\\my-app'), 'my-app')
  // 原实现 split 后 pop，尾分隔符得到空串 → 空串回落整串（语义锁定，不"顺手修复"）
  assert.equal(workspaceBase('/a/b/'), '/a/b/')
})

// ---------- 接线真实性（App.svelte 真的用模块版，本地重复已删）----------

test('App.svelte 接线：从模块 import 且本地重复定义已删除', () => {
  const raw = readFileSync(join(root, 'src/App.svelte'), 'utf8')
  const code = squash(stripComments(raw))
  // import 行真实存在（代码区命中，诱饵/注释无效）
  const { shape, literal } = shapeWithLiteralMask(stripComments(raw))
  assert.ok(indexOfCode(shape, literal, "from'./app-models'") >= 0, '缺少 app-models import')
  assert.ok(indexOfCode(shape, literal, "from'./app-files'") >= 0, '缺少 app-files import')
  // 本地重复定义已删（原 :279-289 常量与 :888-915 函数不能再出现）
  for (const needle of [
    'constMODEL_SEPARATOR=',
    'constTHINKING_LEVELS=',
    'constDEFAULT_THINKING=',
    'functionmodelKey(',
    'functionmodelGroups(',
    'functionmodelChoice(',
    'functionthinkingChoice(',
    'functionsessionMode(',
    'functionfileName(',
    'functionprojectName('
  ]) {
    assert.equal(code.indexOf(needle), -1, `本地重复定义残留：${needle}`)
  }
  // 零参 workspaceBase 调用不再存在（抽取后签名带 workspacePath 参数）
  assert.equal(code.indexOf('workspaceBase()'), -1, 'workspaceBase() 零参调用残留')
  // treeChildren 委托模块版（app-files 的 treeChildren 以别名导入）——0-5 批次 B-5 后
  // 该委托随文件树移入 FilePanel.svelte（App 只保留 filteredFiles 计算）
  const filePanelCode = squash(stripComments(readFileSync(join(root, 'src/FilePanel.svelte'), 'utf8')))
  assert.ok(filePanelCode.includes('treeChildrenOf(filteredFiles,prefix)'), 'FilePanel 的 treeChildren 必须委托 app-files 版本并传 filteredFiles')
  // 模块自身禁状态：app-models/app-files 不含 let/组件依赖
  for (const mod of ['src/app-models.ts', 'src/app-files.ts']) {
    const modCode = squash(stripComments(readFileSync(join(root, mod), 'utf8')))
    assert.equal(modCode.indexOf('letrunState'), -1)
    assert.ok(!/\blet\s+[A-Za-z_]/.test(modCode.replace(/exportinterface/g, '')), `${mod} 出现 let 状态声明`)
  }
})
