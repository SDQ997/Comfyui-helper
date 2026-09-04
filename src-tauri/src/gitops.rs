//! 插件管理：基于 git2（libgit2）的状态查询与更新（fetch + pull --ff-only）。

use git2::{FetchOptions, ResetType, Repository};
use serde::{Deserialize, Serialize};

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

fn repo_status(repo: &Repository) -> Result<GitStatus, String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head
        .shorthand()
        .unwrap_or("HEAD")
        .to_string();
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
        let head = repo.head().map_err(|e| e.to_string())?;
        let branch = head.shorthand().unwrap_or("main").to_string();
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
        let head = repo.head().map_err(|e| e.to_string())?;
        let branch = head.shorthand().unwrap_or("main").to_string();

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
