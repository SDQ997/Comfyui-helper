//! 视频分析：ffprobe 元数据 + ffmpeg 抽帧（供滑块对比）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMeta {
    pub path: String,
    pub container: String,
    pub duration_secs: f64,
    pub size: u64,
    pub bitrate: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub pix_fmt: String,
    pub audio_codec: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channels: Option<u32>,
    pub frame_count: Option<u64>,
    pub raw: Value,
}

fn ffprobe_path() -> Result<std::path::PathBuf, String> {
    let (pair, _) = crate::ffmpeg::find_ffmpeg();
    pair.map(|(_, fp)| fp).ok_or_else(|| "ffmpeg 未安装，请在设置中下载".into())
}

#[tauri::command]
pub async fn video_metadata(path: String) -> Result<VideoMeta, String> {
    let probe = ffprobe_path()?;
    let output = tokio::process::Command::new(&probe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let json: Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    let format = &json["format"];
    let mut meta = VideoMeta {
        path: path.clone(),
        container: format["format_name"]
            .as_str()
            .unwrap_or("unknown")
            .into(),
        duration_secs: format["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        size: format["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        bitrate: format["bit_rate"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        width: 0,
        height: 0,
        fps: 0.0,
        codec: String::new(),
        pix_fmt: String::new(),
        audio_codec: None,
        audio_sample_rate: None,
        audio_channels: None,
        frame_count: None,
        raw: json.clone(),
    };

    if let Some(streams) = json["streams"].as_array() {
        for s in streams {
            match s["codec_type"].as_str() {
                Some("video") if meta.codec.is_empty() => {
                    meta.width = s["width"].as_u64().unwrap_or(0) as u32;
                    meta.height = s["height"].as_u64().unwrap_or(0) as u32;
                    meta.codec = s["codec_name"].as_str().unwrap_or("").into();
                    meta.pix_fmt = s["pix_fmt"].as_str().unwrap_or("").into();
                    // r_frame_rate 形如 "24/1"
                    if let Some(rate) = s["r_frame_rate"].as_str() {
                        let parts: Vec<&str> = rate.split('/').collect();
                        if parts.len() == 2 {
                            if let (Ok(a), Ok(b)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                                if b > 0.0 {
                                    meta.fps = a / b;
                                }
                            }
                        }
                    }
                    meta.frame_count = s["nb_frames"].as_str().and_then(|s| s.parse().ok());
                }
                Some("audio") if meta.audio_codec.is_none() => {
                    meta.audio_codec = s["codec_name"].as_str().map(|s| s.into());
                    meta.audio_sample_rate =
                        s["sample_rate"].as_str().and_then(|s| s.parse().ok());
                    meta.audio_channels = s["channels"].as_u64().map(|v| v as u32);
                }
                _ => {}
            }
        }
    }
    Ok(meta)
}

/// 抽帧：在指定时间点抽取两张 PNG 供对比（对比模式），或等间隔抽 N 帧（浏览模式）。
#[tauri::command]
pub async fn extract_frames(
    path: String,
    timestamps: Vec<f64>,
    out_dir: String,
) -> Result<Vec<String>, String> {
    let (pair, _) = crate::ffmpeg::find_ffmpeg();
    let ffmpeg = pair
        .map(|(ff, _)| ff)
        .ok_or_else(|| "ffmpeg 未安装，请在设置中下载".to_string())?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut outs = Vec::new();
    for (i, ts) in timestamps.iter().enumerate() {
        let out_path = std::path::Path::new(&out_dir).join(format!("frame_{:05}.png", i));
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-ss",
                &format!("{:.3}", ts),
                "-i",
                &path,
                "-frames:v",
                "1",
                "-q:v",
                "2",
            ])
            .arg(&out_path)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if status.status.success() && out_path.exists() {
            outs.push(out_path.to_string_lossy().into_owned());
        }
    }
    Ok(outs)
}
