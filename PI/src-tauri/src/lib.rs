use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// pending 的安全上限。超过则强制 lossy 冲刷，保证内存有界：
/// 非 UTF-8 输出（GBK 老式 CLI、二进制文件、随机字节）不应能把缓冲区撑爆。
const PTY_PENDING_LIMIT: usize = 1 << 20; // 1 MiB

/// 跨块 UTF-8 解码。
///
/// `read()` 的返回长度与字符边界无关：一个 3 字节汉字可能正好跨在两次 read 之间。
/// 若对每块单独 `from_utf8_lossy`，半个字符会被替换成 U+FFFD（`�`），且**无法通过
/// 重新拼接恢复**——中文 Windows 下 `git log`、npm 输出的中文会随机乱码。
///
/// 语义：
/// - 合法字节：全部取出并清空缓冲
/// - 尾部半个字符（`error_len() == None`）：**不消费**，留到下一块再拼
/// - 真非法字节（`error_len() == Some(n)`）：丢弃且**不产出 U+FFFD**，并**继续处理**
///   后续内容——单次调用必须把所有可判定的内容都消费掉，否则非法字节会堵住后面
///   所有合法数据（曾因此让 1MB 的 GBK/二进制输出只吐出 17 个字符，且缓冲无界增长）。
fn take_valid_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        if pending.is_empty() {
            break;
        }
        match std::str::from_utf8(pending) {
            Ok(_) => {
                out.push_str(&String::from_utf8_lossy(pending));
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    // 前缀一定合法（valid_up_to 的定义），lossy 只是为避免 unwrap。
                    out.push_str(&String::from_utf8_lossy(&pending[..valid]));
                }
                match error.error_len() {
                    // 尾部是半个字符 → 保留，等下一块补齐（最多 3 字节）
                    None => {
                        pending.drain(..valid);
                        break;
                    }
                    // 真非法字节 → 丢弃这一段，继续消费后面的合法内容
                    Some(skip) => {
                        pending.drain(..valid + skip);
                    }
                }
            }
        }
    }
    out
}

/// 兜底冲刷：进程退出或缓冲超限时调用，允许产生替换字符（此时已无从等待补齐）。
fn flush_pending_lossy(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    let text = String::from_utf8_lossy(pending).to_string();
    pending.clear();
    text
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    next_id: u64,
    /// 最近一次从 stdout 读到内容（响应或事件）的时刻。
    /// 0-8 僵死探活用：进程活着但再也不输出 = 对用户而言等同死机。
    /// reader 线程持有同一 Arc 并持续刷新。
    last_output: std::sync::Arc<Mutex<Instant>>,
    /// 已发出但尚未等到响应的请求计数（探测基准）
    outstanding: u64,
}

/// 僵死判定：有未响应请求且这么久没有任何输出。
/// 必须**高于**前端最长的单请求超时（rpc-policy.ts 里 `update_pi_sdk` = 300s），
/// 否则前端刚超时放弃、Rust 就把 sidecar 重启，两边打架。
/// 取 6 分钟：留给最慢的合法请求（npm 安装）足够余量。
const STALL_THRESHOLD: Duration = Duration::from_secs(360);

/// 纯函数化的僵死判定（便于单测，不需要真的持有 Child）。
fn is_stalled(outstanding: u64, last_output_elapsed: Duration) -> bool {
    outstanding > 0 && last_output_elapsed > STALL_THRESHOLD
}

impl Sidecar {
    /// 进程活着但久无输出，且确实有请求在等 → 判定僵死。
    fn is_stalled(&self) -> bool {
        let elapsed = match self.last_output.lock() {
            Ok(stamp) => stamp.elapsed(),
            Err(poisoned) => poisoned.into_inner().elapsed(),
        };
        is_stalled(self.outstanding, elapsed)
    }
}

/// 重启限次：60 秒窗口内最多 3 次，防止崩溃循环把 CPU 打满。
/// 参考 pi-agent-desktop 的 getNextRestartState（有界重启 + 超限转可见错误）。
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const MAX_RESTARTS_IN_WINDOW: usize = 3;

