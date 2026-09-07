//! 工作流 ↔ 模型联动：解析工作流 JSON，提取引用的模型文件标识，用于「排查未使用模型」。
//!
//! 兼容两种 ComfyUI 工作流格式：
//! - UI 格式：nodes[].inputs[] = [{ name: "ckpt_name", value: "xxx.safetensors" }, ...]
//! - API 格式：<node>.inputs = { ckpt_name: "xxx.safetensors", ... }
//!
//! 提取规则（不写死节点类型，靠输入字段名 + 值形态判断）：
//! 键名为 "name"/"value" 对（UI 格式）或对象键（API 格式）中，
//! 值是字符串且以常见模型扩展名结尾 → 视为模型引用。

use serde_json::Value;
use std::path::PathBuf;

/// 视为模型文件的扩展名（与模型管理页扫描范围一致）
const MODEL_EXTS: &[&str] = &[
    "safetensors", "ckpt", "pt", "pth", "bin", "sft", "gguf", "onnx",
];

fn looks_like_model(v: &str) -> bool {
    let lower = v.to_lowercase();
    MODEL_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

/// 递归收集 JSON 中的模型引用。
///
/// 不依赖键名判断：新版 ComfyUI 工作流（含 subgraph）中，模型引用可能以
/// 裸字符串出现在 `widgets_values` 数组（无键名）、`widgets_values_named`
/// 的 `unet_name_1` 之类带序号键、`properties.models[].name` 等多种形态。
/// 凡值以模型扩展名结尾即收集 —— 宁可多报（保守）也不漏报（漏报会导致
/// 「未引用」误判，进而可能误删在用模型）。
fn walk(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if looks_like_model(s) {
                out.push(s.clone());
            }
        }
        Value::Object(map) => {
            for val in map.values() {
                walk(val, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, out);
            }
        }
        _ => {}
    }
}

/// 解析一批工作流 JSON，返回去重后的模型引用标识列表（通常为相对 models 根的路径或文件名）
#[tauri::command]
pub fn extract_model_refs(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for p in &paths {
        let text = std::fs::read_to_string(PathBuf::from(p)).unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue, // 非 JSON / 损坏文件跳过
        };
        walk(&v, &mut out);
    }
    out.sort();
    out.dedup();
    Ok(out)
}
