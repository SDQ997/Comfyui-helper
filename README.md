# ComfyUI Helper

轻量级 ComfyUI 桌面助手（Windows）。Tauri 2 构建，安装包 ~10MB，运行内存 ~40MB，为「与 ComfyUI 同时运行」而设计——不占显存，不抢资源。

![License](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)

## 功能

| 模块 | 说明 |
|---|---|
| ✦ 提示词助手 | OpenAI 兼容 API 润色提示词，直接填写需求即可生成；System Prompt 模板与 Skill 均为可选增强（可取消选择），Skill 始终置前；勾选「图片理解」的模型可上传图片（≤4 张，自动压缩）让 AI 分析；草稿跨页面保留，历史生成记录（系统 / 用户提示词 / 生成内容）自动快照、可展开复制 |
| ▦ 资产管理 | 多目录聚合扫描视频/图片/文本/音频，网格浏览、缩略图后台静默生成、模糊隐藏（工具栏一键全部隐藏 ⇄ 全部显示切换）、预览 |
| ✓ LoRA 管理 | 多目录扫描 .safetensors；触发词编辑即时写回同目录同名 .txt（顿号分隔）；删除进回收站（二次确认） |
| ⚙ 插件管理 | 扫描 custom_nodes 的 git 仓库，可视化 ahead/behind 状态，批量 fast-forward 更新，操作日志；删除进回收站（二次确认） |
| ◐ 视频分析 | 双视频对比：滑块对比模式 + 上下堆叠模式切换；播放/暂停/静音/时间轴联动控制，不自动播放 |
| ♥ 捐赠 | 收款码展示模块（深色衬底，深浅主题下都清晰；config.toml 可自定义替换为自己的二维码） |
| 🔧 设置 | 独立分区的 System Prompt 模板与 Skills 管理（折叠式列表）、深色/浅色主题切换（即时预览、持久化）、FFmpeg 引导、镜像源 |

## 特性

- **沉浸式无边框窗口**：自绘标题栏（拖拽移动、双击最大化、最小化/最大化/关闭三键），暗色科技风贯穿到底
- **深色 / 浅色主题**：设置中一键切换，浅色主题为全组件适配（非简单反色）
- **轻量**：Tauri 2 + 系统 WebView2，空载内存 ~40MB，零 GPU 占用
- **静默后台命令**：所有 ffmpeg/ffprobe/PowerShell 外部调用带 `CREATE_NO_WINDOW`，不再闪黑色控制台窗口
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

运行时日志写在 **exe 同目录 `logs\app.log`**（exe 目录不可写时回退 `%APPDATA%\ComfyUI-Helper\logs`），超过 5MB 自动轮转，保留 3 份。日志页内文字可框选后 Ctrl+C 复制。

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

## 更新日志

### v0.2.3（2026-09-03）

- **提示词历史**：提示词助手页面底部新增「⏱ 提示词历史」面板——每次成功生成自动快照「System Prompt / 用户提示词 / 生成内容」（含所用模型、温度、上传图片缩略图）；默认整体收拢，条目收拢时单行省略号摘要，点击展开后分段显示、每段均可单独复制，另有「载入到编辑器」与「复制全部」；历史存 localStorage（最多 50 条，重启应用不丢），支持一键清空
- **草稿跨页面保留**：提示词助手的用户输入、模板 / Skill 选择、手动 system prompt、温度、上传图片、生成结果全部迁入全局状态——切换页面再切回内容不再消失

### v0.2.2（2026-09-03）

- **模型图片理解能力**：设置 → 模型 API 中可为每个端点勾选「🖼 图片理解」；勾选后提示词助手出现图片上传区（点击选择或拖拽，最多 4 张，长边超 1280px 自动压缩为 JPEG），图片以 OpenAI 多模态格式（base64 data URL）随消息发送给 AI 分析
- **System Prompt / Skill 改为可选**：不选模板与 Skill 直接填写需求也能生成；选中的内容会作为 system prompt 叠加
- **设置页版式**：模型 API 端点改为独立卡片（编号 + 默认 + 图片理解在头部行），目录分组加分隔线与组间距

### v0.2.1（2026-09-02）

- **视频对比比例修复**：对比模式下两路视频比例不一致时错位——CSS 定位规则只写了 `img.frame` 未覆盖 `video.frame`，已修复；对比框宽高比跟随视频 A；新增「填充（裁切对齐无黑边）/ 适应（等比完整显示）」切换；比例不同时显示提示条
- **视频分析可随时重选视频**：去掉选择按钮的永久禁用，重选自动暂停并复位时间轴
- **删除按钮醒目化**：LoRA / 插件删除按钮常态红色描边，确认态实心红
- **标题栏精简**：移除捐赠按钮（入口保留在侧栏）
- **修复标题栏缺面包屑与窗口控制键**：重写样式时丢失 `display:flex` 导致子元素溢出被遮挡，已补回
- **构建弹窗消除**：固定 Git 凭据助手为 manager，构建时不再弹 CredentialHelperSelector 选择框

### v0.2（2026-09-02）

**界面与主题**
- 沉浸式无边框窗口：自绘标题栏（拖拽 / 双击最大化 / 最小化-最大化-关闭），`decorations:false`
- 深色 / 浅色主题切换（设置 → 通用），即时预览 + 持久化；CSS 硬编码颜色收敛为语义变量，浅色主题全组件适配

**提示词助手**
- System Prompt 模板再次点击可取消选择
- Skill 优先级修复：Skill 内容始终置于 System Prompt 最前，手动模式不再丢弃已选 Skill

**视频分析**
- 重构同步机制：不再自动播放，播放/暂停/静音/重置按钮一次点击同时作用于两路视频
- 新增堆叠模式（上下排列）与对比模式（滑块裁切）切换；时间轴拖动同步 seek

**资产管理**
- 「全部隐藏 ⇄ 全部显示」状态化按钮，点击后自动切换
- 缩略图后台静默生成：修复 Windows 下 ffmpeg/ffprobe 弹黑色控制台窗口的闪烁问题（`CREATE_NO_WINDOW`）

**其他**
- LoRA / 插件管理：删除进回收站（二次确认），操作按钮横向排布不换行
- 日志页：清空视图后不再被轮询拉回历史；文字可框选复制
- 捐赠页：收款码加深色衬底，深浅主题下都协调
- 全局按钮统一高度与垂直对齐

## License

[MIT](./LICENSE)
