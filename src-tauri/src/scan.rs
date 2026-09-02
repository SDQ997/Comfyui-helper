//! 资产 / LoRA / 插件目录扫描。全部纯 std + walkdir，不占显存，内存占用与文件数线性相关但极小。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub static VIDEO_EXTS: &[&str] = &["mp4", "mkv", "webm", "mov", "avi", "flv", "wmv", "m4v"];
pub static IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
pub static AUDIO_EXTS: &[&str] = &["wav", "mp3", "flac", "ogg", "m4a", "aac"];
pub static TEXT_EXTS: &[&str] = &["txt", "md", "json", "yaml", "yml"];
pub static LORA_EXTS: &[&str] = &["safetensors", "pt", "pth", "ckpt"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetEntry {
    pub path: String,
    pub name: String,
    pub kind: String, // video | image | audio | text | other
    pub size: u64,
    pub modified: i64,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoraEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    /// 同目录同名 txt 是否存在
    pub has_txt: bool,
    pub trigger_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEntry {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub status: String, // up-to-date | behind | ahead | diverged | error
    pub behind: u32,
    pub ahead: u32,
    pub last_commit: String,
    pub last_commit_msg: String,
    pub has_remote: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn classify(ext: &str) -> &'static str {
    if VIDEO_EXTS.contains(&ext) {
        "video"
    } else if IMAGE_EXTS.contains(&ext) {
        "image"
    } else if AUDIO_EXTS.contains(&ext) {
        "audio"
    } else if TEXT_EXTS.contains(&ext) {
        "text"
    } else {
        "other"
    }
}

/// 检查同目录下 .hidden 标记文件（旧版兼容；新版由 media.rs 的 hidden.json 持久化）
fn is_hidden(p: &Path) -> bool {
    if let Some(stem) = p.file_stem() {
        let marker = p.with_file_name(format!(".{}", stem.to_string_lossy()));
        if marker.exists() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub fn scan_assets(dirs: Vec<String>) -> Result<Vec<AssetEntry>, String> {
    // 合并旧版标记文件与新版 hidden.json 两种隐藏来源
    let hidden_set: std::collections::HashSet<String> =
        crate::media::load_hidden_public().into_iter().collect();
    let mut out = Vec::new();
    for dir in &dirs {
        let root = PathBuf::from(dir);
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .max_depth(8)
            .into_iter()
            // 过滤系统/隐藏目录：跳过 "." "#" 开头的目录（含 #SyncVersion 等云盘标记）
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                !(name.starts_with('.') || name.starts_with('#'))
            })
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let fname = entry.file_name().to_string_lossy();
            // 过滤系统/隐藏文件本身（.#SyncVersion / .DS_Store / 旧的隐藏标记等）
            if fname.starts_with('.') || fname.starts_with('#') {
                continue;
            }
            let ext = ext_of(entry.path());
            let kind = classify(&ext);
            if kind == "other" {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path_str = entry.path().to_string_lossy().into_owned();
            out.push(AssetEntry {
                hidden: is_hidden(entry.path()) || hidden_set.contains(&path_str),
                path: path_str,
                name: entry
                    .file_name()
                    .to_string_lossy()
                    .into_owned(),
                kind: kind.into(),
                size: meta.len(),
                modified,
            });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn scan_loras(dirs: Vec<String>) -> Result<Vec<LoraEntry>, String> {
    let mut out = Vec::new();
    for dir in &dirs {
        let root = PathBuf::from(dir);
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .max_depth(4)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let ext = ext_of(entry.path());
            if !LORA_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path = entry.path();
            let txt_path = path.with_extension("txt");
            let has_txt = txt_path.exists();
            let trigger_words = if has_txt {
                std::fs::read_to_string(&txt_path)
                    .unwrap_or_default()
                    .split(['、', ','])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else {
                Vec::new()
            };
            out.push(LoraEntry {
                path: path.to_string_lossy().into_owned(),
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: meta.len(),
                modified,
                has_txt,
                trigger_words,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 列出目录树（文件夹视图模式），浅层浏览由前端分页调用
#[tauri::command]
pub fn list_directory_tree(path: String, depth: u32) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .max_depth(depth.max(1) as usize)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            out.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn scan_plugins(dir: String) -> Result<Vec<PluginEntry>, String> {
    // git 状态由前端逐个调用 plugin_status 获取，此处仅列出含 .git 的子目录
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", dir));
    }
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.join(".git").exists() {
            out.push(PluginEntry {
                path: p.to_string_lossy().into_owned(),
                name: p
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                branch: String::new(),
                status: "unknown".into(),
                behind: 0,
                ahead: 0,
                last_commit: String::new(),
                last_commit_msg: String::new(),
                has_remote: false,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
