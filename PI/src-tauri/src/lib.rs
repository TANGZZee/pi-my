use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
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

/// sidecar stdout 单行的分类结果（纯函数输出，便于单测，不需要真的起进程）。
#[derive(Debug)]
enum SidecarLine {
    /// 空行 / 纯空白：NDJSON 流里合法的噪声，**不算**解析失败
    Empty,
    /// 合法 JSON 消息
    Parsed(Value),
    /// 不是 JSON（含被丢弃的非法 UTF-8 之后的残行）：跳过并记账，但绝不终止读取
    NotJson(String),
}

/// 纯函数：判定一行是空行、合法 JSON 还是垃圾。
///
/// 旧实现（`lines().map_while(Result::ok)`）在这一步静默丢弃失败的行：既没有诊断，
/// 也无从知道"界面为什么没反应"。这里把判定与副作用分开，判定可单测。
fn classify_sidecar_line(raw: &str) -> SidecarLine {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return SidecarLine::Empty;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(message) => SidecarLine::Parsed(message),
        Err(_) => SidecarLine::NotJson(trimmed.to_string()),
    }
}

/// 读取线程的**会话无关**诊断消息：读线程结束时用来告诉界面"事件流为什么断了"。
///
/// 为什么要显式带上 `sessionId`：前端事件入口是 `const id = payload.sessionId ||
/// activeSessionId; if (!id) return`。这两条诊断原先不带 sessionId，于是
/// - 在 `activeSessionId === ''`（刚启动、或用户把会话全删了）时被**静默丢弃**，
///   用户既看不到"输出流结束"也看不到"sidecar 已退出"；
/// - 在用户切到别的会话时会把 A 会话的读线程崩溃记到 B 头上（张冠李戴）。
/// 读线程自己不知道"当前会话"，但它在转发的每条消息里都看得到 `sessionId`，
/// 记住最后见过的那个即可覆盖绝大多数场景；从没见过就退回全局提示（前端兜底）。
fn reader_diagnostic(session_id: &Option<String>, message: String) -> Value {
    let mut payload = serde_json::json!({
        "type": "event",
        "event": { "type": "error", "message": message }
    });
    if let Some(id) = session_id {
        payload["sessionId"] = Value::String(id.clone());
    }
    payload
}

/// sidecar stdout 单行（未遇到换行前）的安全上限。正常 NDJSON 行只有几 KB；
/// 一旦有人往 stdout 灌二进制且永不带换行，缓冲不应无界增长。
const SIDECAR_PENDING_LIMIT: usize = 8 << 20; // 8 MiB

/// 读取线程每次最多从 stdout 取多少字节。
///
/// 这不是性能调参，而是护栏的**可达性前提**：只有把读取切成有界的小块、每块之后
/// 都回到循环体检查 `SIDECAR_PENDING_LIMIT`，护栏才可能执行到（见下方 reader 线程）。
const READ_CHUNK: usize = 64 << 10; // 64 KiB

/// 从字节缓冲里切出所有**已完整**的行（以 `\n` 结尾），未完成的尾部留在缓冲里等下一批。
///
/// 为什么按字节切、而不是 `lines()`：
/// - `lines()` 遇到第一个非法 UTF-8 字节就返回 `Err`，旧代码的 `map_while(Result::ok)`
///   会因此**整条读取线程退出**——进程还活着、还在写，前端却永远收不到后续事件（转圈）。
/// - 按 `b'\n'` 切分天然免疫跨块拆字符：换行是 ASCII，只要换行到了，它前面的字节必然
///   已经完整；没有换行的尾巴一律留到下一块，半行 JSON 不会被误解析。
/// - 非法字节交给 `take_valid_utf8` 丢弃（不产出 U+FFFD），绝不 panic、绝不中断。
/// 返回 `(行内容, 该行字节是否含非法 UTF-8)`。第二个字段单独记账，是因为
/// `take_valid_utf8` 会把非法字节**静默丢弃**（不产出 U+FFFD），解出来的字符串
/// 看不出它曾经受损；只有在字节层面才能判定。
fn take_complete_lines(pending: &mut Vec<u8>) -> Vec<(String, bool)> {
    let mut lines = Vec::new();
    while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
        let mut raw: Vec<u8> = pending.drain(..=index).collect();
        raw.pop(); // 去掉 \n
        if raw.last() == Some(&b'\r') {
            raw.pop(); // 兼容 CRLF
        }
        let invalid_utf8 = std::str::from_utf8(&raw).is_err();
        lines.push((take_valid_utf8(&mut raw), invalid_utf8));
    }
    lines
}

