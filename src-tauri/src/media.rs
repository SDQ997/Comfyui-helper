//! 隐藏资产持久化 + 视频缩略图（首帧）。
//! - 隐藏列表存 data/hidden.json（便携模式一致），跨会话保留。
//! - 视频缩略图用 ffmpeg 抽首帧到 data/thumbs/，文件名 = 路径哈希.jpg。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::config::AppConfig;
use crate::AppState;

// ---------------- 隐藏列表 ----------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HiddenStore {
    /// 隐藏的资产绝对路径集合
    paths: Vec<String>,
}

fn hidden_file() -> PathBuf {
    AppConfig::data_dir().join("hidden.json")
}

fn load_hidden() -> HiddenStore {
    std::fs::read_to_string(hidden_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 供 scan.rs 读取的隐藏路径列表
pub fn load_hidden_public() -> Vec<String> {
    load_hidden().paths
}

fn save_hidden(store: &HiddenStore) -> Result<(), String> {
    let path = hidden_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn with_hidden<F>(f: F) -> Result<String, String>
where
    F: FnOnce(&mut HiddenStore) -> bool,
{
    let mut store = load_hidden();
    let changed = f(&mut store);
    if changed {
        save_hidden(&store)?;
    }
    Ok(serde_json::to_string(&store.paths).unwrap_or_else(|_| "[]".into()))
}

/// 获取隐藏列表
#[tauri::command]
pub fn hidden_list() -> Result<Vec<String>, String> {
    Ok(load_hidden().paths)
}

/// 隐藏一个资产
#[tauri::command]
pub fn hidden_add(path: String) -> Result<Vec<String>, String> {
    with_hidden(|s| {
        if s.paths.contains(&path) {
            false
        } else {
            s.paths.push(path);
            true
        }
    })
    .map(|_| load_hidden().paths)
}

/// 取消隐藏
#[tauri::command]
pub fn hidden_remove(path: String) -> Result<Vec<String>, String> {
    with_hidden(|s| {
        let before = s.paths.len();
        s.paths.retain(|p| p != &path);
        s.paths.len() != before
    })
    .map(|_| load_hidden().paths)
}

/// 批量隐藏（全部隐藏）
#[tauri::command]
pub fn hidden_add_many(paths: Vec<String>) -> Result<Vec<String>, String> {
    with_hidden(|s| {
        let set: HashSet<String> = s.paths.iter().cloned().collect();
        let mut changed = false;
        for p in &paths {
            if !set.contains(p) {
                s.paths.push(p.clone());
                changed = true;
            }
        }
        changed
    })
    .map(|_| load_hidden().paths)
}

/// 批量取消隐藏
#[tauri::command]
pub fn hidden_remove_many(paths: Vec<String>) -> Result<Vec<String>, String> {
    with_hidden(|s| {
        let set: HashSet<String> = paths.iter().cloned().collect();
        let before = s.paths.len();
        s.paths.retain(|p| !set.contains(p));
        s.paths.len() != before
    })
    .map(|_| load_hidden().paths)
}

// ---------------- 视频缩略图 ----------------

static THUMB_LOCK: Mutex<()> = Mutex::new(());

/// 取视频首帧缩略图，返回本地文件路径（前端再用 convertFileSrc 转成可展示 URL）。
/// 已生成过则直接复用缓存。ffmpeg 不可用时返回错误文本。
#[tauri::command]
pub fn video_thumbnail(path: String) -> Result<String, String> {
    let _guard = THUMB_LOCK.lock().map_err(|e| e.to_string())?;

    // 缓存键：完整路径的哈希 + 文件 mtime，源文件更新后自动重新生成
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法读取视频文件: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{path}:{mtime}");
    let hash: u64 = {
        // FNV-1a 64
        let mut h: u64 = 0xcbf29ce484222325;
        for b in key.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    };

    let thumbs_dir = AppConfig::data_dir().join("thumbs");
    std::fs::create_dir_all(&thumbs_dir).map_err(|e| e.to_string())?;
    let out = thumbs_dir.join(format!("{hash:016x}.jpg"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }

    let (pair, _src) = crate::ffmpeg::find_ffmpeg();
    let (ff, _fp) = pair.ok_or("未检测到 ffmpeg，请先在「设置 → FFmpeg」中安装")?;

    let status = std::process::Command::new(&ff)
        .args([
            "-y",
            "-ss", "0",
            "-i", &path,
            "-frames:v", "1",
            "-vf", "scale=480:-2",
            "-q:v", "5",
        ])
        .arg(&out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

    if status.success() && out.exists() {
        Ok(out.to_string_lossy().into_owned())
    } else {
        let _ = std::fs::remove_file(&out);
        Err("抽帧失败（可能是不支持的编码格式）".into())
    }
}

/// 确保模块被引用（AppState 在 lib.rs 使用）
pub fn _touch(_s: &AppState) {}

/// 删除资产文件 → 移动到系统回收站（可恢复，防误删）。
/// 同时从隐藏列表移除该路径。
#[tauri::command]
pub fn delete_asset(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    log::info!("delete_asset: {path}");

    // 从隐藏列表移除（若在）
    let mut store = load_hidden();
    let before = store.paths.len();
    store.paths.retain(|x| x != &path);
    if store.paths.len() != before {
        let _ = save_hidden(&store);
    }

    // 移入回收站
    let ok = send_to_recycle_bin(&p);
    if !ok {
        // 回收站失败（如脚本被拦截）则永久删除
        log::warn!("回收站失败，尝试直接删除: {path}");
        std::fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 通过 PowerShell + Microsoft.VisualBasic 移动文件到回收站
fn send_to_recycle_bin(p: &std::path::Path) -> bool {
    let path = p.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{path}','OnlyErrorDialogs','SendToRecycleBin')"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
