//! 插件管理：基于 git2（libgit2）的状态查询与更新（fetch + pull --ff-only）。

use git2::{FetchOptions, ResetType, Repository};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub status: String, // up-to-date | behind | ahead | diverged | no-remote | error
    pub behind: u32,
    pub ahead: u32,
    pub last_commit: String,
    pub last_commit_msg: String,
    pub has_remote: bool,
}

/// 解析当前应对比的分支名。
/// 正常在分支上 → 直接返回分支名。
/// detached HEAD（如手动 checkout 过某提交）→ 先找指向同一提交的本地分支；
/// 找不到再回退远程默认分支（origin/main / origin/master）。
/// 修复：detached HEAD 会被误判为 no-remote-branch 而漏检更新。
fn resolve_branch(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    if !repo.head_detached().unwrap_or(false) {
        return Ok(head.shorthand().unwrap_or("main").to_string());
    }
    let oid = head.target().ok_or("detached HEAD")?;
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
        for pair in branches.flatten() {
            let (b, _) = pair;
            if b.get().target() == Some(oid) {
                if let Ok(Some(name)) = b.name() {
                    return Ok(name.to_string());
                }
            }
        }
    }
    for cand in ["main", "master"] {
        if repo
            .find_reference(&format!("refs/remotes/origin/{}", cand))
            .is_ok()
        {
            return Ok(cand.to_string());
        }
    }
    Ok("main".to_string())
}

fn repo_status(repo: &Repository) -> Result<GitStatus, String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = resolve_branch(repo)?;
    let oid = head.target().ok_or("detached HEAD")?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| e.to_string())?;
    let time = commit.time();
    let last_commit = chrono::DateTime::from_timestamp(time.seconds(), 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let last_commit_msg = commit.summary().unwrap_or("").to_string();

    let remote_name = repo
        .find_remote("origin")
        .ok()
        .map(|_| "origin".to_string());
    let has_remote = remote_name.is_some();

    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut status = "up-to-date".to_string();

    if has_remote {
        // 读取本地缓存的 remote tracking branch（不联网）
        let tracking = format!("refs/remotes/origin/{}", branch);
        if let Ok(tracking_ref) = repo.find_reference(&tracking) {
            if let (Some(local_oid), Some(remote_oid)) = (head.target(), tracking_ref.target()) {
                let graph = repo
                    .graph_ahead_behind(local_oid, remote_oid)
                    .map_err(|e| e.to_string())?;
                ahead = graph.0 as u32;
                behind = graph.1 as u32;
                status = match (ahead > 0, behind > 0) {
                    (true, true) => "diverged".into(),
                    (true, false) => "ahead".into(),
                    (false, true) => "behind".into(),
                    (false, false) => "up-to-date".into(),
                };
            }
        } else {
            status = "no-remote-branch".into();
        }
    } else {
        status = "no-remote".into();
    }

    Ok(GitStatus {
        path: repo.path().parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        name: repo
            .path()
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        branch,
        status,
        behind,
        ahead,
        last_commit,
        last_commit_msg,
        has_remote,
    })
}

#[tauri::command]
pub fn plugin_status(path: String) -> Result<GitStatus, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    repo_status(&repo)
}

/// 拉取远程分支到本地 tracking ref（fetch only，不动工作区）。proxy auto：跟随 git config 的
/// http.proxy 与环境变量，与命令行 git 行为一致（否则 libgit2 直连 GitHub 可能失败）。
fn fetch_remote(repo: &Repository, branch: &str) -> Result<(), String> {
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("no origin remote: {}", e))?;
    let mut fo = FetchOptions::new();
    let mut po = git2::ProxyOptions::new();
    po.auto();
    fo.proxy_options(po);
    remote
        .fetch(
            &[&format!("refs/heads/{}:refs/remotes/origin/{}", branch, branch)],
            Some(&mut fo),
            None,
        )
        .map_err(|e| {
            format!(
                "fetch failed: {}（可能是网络问题：直连 GitHub 失败，可在 git config 设置 http.proxy 后重试）",
                e
            )
        })
}

