<script lang="ts">
  // 0-5 批次 B-2：从 App.svelte 抽出的「待办」面板模板。
  // 状态（todos/todoDraft/todoParentId）的**权威源仍在 App.svelte**，经 bind: 双向同步：
  // todo-chip 计数、/todo 斜杠命令、会话切换都要在 App 侧直接读写这些状态，
  // 面板组件只在「待办」分支内挂载，自持状态会让这些入口在面板关闭时静默失效。
  // 增删改逻辑（persistTodos/addTodo/setTodoStatus/removeTodo）同样留在 App——
  // 本组件只绑定状态 + 上报意图（on:split 打开并行拆分 overlay）。
  import { createEventDispatcher } from 'svelte'
  import Icon from './Icon.svelte'
  import { cycleTodoStatus, newTodo, todoTree, type TodoItem, type TodoStatus } from './todos'

  const dispatch = createEventDispatcher<{ split: void }>()

  export let todos: TodoItem[] = []
  export let todoDraft = ''
  export let todoParentId = ''

  $: todoView = todoTree(todos)

  function setTodoStatus(id: string, status: TodoStatus) {
    // 与 App 侧 persistTodos 同形：map 替换后整体赋回（bind: 自动同步）
    todos = todos.map((item) => item.id === id ? { ...item, status } : item)
  }

  function removeTodo(id: string) {
    // 级联删除：子项（parentId === id）一并移除
    todos = todos.filter((item) => item.id !== id && item.parentId !== id)
  }

  function addTodo(parentId?: string) {
    const content = todoDraft.trim()
    if (!content) return
    todos = [...todos, newTodo(content, parentId || undefined)]
    todoDraft = ''
    todoParentId = ''
  }
</script>

<div class="todo-panel">
  <div class="resource-head"><span>任务清单</span><button type="button" on:click={() => dispatch('split')}>拆分</button></div>
  <div class="todo-add"><input bind:value={todoDraft} placeholder={todoParentId ? '子任务…' : '添加任务，Enter'} on:keydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTodo(todoParentId || undefined) } }} /><button type="button" aria-label="添加任务" on:click={() => addTodo(todoParentId || undefined)}><Icon name="plus" size={12} strokeWidth={1.9} /></button></div>
  {#if todoParentId}<div class="todo-hint">正在给「{todos.find((item) => item.id === todoParentId)?.content ?? ''}」添加子任务 <button type="button" on:click={() => (todoParentId = '')}>取消</button></div>{/if}
  <div class="todo-list">
    {#each todoView.roots as item (item.id)}
      <div class="todo-item" class:done={item.status === 'completed'} class:doing={item.status === 'in_progress'}>
        <button class="todo-check" type="button" on:click={() => setTodoStatus(item.id, cycleTodoStatus(item.status))}>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}</button>
        <span>{item.content}</span>
        <button type="button" class="todo-mini" on:click={() => (todoParentId = item.id)}>子项</button>
        <button type="button" class="todo-mini" on:click={() => removeTodo(item.id)}>×</button>
      </div>
      {#each todoView.children(item.id) as child (child.id)}
        <div class="todo-item child" class:done={child.status === 'completed'} class:doing={child.status === 'in_progress'}>
          <button class="todo-check" type="button" on:click={() => setTodoStatus(child.id, cycleTodoStatus(child.status))}>{child.status === 'completed' ? '✓' : child.status === 'in_progress' ? '◐' : '○'}</button>
          <span>{child.content}</span>
          <button type="button" class="todo-mini" on:click={() => removeTodo(child.id)}>×</button>
        </div>
      {/each}
    {:else}
      <div class="resource-empty">还没有任务。用右侧添加，或发送 /todo 某件事。</div>
    {/each}
  </div>
</div>
