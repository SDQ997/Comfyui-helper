//! 文件日志：写入 exe 同目录 /logs/app.log（便携模式一致）。
//! - 简单 self-made 实现，不依赖 tauri-plugin-log（release 下只走文件）。
//! - 前端 JS 错误通过 frontend_log / frontend_panic 命令转发到同一文件。
//! - 单文件追加，超过 5MB 轮转为 app.log.1（保留 1 份历史）。
//! - 内存保留最近 5000 条（LOG_HISTORY），供前端「日志」页实时查看。

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5MB
const MAX_HISTORY: usize = 5000;

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogItem {
    pub id: u64,
    pub time: String,
    pub level: String,
    pub target: String,
    pub msg: String,
}

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);
static LOG_HISTORY: Mutex<VecDeque<LogItem>> = Mutex::new(VecDeque::new());

/// 初始化文件日志，返回日志目录路径。
pub fn init_file_logger() -> Result<PathBuf, String> {
    // 日志目录：exe 同目录 /logs；不可写则回退 %LOCALAPPDATA%/ComfyUI-Helper/logs
    let dir = log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败 {}: {e}", dir.display()))?;

    let path = dir.join("app.log");
    // 首次启动写一行分隔，方便肉眼定位会话边界
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    append_line(&path, &format!("\n---------- 新会话 {ts} ----------\n"))?;

    *LOG_FILE.lock().unwrap() = Some(path.clone());
    Ok(dir)
}

fn log_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let d = dir.join("logs");
            if std::fs::create_dir_all(&d).is_ok() {
                let probe = d.join(".write_test");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return d;
                }
            }
        }
    }
    // 回退：%LOCALAPPDATA%/ComfyUI-Helper/logs
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ComfyUI-Helper")
        .join("logs")
}

fn append_line(path: &PathBuf, line: &str) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志失败: {e}"))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("写日志失败: {e}"))
}

/// 供 log 宏与前端上报共用的写入口（带轮转 + 内存历史）。
pub fn write_log(level: &str, target: &str, msg: &str) {
    let guard = LOG_FILE.lock().unwrap();
    let Some(path) = guard.as_ref() else { return };

    // 轮转检查
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_SIZE {
            rotate(path);
        }
    }

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{ts}] [{level:<5}] [{target}] {msg}\n");
    let _ = append_line(path, &line);

    // 内存历史（供前端日志页实时读取）
    let id = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    let item = LogItem {
        id,
        time: ts.to_string(),
        level: level.to_string(),
        target: target.to_string(),
        msg: msg.to_string(),
    };
    let mut hist = LOG_HISTORY.lock().unwrap();
    hist.push_back(item);
    while hist.len() > MAX_HISTORY {
        hist.pop_front();
    }
}

/// 日志页拉取：after_id 之后的新条目（首次传 0 返回最近 500 条）。
#[tauri::command]
pub fn log_fetch(after_id: u64) -> Vec<LogItem> {
    let hist = LOG_HISTORY.lock().unwrap();
    if after_id == 0 {
        hist.iter().skip(hist.len().saturating_sub(500)).cloned().collect()
    } else {
        hist.iter().filter(|i| i.id > after_id).cloned().collect()
    }
}

/// 前端通用操作埋点：把任意 source 的日志写进历史与文件。
#[tauri::command]
pub fn log_emit(source: String, level: String, msg: String) {
    let lvl = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level.to_uppercase(),
        _ => "INFO".into(),
    };
    write_log(&lvl, &source, &msg);
}

fn rotate(path: &PathBuf) {
    // app.log.2 -> 删除；app.log.1 -> app.log.2；app.log -> app.log.1
    let log2 = path.with_extension("log.2");
    let log1 = path.with_extension("log.1");
    let _ = std::fs::remove_file(&log2);
    if log1.exists() {
        let _ = std::fs::rename(&log1, &log2);
    }
    let _ = std::fs::rename(path, &log1);
}

