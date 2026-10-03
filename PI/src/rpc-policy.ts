// sidecar 请求的等待策略（纯函数，可单测）
//
// 为什么需要它：旧实现里 `request()` 的 Promise 没有超时。一旦 sidecar 因为某个
// 请求永久挂住（例如扩展钩子里的 await 永不 resolve）或进程悄悄死掉，`pending`
// 条目就永久泄漏、调用方的 `await` 永不 settle——界面表现为"一直转圈、点什么都不
// 响应"，且没有任何错误提示，用户只能重启应用。
//
// 但不能一刀切给所有请求加同一个超时：以下请求**天然就是要等很久**的，用 30 秒
// 超时会把正常功能打断：
//   - oauth_login     等待用户去浏览器完成 OAuth 授权（可能几分钟）
//   - update_pi_sdk   要跑 npm install 下载 SDK（sidecar 侧 180s 超时）
//   - generate_image  生图接口（sidecar 侧 180s 超时）
//   - vision_describe 视觉模型推理（sidecar 侧 120s 超时）
// 所以按请求类型分档；未知类型回落到一个保守的默认值。

/** 默认超时：普通元数据类请求（列模型、读设置、Git 状态…）不该超过这个时间 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 已知的长耗时请求。键必须与 sidecar 的 handle() 分支保持一致。 */
export const TIMEOUT_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  // 等待人类操作：给足 15 分钟（OAuth 设备码本身就是这个量级的有效期），
  // 但不设 Infinity —— P0-F 的目的就是"任何请求都不会永久挂住"。
  oauth_login: 900_000,
  login_prompt_response: DEFAULT_TIMEOUT_MS,

  // npm / 网络下载类
  update_pi_sdk: 300_000,
  eco_install_package: 300_000,
  eco_uninstall_package: 180_000,
  eco_install_skill: 60_000,
  eco_install_prompt: 30_000,
  eco_install_imagegen: 30_000,
  eco_download_pet: 180_000,

  // 外部 API 推理 / 抓取类
  generate_image: 240_000,
  vision_describe: 180_000,
  check_agent_update: 60_000,
  lookup_model_hints: 90_000,
  fetch_models: 60_000,
  fetch_balance: 60_000,
  test_provider: 60_000,
  usage_probe: 60_000,
  eco_search_prompts: 60_000,
  eco_search_skills: 60_000,
  eco_search_extensions: 60_000,
  eco_xue: 30_000,
  eco_list: 30_000,
  eco_pet_status: 30_000,

  // 磁盘 IO 可能较慢（大仓库 / 大量会话）
  init: 120_000,
  compact_session: 300_000,
  export_session_html: 60_000,
  // 2-3 worktree 分叉：git worktree add + SDK 会话创建（10-40s）
  create_worktree_fork: 90_000,
  // 2-5 Markdown 导出：与 HTML 导出同档（读全部消息 + 序列化）
  export_session_md: 60_000,
  // 2-14 项目信任：写信任文件 + 读信任状态（轻量 JSON 操作）
  trust_project: 10_000,
  get_project_trust: 10_000,
  // 2-8/U4 provider 额度：并发探针（每个 10s 超时，最多 12 个，取上界）
  provider_quotas: 30_000,
  // 1-2 上下文蒸发：会话级自动压缩开关
  get_auto_compaction: 10_000,
  set_auto_compaction: 10_000,
  // T1-① 缓存预热：会话级开关与状态轮询（状态读自 CacheWarmer 内存快照，快）
  get_cache_warming: 10_000,
  set_cache_warming: 10_000,
  // T1-② 压缩预算：读/写全局 settings 的 compaction.modelOverrides（本地 JSON 读改写）
  get_compaction_budget: 10_000,
  set_compaction_budget: 10_000,
  // 2-2 长期记忆：SQLite FTS5 查询（本地库，快）
  memory_search: 15_000,
  memory_remember: 10_000,
  memory_list: 15_000,
  memory_supersede: 10_000,
  memory_delete: 10_000,
  // 2-10 MCP 管理：读配置/写配置/连接测试（测试含最长 3s 进程冒烟）
  mcp_list: 15_000,
  mcp_save: 15_000,
  mcp_test: 30_000,
  // T2⑥ MCP 原生化：单服务器 enabled/exposure 编辑（SDK updateMcpServerConfig，本地 JSON）
  mcp_patch: 15_000,
  // T2⑦ 上下文编辑：buildContextEntries 全量列举（大会话可能几千条目）与追加 context_edit（append-only JSONL 写）
  list_context: 60_000,
  apply_context_edit: 30_000,
  // T2⑧ 生图别名层：与 generate_image 同档（转发旧实现，sidecar 侧 180s HTTP 超时）
  generate_images: 240_000,
  create_session: 120_000,
  open_session: 120_000,
  list_files: 120_000,
  list_sessions: 60_000,
  list_all_sessions: 120_000,
  usage_stats: 120_000,
  read_file: 60_000,
  // 2-12 分块读取：流式扫描到 offset+limit 行即返回
  read_file_chunk: 60_000,
  write_file: 60_000,
  read_attachment: 60_000,
  export_session: 60_000,
  fork_session: 60_000,
  config_read: 30_000,
  config_write: 60_000,
  config_cards: 30_000,
  refresh_models: 60_000,
  list_models: 60_000,
  list_providers: 30_000,
  // T1④⑤：提供商认证状态查询（只读快查）与 OAuth 登出（成功后 ensureRuntime(true) 刷新目录）
  auth_status: 60_000,
  auth_logout: 60_000,
  // T3-2 虚拟模型链：读校验/写配置+注册进 runtime（registerVirtualModel 触发目录重组），
  // 本地 JSON 读改写，给 memory_* 同档的保守超时。
  get_virtual_models: 10_000,
  set_virtual_models: 10_000,
  info: 30_000,

  // 会话内操作：瞬时返回（prompt 是 fire-and-forget，只回 accepted）
  prompt: 60_000,
  abort: 30_000,
  // 扩展 UI 对话框的回答：用户可能慢慢想，但必须有上限（否则又回到"永久挂住"）
  ui_dialog_response: 120_000,
  ext_ui_diagnostics: 15_000,
  list_ui_renderers: 15_000,
  read_ui_renderer_asset: 10_000,
  // 1-5 批次②：运行时重载扩展（session.reload() 重建 runner + 重新发现扩展文件）
  reload_extensions: 60_000,
  set_mode: 30_000,
  set_model: 30_000,
  set_thinking: 30_000,
  session_stats: 30_000,
  // 1-8 状态快照：聚合会话统计 + 模式 + 队列 + 工具集（peekState 语义，只读）
  get_state: 30_000,
  rename_session: 30_000,
  close_session: 30_000,
  set_session_archived: 30_000,
  delete_session: 30_000,
  confirm_response: 30_000,
  read_attachment_response: 30_000,

  // Git / 工作区
  set_workspace: 120_000,
  git_status: 60_000,
  git_diff: 60_000,
  git_add: 60_000,
  git_commit: 60_000,
  git_push: 120_000,

  // 本地轻量操作
  open_dir: 15_000,
  open_url: 15_000,
  log_tail: 15_000,
  lan_set: 30_000,
  lan_status: 15_000,
  proxy_get: 15_000,
  proxy_set: 15_000,
  vision_get: 15_000,
  vision_set: 15_000,
  usage_probes_get: 15_000,
  usage_probes_save: 15_000,
  eco_toggle: 30_000,
  eco_refresh: 60_000,
});

