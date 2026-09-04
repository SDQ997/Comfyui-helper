mod config;
mod ffmpeg;
mod gitops;
mod lora;
mod logging;
mod media;
mod prompt;
mod scan;
mod video;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub struct AppState {
    pub config: Mutex<config::AppConfig>,
    pub cancel_flags: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ===== 日志初始化：exe 同目录 /logs/app.log =====
    // 必须最先初始化，之后的所有阶段（webview 创建、前端加载）都有日志可查。
    let log_dir = match logging::init_file_logger() {
        Ok(d) => Some(d),
        Err(e) => {
            eprintln!("[comfyui-helper] 文件日志初始化失败: {e}");
            None
        }
    };
    logging::install_rust_logger();
    log::info!("==================== 应用启动 ====================");
    log::info!("版本: {} ({})", env!("CARGO_PKG_VERSION"), env!("CARGO_PKG_NAME"));
    if let Some(d) = &log_dir {
        log::info!("日志目录: {}", d.display());
    }
    log::info!(
        "exe 路径: {}",
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
    );
    log::info!(
        "WebView2 附加参数: {}",
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_else(|_| "(未设置)".into())
    );

    // WebView2 GPU 兼容性修复：部分新驱动 / WebView2 版本组合下硬件加速会导致
    // 渲染进程挂起（黑屏 / 无响应）。通过环境变量关闭硬件加速。
    // 用户可用 CH_WEBVIEW_GPU=1 强制开启 GPU；外部已设置的参数会被保留（追加）。
    if std::env::var("CH_WEBVIEW_GPU").as_deref() != Ok("1") {
        let extra = "--disable-gpu --disable-gpu-compositing";
        let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(prev) => format!("{} {}", prev, extra),
            Err(_) => extra.into(),
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        log::info!("已注入 --disable-gpu（可用 CH_WEBVIEW_GPU=1 关闭此行为）");
    }

    // 启动看门狗：20 秒后若前端未上报启动，自动记录环境诊断（黑屏自证）
    logging::spawn_startup_watchdog(20);

    // 拆开 build / run，便于定位卡点：
    //   若日志出现「应用构建完成」后卡住 → 卡在事件循环
    //   若没出现 → 卡在窗口 / webview 创建阶段
    log::info!("开始构建 Tauri 应用（此步会创建窗口与 webview）...");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            config: Mutex::new(config::AppConfig::load_or_default()),
            cancel_flags: Mutex::new(std::collections::HashMap::new()),
        })
        .setup(|app| {
            log::info!("Tauri setup 开始");

            // panic hook：把 Rust 侧崩溃写入日志（panic = "abort" 时 abort 前仍会执行）
            std::panic::set_hook(Box::new(move |info| {
                log::error!("RUST PANIC: {info}");
            }));

            // 窗口信息记录：黑屏排查需要知道窗口是否真的创建出来了
            if let Some(win) = app.get_webview_window("main") {
                log::info!(
                    "主窗口已创建: title={:?} size={:?} visible={:?}",
                    win.title().ok(),
                    win.inner_size().ok(),
                    win.is_visible().ok()
                );
            } else {
                log::warn!("未找到 label=main 的主窗口");
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            log::info!("Tauri setup 完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // logging（前端错误上报 + 日志页读取 + 操作埋点）
            logging::frontend_log,
            logging::frontend_panic,
            logging::frontend_ready,
            logging::log_fetch,
            logging::log_emit,
            // config
            config::get_config,
            config::save_config,
            config::get_data_dir,
            config::read_text_file,
            config::write_text_file,
            // scanning
            scan::scan_assets,
            scan::scan_loras,
            scan::scan_plugins,
            scan::list_directory_tree,
            // lora trigger words
            lora::read_trigger_words,
            lora::write_trigger_words,
            // ffmpeg
            ffmpeg::ffmpeg_status,
            ffmpeg::download_ffmpeg,
            ffmpeg::cancel_download,
            // video
            video::video_metadata,
            video::extract_frames,
            // media: 隐藏资产 + 视频缩略图
            media::hidden_list,
            media::hidden_add,
            media::hidden_remove,
            media::hidden_add_many,
            media::hidden_remove_many,
            media::video_thumbnail,
            media::delete_asset,
            media::delete_lora,
            media::delete_plugin,
            // prompt assistant
            prompt::list_models,
            prompt::chat_completion,
            // git / plugins
            gitops::plugin_check,
            gitops::plugin_update,
            gitops::plugin_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    log::info!("应用构建完成，进入事件循环（RunEvent::Ready）");
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Ready = event {
            log::info!("RunEvent::Ready —— 事件循环已就绪");
        }
    });
}