/// 仅联网检查：fetch 远程但不合并/更新本地，返回真实 ahead/behind 状态
#[tauri::command]
pub async fn plugin_check(path: String) -> Result<GitStatus, String> {
    let path_cloned = path.clone();
    tokio::task::spawn_blocking(move || -> Result<GitStatus, String> {
        let repo = Repository::open(&path_cloned).map_err(|e| e.to_string())?;
        let branch = resolve_branch(&repo)?;
        fetch_remote(&repo, &branch)?;
        repo_status(&repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugin_update(path: String) -> Result<GitStatus, String> {
    // git2 是同步库，放到阻塞线程执行
    let path_cloned = path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<GitStatus, String> {
        let repo = Repository::open(&path_cloned).map_err(|e| e.to_string())?;
        let branch = resolve_branch(&repo)?;

        // fetch（匿名；私有仓库不支持，ComfyUI 插件均为公开仓库）
        fetch_remote(&repo, &branch)?;

        // 尝试 fast-forward 到 origin/branch
        let tracking_ref = repo
            .find_reference(&format!("refs/remotes/origin/{}", branch))
            .map_err(|e| e.to_string())?;
        let target_oid = tracking_ref.target().ok_or("no target")?;
        let target_commit = repo.find_commit(target_oid).map_err(|e| e.to_string())?;

        let head_ref = repo.head().map_err(|e| e.to_string())?;

        // 是否可以 ff：本地是目标的祖先
        let annotated = repo
            .reference_to_annotated_commit(&tracking_ref)
            .map_err(|e| e.to_string())?;
        let analysis = repo
            .merge_analysis_for_ref(&head_ref, &[&annotated])
            .map_err(|e| e.to_string())?;

        if analysis.0.is_up_to_date() {
            // nothing to do
        } else if analysis.0.is_fast_forward() {
            repo.checkout_tree(
                target_commit.as_object(),
                Some(git2::build::CheckoutBuilder::default().force()),
            )
            .map_err(|e| e.to_string())?;
            repo.set_head_detached(target_oid).map_err(|e| e.to_string())?;
            // 回到 branch 引用
            repo.set_head(&format!("refs/heads/{}", branch))
                .map_err(|e| e.to_string())?;
            // 更新 branch 引用
            let mut branch_ref = repo
                .find_branch(&branch, git2::BranchType::Local)
                .map_err(|e| e.to_string())?;
            branch_ref
                .get_mut()
                .set_target(target_oid, "fast-forward update")
                .map_err(|e| e.to_string())?;
            // checkout 实际工作区
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .map_err(|e| e.to_string())?;
        } else if analysis.0.is_normal() {
            // 本地有改动：hard reset 到远程（插件场景下可接受，但风险提示由前端负责）
            repo.reset(
                target_commit.as_object(),
                ResetType::Hard,
                None,
            )
            .map_err(|e| format!("local changes conflict; hard reset failed: {}", e))?;
        }

        repo_status(&repo)
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

/// 从 git URL 克隆插件到 custom_nodes 目录下（公开仓库匿名克隆；proxy 跟随 git config）
#[tauri::command]
pub async fn plugin_clone(url: String, dest_parent: String) -> Result<String, String> {
    let url_trim = url.trim().to_string();
    if url_trim.is_empty() {
        return Err("URL 不能为空".into());
    }
    let dest_parent_cloned = dest_parent.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        // 从 URL 提取仓库名：取最后一段并去掉 .git 后缀
        let repo_name = url_trim
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .trim_end_matches(".git")
            .to_string();
        if repo_name.is_empty() {
            return Err(format!("无法从 URL 解析仓库名: {url_trim}"));
        }
        let dest = PathBuf::from(&dest_parent_cloned).join(&repo_name);
        if dest.exists() {
            return Err(format!("目标已存在: {}", dest.display()));
        }
        std::fs::create_dir_all(&dest_parent_cloned).map_err(|e| format!("创建目录失败: {e}"))?;

        let mut fo = FetchOptions::new();
        let mut po = git2::ProxyOptions::new();
        po.auto();
        fo.proxy_options(po);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fo);
        builder
            .clone(&url_trim, &dest)
            .map_err(|e| format!("clone 失败: {e}"))?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用 ComfyUI 的 python 安装插件依赖（pip install -r requirements.txt），返回完整输出
#[tauri::command]
pub async fn plugin_install_deps(path: String, python: String) -> Result<String, String> {
    let path_cloned = path.clone();
    let python_cloned = python.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let req = PathBuf::from(&path_cloned).join("requirements.txt");
        if !req.is_file() {
            return Err("该插件没有 requirements.txt，无需安装依赖".into());
        }
        if python_cloned.trim().is_empty() {
            return Err("未配置 ComfyUI Python 路径，请前往 设置 → 通用 填写".into());
        }
        let py = PathBuf::from(&python_cloned);
        if !py.is_file() {
            return Err(format!("Python 路径不存在: {python_cloned}"));
        }
        let mut cmd = std::process::Command::new(&py);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd.args(["-m", "pip", "install", "-r"])
            .arg(&req)
            .stdin(std::process::Stdio::null());
        let out = cmd
            .output()
            .map_err(|e| format!("启动 pip 失败: {e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        let err_text = String::from_utf8_lossy(&out.stderr);
        if !err_text.trim().is_empty() {
            text.push_str(&err_text);
        }
        if !out.status.success() {
            return Err(format!(
                "pip 退出码 {:?}\n{}",
                out.status.code(),
                text.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()
            ));
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}