/**
 * 该请求类型应等待多久（毫秒）。未登记的类型回落到 `DEFAULT_TIMEOUT_MS`。
 * 返回 `Infinity` 表示不设超时。
 */
export function requestTimeoutMs(type: string): number {
  if (Object.prototype.hasOwnProperty.call(TIMEOUT_BY_TYPE, type)) {
    return TIMEOUT_BY_TYPE[type];
  }
  return DEFAULT_TIMEOUT_MS;
}

/** 超时/断连时的用户可读提示。 */
export function timeoutMessage(type: string, ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `请求「${type}」超过 ${seconds} 秒没有响应，已放弃等待。Pi Agent 可能已无响应，请检查侧车日志或重启应用。`;
}

/**
 * sidecar 重启后，决定哪些未完成请求应当被中止、哪个应当保留。
 *
 * 背景（这里踩过一个真 bug）：Rust 侧重启 sidecar 后会**用新的 stdin 重发**触发
 * 重启的那条请求。如果前端在收到 `sidecar-restarted` 时把 pending 全部清空，
 * 那条重试请求的响应到达时就无人接收了 —— 表现为"重启后第一个请求永远没回音"。
 * 所以必须保留 `keepId`。
 *
 * @param pendingIds 当前所有未完成请求的 id
 * @param keepId     Rust 侧已重新发起、仍然有效的请求 id（无则传 undefined）
 * @returns aborted=应中止的 id；kept=应保留的 id
 */
export function partitionPendingOnRestart(
  pendingIds: readonly number[],
  keepId?: number,
): { aborted: number[]; kept: number[] } {
  const aborted: number[] = [];
  const kept: number[] = [];
  for (const id of pendingIds) {
    if (keepId !== undefined && id === keepId) kept.push(id);
    else aborted.push(id);
  }
  return { aborted, kept };
}
