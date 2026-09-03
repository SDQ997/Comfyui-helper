//! 应用配置：存储在 exe 同目录的 `data/config.toml`（便携模式）。
//! 若 exe 目录不可写（如 Program Files），回退到 %APPDATA%/ComfyUI-Helper。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ApiEndpoint {
    pub id: String,
    pub name: String,
    /// openai | anthropic | ollama
    pub kind: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_secs: u64,
    /// 是否具备图片理解能力（勾选后提示词助手可上传图片给 AI 分析）
    pub vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub content: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DirectoryGroup {
    /// assets | loras | plugins | comfyui | cache
    pub kind: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GeneralSettings {
    pub language: String,
    pub minimize_to_tray: bool,
    pub generate_thumbnails: bool,
    pub hide_unmarked_assets: bool,
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DonateConfig {
    pub wechat_qr: String,
    pub alipay_qr: String,
    pub afadian_url: String,
    pub show_donate_entry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub endpoints: Vec<ApiEndpoint>,
    pub default_endpoint_id: Option<String>,
    pub templates: Vec<PromptTemplate>,
    pub skills: Vec<Skill>,
    pub directories: Vec<DirectoryGroup>,
    pub general: GeneralSettings,
    pub donate: DonateConfig,
}

impl AppConfig {
    pub fn data_dir() -> PathBuf {
        // 便携模式：exe 同目录 /data
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let portable = dir.join("data");
                // 尝试创建，成功则使用便携目录
                if std::fs::create_dir_all(&portable).is_ok() {
                    let probe = portable.join(".write_test");
                    if std::fs::write(&probe, b"ok").is_ok() {
                        let _ = std::fs::remove_file(&probe);
                        return portable;
                    }
                }
            }
        }
        // 回退 %APPDATA%
        let appdata = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ComfyUI-Helper");
        let _ = std::fs::create_dir_all(&appdata);
        appdata
    }

    pub fn config_path() -> PathBuf {
        Self::data_dir().join("config.toml")
    }

    pub fn load_or_default() -> Self {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(s) => toml::from_str(&s).unwrap_or_default(),
            Err(_) => {
                let cfg = Self::with_defaults();
                let _ = cfg.save_sync();
                cfg
            }
        }
    }

    pub fn with_defaults() -> Self {
        Self {
            general: GeneralSettings {
                language: "zh-CN".into(),
                minimize_to_tray: false,
                generate_thumbnails: true,
                hide_unmarked_assets: false,
                theme: "dark".into(),
            },
            donate: DonateConfig {
                show_donate_entry: true,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn save_sync(&self) -> Result<(), String> {
        let path = Self::config_path();
        let toml_str = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, toml_str).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_config(state: tauri::State<'_, AppState>) -> Result<AppConfig, String> {
    let cfg = state.config.lock().await;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn save_config(
    state: tauri::State<'_, AppState>,
    config: AppConfig,
) -> Result<(), String> {
    {
        let mut cfg = state.config.lock().await;
        *cfg = config.clone();
    }
    config.save_sync()
}

#[tauri::command]
pub fn get_data_dir() -> String {
    AppConfig::data_dir().to_string_lossy().into_owned()
}

/// 读取任意 UTF-8 文本文件（用于导入 Skill 等，避免 fs 插件的 scope 限制）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    log::info!("read_text_file: {path}");
    // 简单防护：仅允许常见文本扩展名
    let lower = path.to_lowercase();
    let ok = [".md", ".txt", ".markdown", ".toml", ".json", ".yaml", ".yml", ".css", ".js", ".ts"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !ok {
        return Err("仅支持导入文本类文件（.md / .txt 等）".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}