// ---------- Rust 侧 log crate 接入（debug 构建也走文件） ----------
#[derive(Clone)]
pub struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        write_log(&record.level().to_string(), record.target(), &record.args().to_string());
    }
    fn flush(&self) {}
}

static FILE_LOGGER: FileLogger = FileLogger;

pub fn install_rust_logger() {
    let _ = log::set_boxed_logger(Box::new(FILE_LOGGER.clone()));
    log::set_max_level(log::LevelFilter::Info);
}

// ---------- 启动看门狗 ----------
// 若 N 秒后前端仍未上报「已启动」，说明 webview 没能加载页面（黑屏/挂起），
// 自动把环境诊断信息写进日志，用户直接把日志发来即可定位。

pub static FRONTEND_STARTED: AtomicBool = AtomicBool::new(false);

pub fn mark_frontend_started() {
    let first = FRONTEND_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if first {
        write_log("INFO", "watchdog", "前端已成功启动（页面脚本执行到了）");
    }
}

fn query_webview2_version() -> String {
    // WebView2 Runtime 版本：读注册表（HKLM 与 HKCU 都试）
    let keys = [
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    for k in keys {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", k, "/v", "pv"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).to_string();
            for line in s.lines() {
                if line.contains("pv") {
                    let v = line.split_whitespace().last().unwrap_or("?").to_string();
                    return v;
                }
            }
        }
    }
    "(未检测到 WebView2 Runtime)".into()
}

fn count_webview_procs() -> usize {
    std::process::Command::new("tasklist")
        .args(["/fi", "imagename eq msedgewebview2.exe"])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.to_lowercase().contains("msedgewebview2"))
                .count()
        })
        .unwrap_or(0)
}

/// 启动看门狗线程：delay_secs 秒后检查前端是否已启动。
pub fn spawn_startup_watchdog(delay_secs: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(delay_secs));
        if FRONTEND_STARTED.load(Ordering::SeqCst) {
            return;
        }
        let wv = query_webview2_version();
        let procs = count_webview_procs();
        let gpu_arg = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .unwrap_or_else(|_| "(无)".into());

        let report = format!(
            "\n===== 启动看门狗告警 =====\n\
             启动 {delay_secs} 秒后前端仍未上报启动，webview 很可能没能加载页面（黑屏/挂起）。\n\
             WebView2 Runtime 版本: {wv}\n\
             msedgewebview2 进程数: {procs}\n\
             WebView2 附加参数: {gpu_arg}\n\
             建议:\n\
               1. 用 run-debug.bat 启动，浏览器打开 http://localhost:9222 看页面状态\n\
               2. 尝试设置 CH_WEBVIEW_GPU=1 后启动（若当前禁用了 GPU）\n\
               3. 确认系统已安装 WebView2 Runtime（上面若显示未检测到，去微软官网装）\n\
             ==============================\n"
        );
        write_log("ERROR", "watchdog", &report);
        eprintln!("{report}");
    });
}

// ---------- 前端上报 commands ----------

/// 前端 console / JS 错误上报。
/// level: debug | info | warn | error
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    let lvl = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level.to_uppercase(),
        _ => "INFO".into(),
    };
    write_log(&lvl, "frontend", &message);
}

/// 前端就绪信号：页面脚本已执行且 IPC 通道可用。由看门狗用于判定启动成功。
#[tauri::command]
pub fn frontend_ready() {
    mark_frontend_started();
}

/// 前端致命错误（window.onerror / unhandledrejection / React 崩溃边界）上报。
#[tauri::command]
pub fn frontend_panic(message: String, stack: Option<String>) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let mut text = format!("\n[{ts}] [FATAL] [frontend] ===== 前端崩溃 =====\n{message}\n");
    if let Some(s) = stack {
        text.push_str(&s);
        text.push('\n');
    }
    write_log("ERROR", "frontend", &text);
    eprintln!("{text}");
}