#[derive(Default)]
struct RestartTracker {
    stamps: Mutex<Vec<Instant>>,
}

impl RestartTracker {
    /// 记录一次重启尝试；超出窗口配额时返回 false（调用方应放弃并报错）。
    fn try_record(&self) -> bool {
        let mut stamps = match self.stamps.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        stamps.retain(|stamp| now.duration_since(*stamp) < RESTART_WINDOW);
        if stamps.len() >= MAX_RESTARTS_IN_WINDOW {
            return false;
        }
        stamps.push(now);
        true
    }
}

fn sidecar_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        paths.push(dir.join("sidecar").join("index.mjs"));
        paths.push(dir.join("resources").join("sidecar").join("index.mjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("sidecar").join("index.mjs"));
            paths.push(dir.join("resources").join("sidecar").join("index.mjs"));
        }
    }
    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("project root")
            .join("sidecar")
            .join("index.mjs"),
    );
    paths
}

fn resolve_sidecar_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let paths = sidecar_candidates(app);
    paths.iter().find(|path| path.exists()).cloned().ok_or_else(|| {
        format!(
            "找不到 sidecar/index.mjs。已尝试:\n{}",
            paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("\n")
        )
    })
}

fn resolve_node(script: &Path) -> PathBuf {
    let mut dirs = Vec::new();
    if let Some(dir) = script.parent() {
        dirs.push(dir.to_path_buf());
        if let Some(parent) = dir.parent() {
            dirs.push(parent.to_path_buf());
            if let Some(grand) = parent.parent() {
                dirs.push(grand.to_path_buf());
            }
        }
    }
    for dir in dirs {
        let windows = dir.join("node.exe");
        if windows.exists() {
            return windows;
        }
        let unix = dir.join("node");
        if unix.exists() {
            return unix;
        }
    }
    PathBuf::from("node")
}

fn runtime_cwd(script: &Path) -> PathBuf {
    let mut dir = script.parent();
    while let Some(current) = dir {
        if current.join("node_modules").exists() {
            return current.to_path_buf();
        }
        dir = current.parent();
    }
    script.parent().unwrap_or(Path::new(".")).to_path_buf()
}

fn pathdiff_from(base: &Path, target: &Path) -> String {
    target
        .strip_prefix(base)
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|_| target.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn spawn_sidecar(app: &tauri::AppHandle) -> Result<Sidecar, String> {
    let script = resolve_sidecar_script(app)?;
    let node = resolve_node(&script);
    let cwd = runtime_cwd(&script);
    let script_arg = pathdiff_from(&cwd, &script);
    let mut command = std::process::Command::new(&node);
    command
        .arg(&script_arg)
        .current_dir(&cwd)
        .env("NODE_PATH", cwd.join("node_modules"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        let debug = format!("node={node:?}\nscript={script:?}\nscript_arg={script_arg:?}\ncwd={cwd:?}\n");
        let _ = std::fs::write(log_dir.join("sidecar-spawn.txt"), debug);
    }
    if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(file) = std::fs::File::create(log_dir.join("sidecar.log")) {
            command.stderr(Stdio::from(file));
        } else {
            command.stderr(Stdio::null());
        }
    } else {
        command.stderr(Stdio::null());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        format!("无法启动 Pi Agent sidecar: {error}\nnode={node:?}\nscript={script:?}\ncwd={cwd:?}")
    })?;
    let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
    let handle = app.clone();
    // 与 Sidecar 共享的活跃度时钟：reader 线程每读到一行就刷新。
    let last_output = std::sync::Arc::new(Mutex::new(Instant::now()));
    let reader_clock = last_output.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(mut stamp) = reader_clock.lock() {
                *stamp = Instant::now();
            }
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                let _ = handle.emit("agent-message", message);
            }
        }
        let _ = handle.emit("agent-message", serde_json::json!({
            "type": "event",
            "event": { "type": "error", "message": "Pi Agent sidecar 已退出" }
        }));
    });
    Ok(Sidecar { child, stdin, next_id: 1, last_output, outstanding: 0 })
}

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[allow(dead_code)]
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
}

