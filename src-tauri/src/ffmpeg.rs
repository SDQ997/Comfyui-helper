//! ffmpeg / ffprobe 管理：检测系统 PATH 或 data/tools 目录内的 ffmpeg，
//! 不存在时引导用户下载（gyan.dev essentials 或镜像）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FfmpegStatus {
    pub installed: bool,
    pub source: String, // system | bundled | none
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub version: String,
    pub downloading: bool,
    pub progress: f64,
}

fn tools_dir() -> PathBuf {
    crate::config::AppConfig::data_dir().join("tools")
}

fn local_ffmpeg() -> Option<(PathBuf, PathBuf)> {
    let dir = tools_dir();
    let ff = dir.join("ffmpeg.exe");
    let fp = dir.join("ffprobe.exe");
    if ff.exists() && fp.exists() {
        Some((ff, fp))
    } else {
        None
    }
}

fn system_ffmpeg() -> Option<(PathBuf, PathBuf)> {
    // PATH 中查找
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let ff = dir.join("ffmpeg.exe");
            let fp = dir.join("ffprobe.exe");
            if ff.exists() && fp.exists() {
                return Some((ff, fp));
            }
        }
    }
    None
}

fn probe_version(ffmpeg: &PathBuf) -> String {
    std::process::Command::new(ffmpeg)
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.to_string()))
        .unwrap_or_default()
}

pub fn find_ffmpeg() -> (Option<(PathBuf, PathBuf)>, String) {
    if let Some(pair) = local_ffmpeg() {
        return (Some(pair), "bundled".into());
    }
    if let Some(pair) = system_ffmpeg() {
        return (Some(pair), "system".into());
    }
    (None, "none".into())
}

#[tauri::command]
pub fn ffmpeg_status() -> FfmpegStatus {
    let (pair, source) = find_ffmpeg();
    match pair {
        Some((ff, fp)) => FfmpegStatus {
            installed: true,
            source,
            ffmpeg_path: ff.to_string_lossy().into_owned(),
            ffprobe_path: fp.to_string_lossy().into_owned(),
            version: probe_version(&ff),
            downloading: false,
            progress: 1.0,
        },
        None => FfmpegStatus {
            installed: false,
            source: "none".into(),
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            version: String::new(),
            downloading: false,
            progress: 0.0,
        },
    }
}

/// 候选下载地址（顺序自动回退）。国内直连 gyan.dev 常超时，
/// 优先走 ghproxy 镜像 → GitHub Release → gyan.dev。
fn candidate_urls(mirror: Option<String>) -> Vec<String> {
    let mut v = Vec::new();
    if let Some(m) = mirror {
        if !m.trim().is_empty() {
            v.push(m.trim().to_string());
        }
    }
    // GitHub 上的 gyan 官方 essentials 构建
    v.push("https://ghproxy.net/https://github.com/GyanD/codexffmpeg/releases/latest/download/ffmpeg-release-essentials.zip".into());
    v.push("https://github.com/GyanD/codexffmpeg/releases/latest/download/ffmpeg-release-essentials.zip".into());
    v.push("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".into());
    v
}

