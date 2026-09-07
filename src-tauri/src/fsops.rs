//! 文件操作：复制文件到目标目录、创建子目录、移动文件夹。
//! 供 LoRA / 模型 / 工作流 / 插件管理页的「添加」功能使用。

use std::path::{Path, PathBuf};

/// 清理文件夹名中的非法字符（Windows 文件名保留字符）
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 复制多个文件到目标目录（目录不存在则创建；同名文件覆盖）
#[tauri::command]
pub fn copy_files_in(files: Vec<String>, dest_dir: String) -> Result<usize, String> {
    if files.is_empty() {
        return Err("未选择文件".into());
    }
    let dest = PathBuf::from(&dest_dir);
    std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败: {e}"))?;
    let mut copied = 0;
    for f in &files {
        let src = PathBuf::from(f);
        if !src.is_file() {
            return Err(format!("不是文件: {f}"));
        }
        let name = src
            .file_name()
            .ok_or_else(|| format!("路径异常: {f}"))?;
        let target = dest.join(name);
        std::fs::copy(&src, &target).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
        copied += 1;
    }
    Ok(copied)
}

/// 在父目录下创建子目录（名称自动清理非法字符），返回完整路径
#[tauri::command]
pub fn create_subdir(parent: String, name: String) -> Result<String, String> {
    let clean = sanitize_name(&name);
    if clean.is_empty() {
        return Err("文件夹名不能为空".into());
    }
    let p = PathBuf::from(&parent).join(&clean);
    if p.exists() {
        return Err(format!("已存在: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("创建失败: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// 递归复制目录
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    let rd = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        if sp.is_dir() {
            copy_dir_recursive(&sp, &dp)?;
        } else {
            std::fs::copy(&sp, &dp).map_err(|e| format!("复制 {} 失败: {e}", sp.display()))?;
        }
    }
    Ok(())
}

/// 把已有文件夹移入目标父目录（同盘 rename 秒完成；跨盘回退为复制+删除）
/// 返回移动后的完整路径
#[tauri::command]
pub fn move_dir_into(src_dir: String, dest_parent: String) -> Result<String, String> {
    let src = PathBuf::from(&src_dir);
    if !src.is_dir() {
        return Err(format!("不是目录: {src_dir}"));
    }
    let name = src
        .file_name()
        .ok_or_else(|| format!("路径异常: {src_dir}"))?
        .to_string_lossy()
        .into_owned();
    let dest = PathBuf::from(&dest_parent).join(&name);
    if dest.exists() {
        return Err(format!("目标已存在: {}", dest.display()));
    }
    std::fs::create_dir_all(&dest_parent).map_err(|e| format!("创建目录失败: {e}"))?;
    if std::fs::rename(&src, &dest).is_ok() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    // 跨盘回退：复制后删除源
    copy_dir_recursive(&src, &dest)?;
    std::fs::remove_dir_all(&src).map_err(|e| format!("移动后清理源目录失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 移动单个文件到目标目录（同盘 rename；跨盘回退为复制+删除源）。
/// 供 LoRA / 工作流 / 模型管理页的「移动」与拖拽功能使用。返回移动后的完整路径。
#[tauri::command]
pub fn move_file(src: String, dest_dir: String) -> Result<String, String> {
    let s = PathBuf::from(&src);
    if !s.is_file() {
        return Err(format!("不是文件: {src}"));
    }
    let name = s.file_name().ok_or_else(|| format!("路径异常: {src}"))?;
    let d = PathBuf::from(&dest_dir);
    if !d.is_dir() {
        return Err(format!("目标不是目录: {dest_dir}"));
    }
    let target = d.join(name);
    if target.exists() {
        return Err(format!("目标已存在同名文件: {}", target.display()));
    }
    if std::fs::rename(&s, &target).is_ok() {
        return Ok(target.to_string_lossy().into_owned());
    }
    std::fs::copy(&s, &target).map_err(|e| format!("复制失败: {e}"))?;
    std::fs::remove_file(&s).map_err(|e| format!("跨盘移动后清理源文件失败: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}
