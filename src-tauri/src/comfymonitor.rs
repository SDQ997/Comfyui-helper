//! ComfyUI 实时监控：轮询 ComfyUI 内置 HTTP 接口，获取控制台日志与结构化报错。
//!
//! 数据源（ComfyUI 原生提供，零侵入）：
//! - GET /internal/logs/raw   → 控制台日志环形缓冲 [{t, m}, ...]（默认容量 300）
//! - GET /history?max_items=N → 执行历史；失败条目 status.messages 里带
//!   execution_error 结构化信息（prompt_id / node_type / node_id / exception / traceback）
//!
//! 前端定时轮询这两个命令即可实现实时监控；报错的节点输入参数从
//! history 条目的 prompt[1] 图中本地解析，仅上报告错上下文给 AI。

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))
}

fn trim_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// 剥离 ANSI 转义序列（ComfyUI 控制台日志带颜色码，如 ESC[31m，直接显示会乱码）
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // 跳过 ESC[...<结束字母>（CSI 序列）
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[derive(Serialize)]
pub struct RawLogEntry {
    pub t: String,
    pub m: String,
}

/// GET /internal/logs/raw → 控制台日志条目
#[tauri::command]
pub async fn comfyui_raw_logs(base: String) -> Result<Vec<RawLogEntry>, String> {
    let url = format!("{}/internal/logs/raw", trim_base(&base));
    let v: Value = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("无法连接 ComfyUI: {e}"))?
        .json()
        .await
        .map_err(|e| format!("日志响应解析失败: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
        for e in arr {
            out.push(RawLogEntry {
                t: e.get("t").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                m: strip_ansi(e.get("m").and_then(|x| x.as_str()).unwrap_or("")),
            });
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct ComfyNodeInput {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct HistoryError {
    pub prompt_id: String,
    pub node_type: String,
    pub node_id: String,
    pub exception_type: String,
    pub exception_message: String,
    pub traceback: Vec<String>,
    pub node_inputs: Vec<ComfyNodeInput>,
}

/// 节点输入值转可读字符串：原始值直接用；节点引用 [id, slot] → "@节点id:槽"；
/// 长数组/长字符串截断，避免把图片数据之类塞进上下文。
fn render_input(v: &Value) -> String {
    match v {
        Value::String(s) => {
            if s.chars().count() > 120 {
                format!("{}…（长文本已截断）", s.chars().take(120).collect::<String>())
            } else {
                s.clone()
            }
        }
        Value::Number(_) | Value::Bool(_) => v.to_string(),
        Value::Array(arr) => {
            // [node_id, slot] = 节点输出引用
            if arr.len() == 2 && arr[0].is_number() && arr[1].is_number() {
                return format!("@节点{}:槽{}", arr[0], arr[1]);
            }
            if arr.len() > 6 {
                return format!("（数组，{} 项）", arr.len());
            }
            let parts: Vec<String> = arr.iter().map(render_input).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Null => "null".into(),
        Value::Object(_) => "（对象）".into(),
    }
}

/// GET /history?max_items=64 → 提取 status_str == "error" 的条目（结构化报错）
#[tauri::command]
pub async fn comfyui_history_errors(base: String) -> Result<Vec<HistoryError>, String> {
    let url = format!("{}/history?max_items=64", trim_base(&base));
    let v: Value = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("无法连接 ComfyUI: {e}"))?
        .json()
        .await
        .map_err(|e| format!("history 响应解析失败: {e}"))?;

    let mut out: Vec<HistoryError> = Vec::new();
    let Some(map) = v.as_object() else {
        return Ok(out);
    };
    for (prompt_id, entry) in map {
        let Some(status) = entry.get("status") else { continue };
        if status.get("status_str").and_then(|x| x.as_str()) != Some("error") {
            continue;
        }
        let Some(messages) = status.get("messages").and_then(|x| x.as_array()) else {
            continue;
        };
        for msg in messages {
            let Some(arr) = msg.as_array() else { continue };
            if arr.first().and_then(|x| x.as_str()) != Some("execution_error") {
                continue;
            }
            let Some(d) = arr.get(1) else { continue };
            let node_id = d
                .get("node_id")
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();

            // 从 prompt[1] 图中取该节点的 inputs（本地解析，不整体上报）
            let mut node_inputs: Vec<ComfyNodeInput> = Vec::new();
            if let Some(graph) = entry
                .get("prompt")
                .and_then(|p| p.get(1))
                .and_then(|g| g.as_object())
            {
                if let Some(node) = graph.get(&node_id).and_then(|n| n.get("inputs")).and_then(|i| i.as_object()) {
                    for (name, val) in node {
                        node_inputs.push(ComfyNodeInput {
                            name: name.clone(),
                            value: render_input(val),
                        });
                    }
                }
            }

            out.push(HistoryError {
                prompt_id: prompt_id.clone(),
                node_type: d
                    .get("node_type")
                    .and_then(|x| x.as_str())
                    .unwrap_or("未知节点")
                    .to_string(),
                node_id,
                exception_type: d
                    .get("exception_type")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                exception_message: d
                    .get("exception_message")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                traceback: d
                    .get("traceback")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|l| l.as_str())
                            .map(|l| l.trim_end_matches('\n').to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                node_inputs,
            });
        }
    }
    Ok(out)
}