/// 把读取线程的诊断追加到 `app_log_dir()/sidecar-reader.log`。
///
/// 用独立文件而不是复用子进程 stderr 的 `sidecar.log`：那个文件被 node 长期持有，
/// 两边同时写容易互相影响。
/// 任何失败都必须静默——诊断自身不能把读取线程拖死。
fn append_reader_log(app: &tauri::AppHandle, line: &str) {
    let dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("sidecar-reader.log"))
    {
        let _ = writeln!(file, "{line}");
    }
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
        let mut reader = BufReader::new(stdout);
        // 跨 read 的字节缓冲：块读取往这里追加，只把"已经见到换行"的
        // 完整行取走，半行留在这里等下一批。
        let mut pending: Vec<u8> = Vec::new();
        // 单块读取的目标缓冲。大小即"护栏最长可被拖延的距离"：一次 read 最多把
        // pending 推过上限 READ_CHUNK 字节，随即在循环体末尾被判定并丢弃。
        let mut chunk = vec![0u8; READ_CHUNK];
        // 记账：让最终诊断能说出"共跳过 N 行"，而不是一句无从追查的"已退出"。
        let mut skipped: u64 = 0;
        let mut non_utf8_lines: u64 = 0;
        // 记住最后见过的会话号，供会话无关的诊断消息归属（见 reader_diagnostic）。
        let mut last_session: Option<String> = None;
        // 退出原因（EOF 是正常收尾，I/O 错误才是异常）。
        let mut exit_reason: String = "stdout 已到达结束（EOF）".to_string();

        loop {
            // 必须用**有界单块读取**（read）而不是 read_until：read_until 会在内部循环到
            // 遇到 \n / EOF / 错误才返回，于是"活着、持续输出但永不带换行"的流会让它
            // 永远不返回 —— 下面的内存护栏一次都执行不到，pending 无界增长（第六轮审查
            // 探针实测：3 秒内灌入 41 MB，护栏命中的 pending 峰值始终是 0 字节）。
            // 每次最多读 CHUNK 字节再回到护栏，护栏才有机会生效。
            let read = match reader.read(&mut chunk) {
                Ok(0) => break, // EOF
                Ok(n) => n,
                Err(error) => {
                    // 单块读取失败（Windows 上管道被关、句柄失效等）不是"没有数据了"。
                    // 旧实现把它当成正常结束；这里明确记录原因后再退出。
                    exit_reason = format!("读取 stdout 失败：{error}");
                    break;
                }
            };
            pending.extend_from_slice(&chunk[..read]);
            if let Ok(mut stamp) = reader_clock.lock() {
                *stamp = Instant::now();
            }
            for (raw, invalid_utf8) in take_complete_lines(&mut pending) {
                if invalid_utf8 {
                    non_utf8_lines += 1;
                }
                match classify_sidecar_line(&raw) {
                    SidecarLine::Empty => {}
                    SidecarLine::Parsed(message) => {
                        if let Some(id) = message.get("sessionId").and_then(Value::as_str) {
                            last_session = Some(id.to_string());
                        }
                        let _ = handle.emit("agent-message", message);
                    }
                    SidecarLine::NotJson(garbage) => {
                        // 关键：跳过并记账，**不 break**。旧实现让一行坏 JSON
                        // （或一个非法字节）永久掐断整条事件流，前端就永久转圈。
                        skipped += 1;
                        if skipped <= 20 {
                            append_reader_log(
                                &handle,
                                &format!(
                                    "[reader] 跳过无法解析的一行（共 {skipped} 行）：{}",
                                    garbage.chars().take(300).collect::<String>()
                                ),
                            );
                        }
                    }
                }
            }
            // 内存护栏：永不带换行的输出（如被当成文本读的二进制）不应把缓冲撑爆。
            // 放在 take_complete_lines 之后：同一批已经收全的行绝不会被丢弃。
            if pending.len() > SIDECAR_PENDING_LIMIT {
                skipped += 1;
                pending.clear();
                append_reader_log(
                    &handle,
                    &format!("[reader] 未换行缓冲超过 {SIDECAR_PENDING_LIMIT} 字节，已丢弃"),
                );
            }
        }

        // EOF 时兜底：最后一行可能没有换行符。
        if !pending.is_empty() {
            let invalid_utf8 = std::str::from_utf8(&pending).is_err();
            if invalid_utf8 {
                non_utf8_lines += 1;
            }
            let tail = flush_pending_lossy(&mut pending);
            match classify_sidecar_line(&tail) {
                SidecarLine::Empty => {}
                SidecarLine::Parsed(message) => {
                    if let Some(id) = message.get("sessionId").and_then(Value::as_str) {
                        last_session = Some(id.to_string());
                    }
                    let _ = handle.emit("agent-message", message);
                }
                SidecarLine::NotJson(garbage) => {
                    skipped += 1;
                    append_reader_log(
                        &handle,
                        &format!(
                            "[reader] 跳过无法解析的末行：{}",
                            garbage.chars().take(300).collect::<String>()
                        ),
                    );
                }
            }
        }

        // 可见诊断：追加到 app_log_dir()/sidecar-reader.log，用户能在日志里看到原因。
        append_reader_log(
            &handle,
            &format!(
                "[reader] 读取线程结束：{exit_reason}；跳过 {skipped} 行（其中含非 UTF-8 {non_utf8_lines} 行）"
            ),
        );
        // 用前端**已经理解**的事件类型（`event.type === 'error'` → finishRun）；
        // 全新的事件类型会被静默忽略，因此不发明新类型。
        // 这条在下面的"已退出"事件之前发出，让原因先于笼统提示到达界面。
        // 两条都带 sessionId（reader_diagnostic），否则 activeSessionId 为空时会被
        // 前端入口 `if (!id) return` 直接丢掉。
        if skipped > 0 || non_utf8_lines > 0 {
            let _ = handle.emit(
                "agent-message",
                reader_diagnostic(
                    &last_session,
                    format!(
                        "Pi Agent 输出流结束：{exit_reason}；期间 {skipped} 行无法解析（含非 UTF-8 的 {non_utf8_lines} 行）。详情见 sidecar-reader.log。"
                    ),
                ),
            );
        }
        // 保持既有形状/type 不变，兼容前端的 sidecar 退出处理链。
        let _ = handle.emit(
            "agent-message",
            reader_diagnostic(&last_session, "Pi Agent sidecar 已退出".to_string()),
        );
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
mod sidecar_line_tests {
    use super::*;