struct PtyPool {
    entries: Mutex<HashMap<u32, PtyEntry>>,
    next_id: AtomicU32,
}

impl Default for PtyPool {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

/// sidecar 是否仍存活（try_wait 返回 Ok(None) 表示尚未退出）。
fn sidecar_alive(instance: &mut Sidecar) -> bool {
    matches!(instance.child.try_wait(), Ok(None))
}

/// 把一条请求写进 sidecar 的 stdin。
fn write_request(instance: &mut Sidecar, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut instance.stdin, message).map_err(|error| error.to_string())?;
    instance.stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    instance.stdin.flush().map_err(|error| error.to_string())
}

/// 发送 Agent 请求，写入失败或进程已死时做一次**有界**自愈重启。
///
/// 两处关键修复：
/// 1. **请求 id 归前端所有**。旧实现用自己的 `next_id` 覆盖前端传来的 id，而 sidecar
///    重启后该计数器会归零、前端却继续递增——两边一旦错位，所有响应 id 都对不上，
///    前端 `pending` 全部永久挂起（表现为界面卡死、点什么都不响应）。
/// 2. **崩溃自愈**。旧实现一旦 sidecar 退出，`agent_request` 就永久报错，用户必须重启
///    整个应用。现在写入失败或进程已退出时自动重启并重试一次；60 秒窗口内最多 3 次，
///    超限则明确报错而非崩溃循环。
#[tauri::command]
fn agent_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<Sidecar>>>,
    restarts: tauri::State<'_, RestartTracker>,
    request: Value,
) -> Result<u64, String> {
    let mut message = request;
    // 优先沿用前端给的 id（不再覆盖），缺失时才回退到本地计数器。
    let id = match message.get("id").and_then(Value::as_u64) {
        Some(value) => value,
        None => {
            let mut guard = state.lock().map_err(|_| "sidecar 状态锁失败")?;
            let instance = guard.as_mut().ok_or("Pi Agent 尚未启动")?;
            let value = instance.next_id;
            instance.next_id += 1;
            message["id"] = Value::from(value);
            value
        }
    };

    let mut guard = state.lock().map_err(|_| "sidecar 状态锁失败")?;

    // 首次尝试：进程活着且写入成功就直接返回（热路径，无额外开销）。
    // 注意先判活再借可变引用——pattern guard 里不能可变借用。
    // 0-8 僵死探活：进程活着但久无任何输出且还有请求压着 → 视同死机，走自愈重启。
    let failure = match guard.as_mut() {
        Some(instance) => {
            if !sidecar_alive(instance) {
                "sidecar 进程已退出".to_string()
            } else if instance.is_stalled() {
                format!(
                    "sidecar 进程存活但已 {} 秒没有任何输出，且仍有 {} 个未响应请求（疑似僵死）",
                    STALL_THRESHOLD.as_secs(),
                    instance.outstanding
                )
            } else {
                instance.outstanding = instance.outstanding.saturating_add(1);
                match write_request(instance, &message) {
                    // 写入成功即返回；outstanding 由前端收到响应后递减（见 agent_response_seen）
                    Ok(()) => return Ok(id),
                    Err(error) => {
                        instance.outstanding = instance.outstanding.saturating_sub(1);
                        error
                    }
                }
            }
        }
        None => "sidecar 尚未启动".to_string(),
    };

    // 自愈路径：先清理旧进程，再按限次重启。
    if let Some(mut dead) = guard.take() {
        let _ = dead.child.kill();
        let _ = dead.child.wait();
    }
    if !restarts.try_record() {
        let reason = format!(
            "Pi Agent sidecar 反复退出（{MAX_RESTARTS_IN_WINDOW} 次 / {} 秒内），已停止自动重启。\
             最后一次错误：{failure}。请检查 sidecar 日志后重启应用。",
            RESTART_WINDOW.as_secs()
        );
        let _ = app.emit("agent-message", serde_json::json!({
            "type": "sidecar-failed",
            "message": reason,
        }));
        return Err(reason);
    }

    match spawn_sidecar(&app) {
        Ok(mut fresh) => {
            // 顺序至关重要：必须**先**把重试请求写进新进程，**再**通知前端清理 pending。
            // 反过来的话，前端会先丢掉包括本次重试在内的所有 pending，
            // 于是这次重试的响应到达时已无人接收（表现为"重启后第一个请求永远没回音"）。
            match write_request(&mut fresh, &message) {
                Ok(()) => {
                    *guard = Some(fresh);
                    drop(guard);
                    let _ = app.emit("agent-message", serde_json::json!({
                        "type": "sidecar-restarted",
                        "reason": failure,
                        // 让前端知道这个 id 是重启后仍然有效的新请求
                        "keepId": id,
                    }));
                    Ok(id)
                }
                Err(error) => {
                    let _ = fresh.child.kill();
                    *guard = None;
                    Err(format!("sidecar 重启后仍无法写入：{error}"))
                }
            }
        }
        Err(error) => {
            *guard = None;
            Err(format!("sidecar 重启失败：{error}"))
        }
    }
}