#[tauri::command]
pub async fn download_ffmpeg(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    mirror: Option<String>,
) -> Result<FfmpegStatus, String> {
    if let (Some(_), _) = find_ffmpeg() {
        return Ok(ffmpeg_status());
    }

    let task_id: String = "ffmpeg_download".to_string();
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().await;
        flags.insert(task_id.clone(), flag.clone());
    }

    let dir = tools_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join("ffmpeg.zip");

    // 带超时的客户端：连接 15s、整体读取 10 分钟，避免无限挂起
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let urls = candidate_urls(mirror);

    // 逐个镜像尝试（HEAD 探测可用性再 GET）
    let mut resp: Option<reqwest::Response> = None;
    let mut last_err = String::new();
    for (i, url) in urls.iter().enumerate() {
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let _ = app.emit("ffmpeg_download_stage", format!("正在连接镜像 {}…", i + 1));
        // HEAD 探测（部分 CDN 不支持 HEAD，失败不致命）
        let head_ok = client
            .head(url)
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().is_redirection())
            .unwrap_or(false);
        if !head_ok {
            last_err = format!("镜像 {i} 不可达");
            continue;
        }
        match client.get(url).send().await {
            Ok(r) if r.status().is_success() => {
                resp = Some(r);
                break;
            }
            Ok(r) => {
                last_err = format!("镜像 {i} HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = format!("镜像 {i} 错误: {e}");
                continue;
            }
        }
    }
    let resp = match resp {
        Some(r) => r,
        None => {
            log::error!("所有 ffmpeg 镜像均失败: {last_err}");
            return Err(format!("所有下载源均失败：{last_err}。可检查网络后在设置中填入镜像地址。"));
        }
    };
    let total = resp.content_length().unwrap_or(0);
    log::info!("ffmpeg 下载开始, 大小 {}MB", total as f64 / 1048576.0);

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    use std::io::Write;

    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let mut last_tick = std::time::Instant::now();

    // 取消信号轮询与下载流并发：点「取消」~250ms 内中断，避免网络卡住时无法取消
    let mut cancel_ticker = tokio::time::interval(std::time::Duration::from_millis(250));
    cancel_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut download_done = false;
    while !download_done {
        tokio::select! {
            _ = cancel_ticker.tick() => {
                if flag.load(Ordering::Relaxed) {
                    log::info!("ffmpeg 下载收到取消信号");
                    let _ = std::fs::remove_file(&zip_path);
                    let mut flags = state.cancel_flags.lock().await;
                    flags.remove(&task_id);
                    return Err("cancelled".into());
                }
            }
            chunk = stream.next() => {
                match chunk {
                    None => { download_done = true; }
                    Some(Err(e)) => return Err(format!("download error: {e}")),
                    Some(Ok(chunk)) => {
                        file.write_all(&chunk).map_err(|e| e.to_string())?;
                        downloaded += chunk.len() as u64;
                        // 每 256KB 或每 300ms 推送一次进度
                        let now = std::time::Instant::now();
                        if (total > 0 && downloaded - last_emitted > 256 * 1024)
                            || now.duration_since(last_tick) > std::time::Duration::from_millis(300)
                        {
                            last_emitted = downloaded;
                            last_tick = now;
                            let progress = if total > 0 {
                                downloaded as f64 / total as f64
                            } else {
                                0.0
                            };
                            let _ = app.emit("ffmpeg_download_progress", progress);
                            let _ = app.emit("ffmpeg_download_bytes", downloaded as f64);
                        }
                    }
                }
            }
        }
    }
    file.flush().ok();
    drop(file);

    let _ = app.emit("ffmpeg_download_progress", 1.0f64);

    // 解压：Windows 上用 tar（Win10+ 自带 bsdtar，支持 zip）
    let _ = app.emit("ffmpeg_download_stage", "正在解压…");
    let status = std::process::Command::new("tar")
        .args(["-xf"])
        .arg(&zip_path)
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        return Err("unzip failed (tar). 请手动解压 ffmpeg.zip 到 data/tools 并重命名 ffmpeg.exe/ffprobe.exe 到 tools 根目录".into());
    }
    let _ = std::fs::remove_file(&zip_path);

    // gyan.dev zip 内有层级目录 ffmpeg-x.x-essentials_build/bin/ffmpeg.exe，需要搬到 tools 根
    if local_ffmpeg().is_none() {
        // 搜索解压出的 ffmpeg.exe
        for entry in walkdir::WalkDir::new(&dir).max_depth(4).into_iter().flatten() {
            if entry.file_name() == "ffmpeg.exe" && entry.path().parent().map(|p| p.file_name()).map_or(false, |n| n == Some(std::ffi::OsStr::new("bin"))) {
                let bin_dir = entry.path().parent().unwrap();
                for exe in ["ffmpeg.exe", "ffprobe.exe"] {
                    let src = bin_dir.join(exe);
                    if src.exists() {
                        let _ = std::fs::copy(&src, dir.join(exe));
                    }
                }
                break;
            }
        }
    }

    {
        let mut flags = state.cancel_flags.lock().await;
        flags.remove(&task_id);
    }

    if local_ffmpeg().is_some() {
        Ok(ffmpeg_status())
    } else {
        Err("ffmpeg installed but not detected after extraction".into())
    }
}

#[tauri::command]
pub async fn cancel_download(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let flags = state.cancel_flags.lock().await;
    if let Some(flag) = flags.get("ffmpeg_download") {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
