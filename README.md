# ComfyUI Helper

轻量级 ComfyUI 桌面助手（Windows）。Tauri 2 构建，安装包 ~10MB，运行内存 ~40MB，为「与 ComfyUI 同时运行」而设计——不占显存，不抢资源。

![License](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)

## 功能

| 模块 | 说明 |
|---|---|
| ✦ 提示词助手 | OpenAI 兼容 API 润色提示词；System Prompt 模板 + Skill 可插拔，多选组合 |
| ▦ 资产管理 | 多目录聚合扫描视频/图片/文本/音频，网格浏览、隐藏模式、预览 |
| ✓ LoRA 管理 | 多目录扫描 .safetensors；触发词编辑即时写回同目录同名 .txt（顿号分隔） |
| ⚙ 插件管理 | 扫描 custom_nodes 的 git 仓库，可视化 ahead/behind 状态，批量 fast-forward 更新，操作日志 |
| ◐ 视频分析 | 双视频滑块对比（参考 pixop/video-compare），完整 ffprobe 元数据（分辨率/帧率/编码/码率/音频） |
| ♥ 捐赠 | 收款码展示模块（config.toml 可自定义替换为自己的二维码） |

## 特性

- **轻量**：Tauri 2 + 系统 WebView2，空载内存 ~40MB，零 GPU 占用
- **便携模式**：配置存储在 exe 同目录 `data/`（不可写时自动回退 %APPDATA%）
- **多目录**：资产 / LoRA / 插件目录均可配置多个（多个 ComfyUI 安装也能统一管理）
- **ffmpeg 引导安装**：首次使用视频分析时一键下载到应用数据目录，不污染系统 PATH
- **中文优先**：简体中文 UI

## 开发

```bash
# 前置：Node 18+、Rust (msvc)、WebView2（Win10/11 自带）
npm install
npm run tauri dev    # 开发模式
npm run tauri build  # 产出 NSIS 安装包
```

## 构建（Windows）

```bat
build-release.bat    :: 一键构建，产物输出到 release\
run-debug.bat        :: 调试启动（关 GPU + 开 WebView2 远程调试 9222）
run-debug.bat nogpu  :: 强制软件渲染
run-debug.bat gpudbg :: 保留 GPU
```

`build-release.bat` 会自动定位可用的 cargo（`~/.cargo/bin/cargo.exe` 若是 0 字节坏桩，会改用 `.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin`），依次执行 `npm install` → `vite build` → `tauri build`，最后把 exe 和 NSIS 安装包复制到 `release\`。

> 两个 `.bat` 均为 ASCII 编码，**不要**改成 UTF-8 带中文——CMD 按 GBK 解析会误判字符导致脚本闪退。

## 日志与排查

运行时日志写在 **exe 同目录 `logs\app.log`**（exe 目录不可写时回退 `%APPDATA%\ComfyUI-Helper\logs`），超过 5MB 自动轮转，保留 3 份。

| 来源 | 记录内容 |
|---|---|
| Rust 后端 | 启动信息、exe 路径、WebView2 参数、各 command 调用、panic 崩溃栈 |
| 前端 JS | `window.onerror`、未处理的 Promise 拒绝、`console.error` |
| React | 组件树渲染崩溃（ErrorBoundary 捕获，同时页面上直接显示错误） |

排查黑屏 / 无响应的流程：

1. 用 `run-debug.bat` 启动（自动关 GPU、开远程调试）
2. 浏览器打开 <http://localhost:9222> 看页面是否加载、控制台有无报错
3. 复现问题后关闭程序，把 `logs\app.log` 发出去

判读要点：日志里出现了「前端已启动」「window.load 完成」但界面仍黑 → 问题在渲染层（GPU / DWM）；这两行都没有 → 前端资源根本没加载起来。

## 技术栈

Tauri 2 · React 18 · TypeScript · Zustand · git2-rs · reqwest。详见 `src-tauri/Cargo.toml`。

## License

[MIT](./LICENSE)