/// 前端收到 sidecar 的任何输出后调用：用于维护"未响应请求"计数。
///
/// 为什么让前端报而不是 Rust 自己数：响应与请求经同一条 stdout，但响应里的 id
/// 属于前端命名空间；让前端在 `listen('agent-message')` 里顺带通知一次即可，
/// 不必在 Rust 侧解析并维护 id→计数表。
///
/// `delta`：+1 表示刚发出一个请求，-1 表示刚收到对应响应。
#[tauri::command]
fn agent_outstanding(state: tauri::State<'_, Mutex<Option<Sidecar>>>, delta: i64) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "sidecar 状态锁失败")?;
    if let Some(instance) = guard.as_mut() {
        if delta < 0 {
            instance.outstanding = instance.outstanding.saturating_sub(1);
        } else if delta > 0 {
            instance.outstanding = instance.outstanding.saturating_add(delta as u64);
        }
        // 任何来自 sidecar 的输出都证明它还活着
        if let Ok(mut stamp) = instance.last_output.lock() {
            *stamp = Instant::now();
        }
    }
    Ok(())
}

/// 设置"关窗最小化到托盘"开关（U1，前端设置页调用）。
#[tauri::command]
fn set_tray_minimize(state: tauri::State<'_, TrayMinimize>, enabled: bool) -> Result<(), String> {
    if let Ok(mut flag) = state.0.lock() {
        *flag = enabled;
        Ok(())
    } else {
        Err("托盘状态锁失败".into())
    }
}

/// 读取当前开关（设置页回显用）。
#[tauri::command]
fn get_tray_minimize(state: tauri::State<'_, TrayMinimize>) -> bool {
    state
        .0
        .lock()
        .map(|flag| *flag)
        .unwrap_or(true)
}

/// 从前端隐藏窗口到托盘（托盘/快捷键入口）。
#[tauri::command]
fn hide_to_tray_command(app: tauri::AppHandle) -> Result<(), String> {
    hide_to_tray(&app);
    Ok(())
}

#[tauri::command]
fn agent_status(state: tauri::State<'_, Mutex<Option<Sidecar>>>) -> bool {
    state.lock().ok().and_then(|mut guard| guard.as_mut().map(sidecar_alive)).unwrap_or(false)
}