    #[test]
    fn sidecar_pending_limit_never_shrinks() {
        // 承重常量契约（第四轮对抗性审查 R3 存活变异）：有人把这里改成与
        // PTY_PENDING_LIMIT（1 MiB）看齐，会让"单个未换行的大 JSON 事件"被
        // pending.clear() 静默丢弃 —— 含 base64 图片的 show_image、超长工具输出
        // 都会凭空消失，与本次修复要解决的"事件链中断"是同一类故障。
        // 纯常量断言即可，无需真的构造 8 MiB 数据。
        assert!(
            SIDECAR_PENDING_LIMIT >= 8 << 20,
            "sidecar 事件可能远大于 1 MiB，上限不得缩水（当前 {SIDECAR_PENDING_LIMIT}）"
        );
    }

    #[test]
    fn valid_json_line_is_parsed() {
        match classify_sidecar_line(r#"{"type":"response","id":7}"#) {
            SidecarLine::Parsed(value) => {
                assert_eq!(value.get("id").and_then(Value::as_u64), Some(7));
            }
            other => panic!("合法 JSON 应被解析，实际 {other:?}"),
        }
    }

    #[test]
    fn blank_and_whitespace_lines_are_empty_not_failures() {
        // NDJSON 流里空行/纯空白是合法噪声：旧实现会静默丢掉，这里必须分类为 Empty，
        // 不能被算进"解析失败"（否则诊断会长期误报）。
        for raw in ["", "   ", "\t", "\r"] {
            match classify_sidecar_line(raw) {
                SidecarLine::Empty => {}
                other => panic!("{raw:?} 应归为 Empty，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn garbage_line_is_not_json_and_loop_continues() {
        // 读取循环遇到 NotJson 必须跳过并继续——这里用"后续仍能解析"来固化该语义。
        assert!(matches!(classify_sidecar_line("node:internal/modules/cjs/loader"), SidecarLine::NotJson(_)));
        assert!(matches!(classify_sidecar_line("{不是 JSON"), SidecarLine::NotJson(_)));
        assert!(matches!(
            classify_sidecar_line(r#"{"type":"response","id":1}"#),
            SidecarLine::Parsed(_)
        ));
    }

    #[test]
    fn invalid_utf8_bytes_do_not_panic_and_still_yield_lines() {
        // 一个非法字节不能让整条流停摆：它所在的行仍要被切出来（非法字节被丢弃）。
        let mut pending: Vec<u8> = Vec::new();
        pending.extend_from_slice(b"{\"a\":1}\n");
        pending.extend_from_slice(&[0xFF, 0xFE]);
        pending.extend_from_slice(b"garbage\n");
        pending.extend_from_slice(&[0x80]);
        pending.extend_from_slice(b"{\"b\":2}\n");
        let lines = take_complete_lines(&mut pending);
        assert_eq!(lines.len(), 3, "三个换行 = 三行，非法字节不得吞掉后面的行");
        assert_eq!(lines[0].1, false, "第 1 行是干净的 UTF-8");
        assert_eq!(lines[1].1, true, "第 2 行含非法字节，应被标记");
        assert_eq!(lines[2].1, true, "第 3 行含非法字节，应被标记");
        assert!(matches!(classify_sidecar_line(&lines[0].0), SidecarLine::Parsed(_)));
        assert!(matches!(classify_sidecar_line(&lines[1].0), SidecarLine::NotJson(_)));
        assert!(matches!(classify_sidecar_line(&lines[2].0), SidecarLine::Parsed(_)));
        assert!(pending.is_empty(), "完整行必须全部取走，不残留");
    }

    #[test]
    fn multibyte_char_split_across_reads_is_reassembled() {
        // "中" = E4 B8 AD，跨两次读。按字节切行 + take_valid_utf8 拼回。
        let mut pending: Vec<u8> = Vec::new();
        pending.extend_from_slice(b"{\"t\":\"");
        pending.extend_from_slice(&[0xE4, 0xB8]);
        assert!(take_complete_lines(&mut pending).is_empty(), "没有换行 → 不产出任何行");
        pending.extend_from_slice(&[0xAD]);
        pending.extend_from_slice(b"\"}\n");
        let lines = take_complete_lines(&mut pending);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].0, "{\"t\":\"中\"}");
        assert_eq!(lines[0].1, false, "跨块字符是合法的，不该被记为非法");
        assert!(!lines[0].0.contains('\u{FFFD}'), "跨块字符不应被替换");
    }

    #[test]
    fn partial_final_line_is_held_then_completed() {
        let mut pending: Vec<u8> = Vec::new();
        pending.extend_from_slice(b"{\"type\":\"res");
        assert!(take_complete_lines(&mut pending).is_empty(), "半行必须扣住，不能当成一行解析");
        assert_eq!(pending.len(), b"{\"type\":\"res".len(), "半行应原样留在缓冲里");
        pending.extend_from_slice(b"ponse\"}\n");
        let lines = take_complete_lines(&mut pending);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].0, "{\"type\":\"response\"}");
        assert!(matches!(classify_sidecar_line(&lines[0].0), SidecarLine::Parsed(_)));
        assert!(pending.is_empty());
    }

