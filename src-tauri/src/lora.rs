//! LoRA 触发词读写：同名 txt，顿号分隔。

use std::path::Path;

/// txt 路径 = lora 路径（去扩展名）+ .txt
fn txt_path_for(lora_path: &str) -> Result<std::path::PathBuf, String> {
    let p = Path::new(lora_path);
    if !p.exists() {
        return Err(format!("lora not found: {}", lora_path));
    }
    Ok(p.with_extension("txt"))
}

#[tauri::command]
pub fn read_trigger_words(lora_path: String) -> Result<Vec<String>, String> {
    let txt = txt_path_for(&lora_path)?;
    if !txt.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&txt).map_err(|e| e.to_string())?;
    Ok(content
        .split(['、', ','])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[tauri::command]
pub fn write_trigger_words(lora_path: String, words: Vec<String>) -> Result<String, String> {
    let txt = txt_path_for(&lora_path)?;
    let cleaned: Vec<String> = words
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let content = cleaned.join("、");
    std::fs::write(&txt, &content).map_err(|e| e.to_string())?;
    Ok(txt.to_string_lossy().into_owned())
}