#[tauri::command]
fn pty_spawn(app: tauri::AppHandle, state: tauri::State<'_, PtyPool>, shell: Option<String>) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|error| format!("无法打开 PTY: {error}"))?;

    #[cfg(windows)]
    let cmd = {
        // 白名单：cmd / powershell / pwsh，其它值回落 cmd.exe。
        let program = match shell.as_deref() {
            Some("powershell") => "powershell.exe",
            Some("pwsh") => "pwsh.exe",
            Some("cmd") => "cmd.exe",
            _ => "cmd.exe",
        };
        CommandBuilder::new(program)
    };
    #[cfg(not(windows))]
    let cmd = CommandBuilder::new("bash");

    let child = pair.slave.spawn_command(cmd).map_err(|error| format!("无法启动 shell: {error}"))?;
    // 释放 slave 句柄：子进程已继承其文件描述符，父进程无需保留。
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|error| format!("无法读取 PTY 输出: {error}"))?;
    let writer = pair.master.take_writer().map_err(|error| format!("无法写入 PTY: {error}"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let handle = app.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        // 跨块 UTF-8 尾字节缓冲：read 的返回长度与字符边界无关，一个 3 字节汉字
        // 可能正好跨在两次 read 之间。旧实现对每块单独 `from_utf8_lossy`，会把这种
        // 半个字符替换成 U+FFFD（即 `�`）。take_valid_utf8 负责只消费已确定的内容、
        // 把半个字符留到下一块；非法字节则丢弃并继续，不会堵住后续输出。
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    pending.extend_from_slice(&buffer[..length]);
                    let data = take_valid_utf8(&mut pending);
                    if !data.is_empty() {
                        let _ = handle.emit("pty-output", serde_json::json!({ "id": id, "data": data }));
                    }
                    // 内存护栏：非 UTF-8 输出（GBK 老式 CLI、二进制文件）不应把缓冲撑爆。
                    // take_valid_utf8 已保证正常情况下 pending 最多剩 3 字节（半个字符），
                    // 这里只兜住意料之外的输入。
                    if pending.len() > PTY_PENDING_LIMIT {
                        let data = flush_pending_lossy(&mut pending);
                        let _ = handle.emit("pty-output", serde_json::json!({ "id": id, "data": data }));
                    }
                }
                Err(_) => break,
            }
        }
        // 进程结束时把残留字节兜底吐出，避免丢掉最后一个不完整字符。
        // 分块发射：极端情况下残留可能很大，一条巨大的 IPC 消息会拖慢 webview。
        while !pending.is_empty() {
            let take = pending.len().min(64 * 1024);
            let mut chunk = pending.drain(..take).collect::<Vec<u8>>();
            let data = flush_pending_lossy(&mut chunk);
            let _ = handle.emit("pty-output", serde_json::json!({ "id": id, "data": data }));
        }
        let _ = handle.emit("pty-output", serde_json::json!({ "id": id, "data": "\r\n[process exited]\r\n" }));
    });

    state.entries.lock().map_err(|_| "PTY 状态锁失败")?.insert(id, PtyEntry {
        writer,
        child,
        master: Some(pair.master),
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(id: u32, data: String, state: tauri::State<'_, PtyPool>) -> Result<(), String> {
    let mut entries = state.entries.lock().map_err(|_| "PTY 状态锁失败")?;
    let entry = entries.get_mut(&id).ok_or("该终端不存在或已退出")?;
    entry.writer.write_all(data.as_bytes()).map_err(|error| error.to_string())?;
    entry.writer.flush().map_err(|error| error.to_string())?;
    Ok(())
}

/// 结束一个 PTY 会话，并连带清理其子进程。
///
/// `portable_pty` 的 `kill()` 在 Windows 上只终止直接子进程（cmd.exe），而用户在终端里
/// 启动的命令（node、npm、python…）会成为孤儿继续占资源。用 `taskkill /T` 杀整棵树。
fn kill_pty_tree(entry: &mut PtyEntry) {
    #[cfg(windows)]
    {
        if let Some(pid) = entry.child.process_id() {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            let _ = command.status();
        }
    }
    // 兜底：无论平台都再显式 kill 一次（taskkill 失败或非 Windows 时生效）。
    let _ = entry.child.kill();
}

#[tauri::command]
fn pty_kill(id: u32, state: tauri::State<'_, PtyPool>) -> Result<(), String> {
    let mut entries = state.entries.lock().map_err(|_| "PTY 状态锁失败")?;
    if let Some(mut entry) = entries.remove(&id) {
        kill_pty_tree(&mut entry);
    }
    Ok(())
}

/// 托盘行为开关（U1）：关窗是否最小化到托盘。
/// 默认开（用户明确要求的"最小化到托盘"）；前端设置里可关。
/// 存 Tauri 状态以便前端读写（set_tray_minimize 命令）。
#[derive(Default)]
struct TrayMinimize(Mutex<bool>);

/// 关窗 → 隐藏到托盘（而不是退出）。
/// 防止 sidecar / PTY / 正在跑的任务被用户误点 X 直接带走；
/// 真正退出走托盘菜单"退出"，那里会走正常销毁流程。
fn hide_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn show_from_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 构建系统托盘（U1）。失败只记日志不阻断启动 —— 托盘缺失时应用仍可用
/// （关窗直接退出，与旧行为一致）。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{TrayIconBuilder, TrayIconEvent},
    };

    let show = MenuItem::with_id(app, "show", "显示 Pi-My", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("pi-my-tray")
        .tooltip("Pi-My — Pi 编程助手")
        .menu(&menu)
        // 左键点击托盘图标 = 显示窗口（菜单走右键）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_from_tray(app),
            "quit" => {
                // 走正常退出：RunEvent::Exit 里统一清理 sidecar/PTY
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键（Windows 常见习惯）/ 双击 = 显示窗口
            if matches!(event, TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. })
                || matches!(event, TrayIconEvent::DoubleClick { .. })
            {
                show_from_tray(tray.app_handle());
            }
        });

    // 图标：优先打包资源里的 icon.png；失败则不设图标（部分平台会用默认）
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match spawn_sidecar(app.handle()) {
                Ok(sidecar) => {
                    app.manage(Mutex::new(Some(sidecar)));
                }
                Err(error) => {
                    if let Ok(log_dir) = app.path().app_log_dir() {
                        let _ = std::fs::create_dir_all(&log_dir);
                        let _ = std::fs::write(log_dir.join("sidecar-start-error.txt"), &error);
                    }
                    app.manage(Mutex::new(None::<Sidecar>));
                }
            }
            app.manage(PtyPool::default());
            app.manage(RestartTracker::default());
            app.manage(TrayMinimize(Mutex::new(true)));
            // 系统托盘（U1）：失败不阻断启动
            if let Err(error) = setup_tray(app.handle()) {
                eprintln!("[pi-my] 系统托盘初始化失败（不影响使用）: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // U1：点击关闭按钮 → 隐藏到托盘，而不是退出。
            // 用户的原话是"支持系统托盘、最小化到托盘"；
            // 真正退出走托盘菜单的"退出"。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let minimize = app
                    .try_state::<TrayMinimize>()
                    .map(|state| *state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
                    .unwrap_or(true);
                if minimize {
                    api.prevent_close();
                    hide_to_tray(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![agent_request, agent_status, agent_outstanding, set_tray_minimize, get_tray_minimize, hide_to_tray_command, pty_spawn, pty_write, pty_kill])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Mutex<Option<Sidecar>>>() {
                    if let Ok(mut guard) = state.lock() {
                        if let Some(sidecar) = guard.as_mut() {
                            let _ = sidecar.child.kill();
                            // 等进程真正回收，避免退出时留下僵尸 node。
                            let _ = sidecar.child.wait();
                        }
                    }
                }
                if let Some(pool) = app.try_state::<PtyPool>() {
                    if let Ok(mut entries) = pool.entries.lock() {
                        for entry in entries.values_mut() {
                            kill_pty_tree(entry);
                        }
                        entries.clear();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 逐块喂入并按块取回文本，模拟 PTY reader 的调用序列。
    fn feed(chunks: &[&[u8]]) -> Vec<String> {
        let mut pending: Vec<u8> = Vec::new();
        let mut out = Vec::new();
        for chunk in chunks {
            pending.extend_from_slice(chunk);
            let text = take_valid_utf8(&mut pending);
            if !text.is_empty() {
                out.push(text);
            }
        }
        if !pending.is_empty() {
            out.push(String::from_utf8_lossy(&pending).to_string());
        }
        out
    }

    #[test]
    fn multibyte_split_across_chunks_is_not_corrupted() {
        // "中文" 每个字 3 字节；在字节 1/2 处切开，旧实现会产出 U+FFFD
        let bytes = "中文".as_bytes();
        let result = feed(&[&bytes[..1], &bytes[1..4], &bytes[4..]]).join("");
        assert_eq!(result, "中文");
        assert!(!result.contains('\u{FFFD}'), "出现了替换字符，说明按块 lossy 解码了");
    }

    #[test]
    fn four_byte_emoji_split_is_preserved() {
        let bytes = "🚀".as_bytes(); // 4 字节
        let result = feed(&[&bytes[..2], &bytes[2..]]).join("");
        assert_eq!(result, "🚀");
    }

    #[test]
    fn ascii_is_returned_immediately() {
        let out = feed(&[b"hello"]);
        assert_eq!(out, vec!["hello".to_string()]);
    }

    #[test]
    fn no_corruption_under_byte_by_byte_feeding() {
        // 最严苛的情况：每次只给 1 字节
        let text = "中文测试：事件循环 🚀 café";
        let bytes = text.as_bytes();
        let chunks: Vec<&[u8]> = bytes.chunks(1).collect();
        let result = feed(&chunks).join("");
        assert_eq!(result, text);
    }

    #[test]
    fn invalid_bytes_do_not_wedge_the_buffer() {
        // 0xFF 永远不会出现在合法 UTF-8 里；解码器必须跳过它并继续，
        // 而不是让非法字节堵住后面的合法内容。
        let mut pending: Vec<u8> = vec![b'a', 0xFF, b'b'];
        let out = take_valid_utf8(&mut pending);
        assert_eq!(out, "ab", "非法字节应被丢弃，两侧的 ASCII 都要取出");
        assert!(pending.is_empty());
    }

    #[test]
    fn a_single_call_consumes_every_decidable_byte() {
        // 回归保护：曾经只消费"一批"非法字节，导致 1MB 的 GBK/二进制输出
        // 每次 read 只前进 1 字节 → 缓冲无界增长、后续合法内容被永久堵住。
        let mut pending: Vec<u8> = vec![0x80; 8192];
        let out = take_valid_utf8(&mut pending);
        assert!(out.is_empty(), "非法字节不应产出替换字符");
        assert!(pending.is_empty(), "单次调用必须把可判定的字节全部消费掉");
    }

    #[test]
    fn gbk_bytes_do_not_accumulate_and_do_not_block_later_ascii() {
        // GBK 的 "中文" = D6 D0 CE C4：全是非法 UTF-8 序列
        let mut pending: Vec<u8> = vec![0xD6, 0xD0, 0xCE, 0xC4];
        pending.extend_from_slice(b"tail");
        let out = take_valid_utf8(&mut pending);
        // 关键：非法前缀不能把后面的 ASCII 堵住
        assert_eq!(out, "tail");
        assert!(pending.is_empty());
    }

    #[test]
    fn large_invalid_stream_keeps_buffer_bounded() {
        // 模拟持续的非 UTF-8 输出：每块 8192 字节全是非法字节
        let mut pending: Vec<u8> = Vec::new();
        let mut emitted = 0usize;
        for _ in 0..200 {
            pending.extend_from_slice(&[0x80u8; 8192]);
            emitted += take_valid_utf8(&mut pending).len();
        }
        assert_eq!(emitted, 0);
        assert!(
            pending.len() <= 3,
            "缓冲应保持有界（最多残留半个字符），实际残留 {} 字节",
            pending.len()
        );
    }

    #[test]
    fn no_replacement_char_for_real_invalid_bytes() {
        // 非法字节应当被静默丢弃，而不是变成终端里可见的 `�`
        let mut pending: Vec<u8> = vec![0xFF, 0xFE, 0xFD, b'o', b'k'];
        let out = take_valid_utf8(&mut pending);
        assert_eq!(out, "ok");
        assert!(!out.contains('\u{FFFD}'));
    }

    #[test]
    fn flush_pending_lossy_is_bounded_and_clears() {
        let mut pending: Vec<u8> = vec![0xE4]; // 只有半个字符，等不到补齐
        let out = flush_pending_lossy(&mut pending);
        assert_eq!(out, "\u{FFFD}", "兜底允许产生替换字符");
        assert!(pending.is_empty(), "兜底后缓冲必须清空，否则内存会持续增长");
    }

    #[test]
    fn incomplete_tail_is_retained_for_next_chunk() {
        let mut pending = vec![0xE4]; // "中" 的首字节
        assert_eq!(take_valid_utf8(&mut pending), "");
        assert_eq!(pending, vec![0xE4], "半个字符应留在缓冲里等下一块");
    }
}

#[cfg(test)]
mod restart_tests {
    use super::*;

    #[test]
    fn allows_up_to_the_limit_then_refuses() {
        let tracker = RestartTracker::default();
        for attempt in 1..=MAX_RESTARTS_IN_WINDOW {
            assert!(tracker.try_record(), "第 {attempt} 次重启应被允许");
        }
        // 第 4 次必须被拒绝，否则就是崩溃循环
        assert!(!tracker.try_record(), "超出窗口配额后必须拒绝，防止崩溃循环");
    }

    #[test]
    fn window_expiry_frees_the_quota() {
        let tracker = RestartTracker::default();
        for _ in 0..MAX_RESTARTS_IN_WINDOW {
            assert!(tracker.try_record());
        }
        assert!(!tracker.try_record());
        // 人为把时间戳推到窗口之外，配额应重新可用
        {
            let mut stamps = tracker.stamps.lock().unwrap();
            for stamp in stamps.iter_mut() {
                *stamp -= RESTART_WINDOW + Duration::from_secs(1);
            }
        }
        assert!(tracker.try_record(), "窗口过期后应重新允许重启");
    }

    #[test]
    fn poisoned_lock_does_not_panic() {
        // 换用 catch_unwind 制造 poison，确认 try_record 仍可用（不会连带把 UI 拖崩）
        let tracker = std::sync::Arc::new(RestartTracker::default());
        let clone = tracker.clone();
        let _ = std::thread::spawn(move || {
            let _guard = clone.stamps.lock().unwrap();
            panic!("故意 poison");
        })
        .join();
        assert!(tracker.try_record(), "锁被 poison 后仍应能记录重启");
    }
}

#[cfg(test)]
mod stall_tests {
    use super::*;

    #[test]
    fn no_outstanding_requests_never_stalls() {
        // 没有请求压着时，哪怕很久没输出也不算僵死（用户可能就是没在用）
        assert!(!is_stalled(0, Duration::from_secs(3600)));
    }

    #[test]
    fn outstanding_with_long_silence_is_stalled() {
        assert!(is_stalled(1, STALL_THRESHOLD + Duration::from_secs(1)));
        assert!(is_stalled(5, Duration::from_secs(600)));
    }

    #[test]
    fn outstanding_with_recent_output_is_not_stalled() {
        // 流式回复期间会持续输出，不能误判
        assert!(!is_stalled(1, Duration::from_secs(1)));
        assert!(!is_stalled(3, Duration::from_secs(299)));
        assert!(!is_stalled(3, STALL_THRESHOLD), "恰好等于阈值不算超时（开区间）");
    }

    #[test]
    fn threshold_is_well_above_front_end_timeouts() {
        // 前端最长 300s（update_pi_sdk），Rust 必须更长，否则两边打架
        assert!(STALL_THRESHOLD > Duration::from_secs(300));
    }
}