    #[test]
    fn crlf_line_endings_are_stripped() {
        // Windows 上若有人重定向文本模式输出，行尾会带 \r，不能让它污染 JSON。
        let mut pending: Vec<u8> = b"{\"a\":1}\r\n".to_vec();
        let lines = take_complete_lines(&mut pending);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].0, "{\"a\":1}");
        assert!(matches!(classify_sidecar_line(&lines[0].0), SidecarLine::Parsed(_)));
    }

    #[test]
    fn many_lines_in_one_chunk_all_yield() {
        // 回归保护：旧实现一旦遇到坏行就整条流掐断，后面所有事件永久丢失。
        let mut pending: Vec<u8> = Vec::new();
        for index in 0..50 {
            pending.extend_from_slice(format!("{{\"id\":{index}}}\n").as_bytes());
        }
        let lines = take_complete_lines(&mut pending);
        assert_eq!(lines.len(), 50, "同一批里的每一行都必须产出");
        let parsed = lines
            .iter()
            .filter(|(line, _)| matches!(classify_sidecar_line(line), SidecarLine::Parsed(_)))
            .count();
        assert_eq!(parsed, 50);
    }

    #[test]
    fn read_chunk_shrinking_would_break_the_pending_guard() {
        // 承重契约（第六轮对抗性审查 D1）：内存护栏**只有在读取被切成有界小块时**
        // 才可达。read_until 会在内部循环到 \n/EOF/错误才返回，于是"活着但永不带
        // 换行"的流让护栏一次都执行不到；READ_CHUNK 必须存在且远小于上限。
        assert!(READ_CHUNK > 0, "块读取大小必须为正");
        assert!(
            READ_CHUNK <= SIDECAR_PENDING_LIMIT / 4,
            "一次 read 最多把 pending 推过上限 {READ_CHUNK} 字节，块大小必须显著小于上限（{SIDECAR_PENDING_LIMIT}）"
        );
    }

    #[test]
    fn reader_diagnostic_carries_session_id_when_known() {
        // D2 回归：两条读线程诊断原先不带 sessionId，前端 `payload.sessionId ||
        // activeSessionId; if (!id) return` 在 activeSessionId 为空时把它们整条丢掉，
        // 用户既看不到"输出流结束"也看不到"sidecar 已退出"。
        let payload = reader_diagnostic(&Some("s-1".to_string()), "断了".to_string());
        assert_eq!(payload.get("sessionId").and_then(Value::as_str), Some("s-1"));
        assert_eq!(payload.get("type").and_then(Value::as_str), Some("event"));
        assert_eq!(
            payload.get("event").and_then(|event| event.get("type")).and_then(Value::as_str),
            Some("error"),
            "必须沿用前端已理解的 event.type==='error' 形状"
        );
        assert_eq!(
            payload.get("event").and_then(|event| event.get("message")).and_then(Value::as_str),
            Some("断了")
        );
    }

    #[test]
    fn reader_diagnostic_omits_session_id_when_never_seen() {
        // 从未见过 sessionId（刚启动就崩）时不能凭空编造：字段必须缺省，让前端的
        // 兜底分支去处理（console.warn），而不是把诊断张冠李戴到某个会话头上。
        let payload = reader_diagnostic(&None, "sidecar 已退出".to_string());
        assert!(payload.get("sessionId").is_none(), "无会话归属时不得带 sessionId");
        assert_eq!(
            payload.get("event").and_then(|event| event.get("message")).and_then(Value::as_str),
            Some("sidecar 已退出")
        );
    }

    #[test]
    fn session_id_is_tracked_from_forwarded_messages() {
        // 读者通过 `message.get("sessionId")` 记住归属；这条固化判定本身，
        // 避免有人把它改成只看 `id`（响应消息用的是 id，事件才用 sessionId）。
        let mut last_session: Option<String> = None;
        for raw in [
            r#"{"type":"response","id":1}"#,
            r#"{"type":"event","sessionId":"s-9","event":{"type":"agent_start"}}"#,
        ] {
            match classify_sidecar_line(raw) {
                SidecarLine::Parsed(message) => {
                    if let Some(id) = message.get("sessionId").and_then(Value::as_str) {
                        last_session = Some(id.to_string());
                    }
                }
                other => panic!("{raw} 应解析为 JSON，实际 {other:?}"),
            }
        }
        assert_eq!(last_session.as_deref(), Some("s-9"));
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
