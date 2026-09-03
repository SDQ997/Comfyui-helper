//! 提示词助手：OpenAI 兼容 API 代理（支持 SSE 流式），模型列表。

use crate::config::ApiEndpoint;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    /// 纯文本
    Text(String),
    /// OpenAI 多模态数组格式：[{type:"text",...},{type:"image_url",...}]
    Parts(Vec<serde_json::Value>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
}

/// 归一化 Base URL：容忍用户多填了路径（如 .../v1/chat/completions 或带尾斜杠）。
fn endpoint_url(base: &str, tail: &str) -> String {
    let b = base.trim();
    if b.is_empty() {
        return tail.to_string();
    }
    let b = b.trim_end_matches('/');
    // 若用户填的地址已包含目标路径（大小写不敏感），不再重复拼接
    if b.to_lowercase().ends_with(&format!("/{tail}").to_lowercase()) {
        b.to_string()
    } else {
        format!("{b}/{tail}")
    }
}

/// 拉取 /v1/models 列表（OpenAI 兼容格式；Ollama 也支持该端点）
#[tauri::command]
pub async fn list_models(endpoint: ApiEndpoint) -> Result<Vec<ModelInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            endpoint.timeout_secs.max(10),
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let url = endpoint_url(&endpoint.base_url, "models");
    let mut req = client.get(&url);
    if !endpoint.api_key.is_empty() {
        req = req.bearer_auth(&endpoint.api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json["data"].as_array() {
        for m in arr {
            if let Some(id) = m["id"].as_str() {
                out.push(ModelInfo { id: id.into() });
            }
        }
    }
    Ok(out)
}

/// 非流式聊天补全（首版简化：一次性返回；流式后续可加 event 回调）
#[tauri::command]
pub async fn chat_completion(
    app: tauri::AppHandle,
    endpoint: ApiEndpoint,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            endpoint.timeout_secs.max(30),
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let url = endpoint_url(&endpoint.base_url, "chat/completions");
    let body = serde_json::json!({
        "model": endpoint.model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.7),
        "stream": false
    });

    let mut req = client.post(&url).json(&body);
    if !endpoint.api_key.is_empty() {
        req = req.bearer_auth(&endpoint.api_key);
    }

    let _ = &app; // 预留：流式时用 app.emit 发送 chunk 事件
    log::info!(
        "chat_completion 开始 → {url} (model={}, messages={}, temp={:?})",
        endpoint.model,
        messages.len(),
        temperature
    );
    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| {
        log::error!("chat_completion 网络失败: {e}");
        e.to_string()
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        log::error!(
            "chat_completion HTTP {} (耗时 {:.1}s) :: {}",
            status,
            started.elapsed().as_secs_f64(),
            &text[..text.len().min(500)]
        );
        return Err(format!("HTTP {} :: {}", status, &text[..text.len().min(500)]));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad json: {} :: {}", e, &text[..text.len().min(200)]))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("unexpected response: {}", &text[..text.len().min(300)]))?;
    log::info!(
        "chat_completion 成功 (耗时 {:.1}s, 返回 {} 字)",
        started.elapsed().as_secs_f64(),
        content.chars().count()
    );
    Ok(content)
}
