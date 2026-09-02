import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import PromptPage from "./pages/PromptPage";
import AssetsPage from "./pages/AssetsPage";
import LoraPage from "./pages/LoraPage";
import PluginsPage from "./pages/PluginsPage";
import VideoPage from "./pages/VideoPage";
import SettingsPage from "./pages/SettingsPage";
import LogsPage from "./pages/LogsPage";
import DonatePage from "./pages/DonatePage";

const NAV: { key: string; ico: string; label: string }[] = [
  { key: "prompt", ico: "✦", label: "提示词助手" },
  { key: "assets", ico: "▦", label: "资产管理" },
  { key: "lora", ico: "✓", label: "LoRA 管理" },
  { key: "plugins", ico: "⚙", label: "插件管理" },
  { key: "video", ico: "◐", label: "视频分析" },
  { key: "logs", ico: "☰", label: "日志" },
  { key: "settings", ico: "🔧", label: "设置" },
];

export default function App() {
  const { page, setPage, config, loadConfig, toasts, dismissToast } = useStore();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    loadConfig().catch((e) => useStore.getState().toast(`加载配置失败: ${e}`, "err"));
  }, []);

  // 主题切换：根据 config.general.theme 在 <html> 挂 data-theme
  useEffect(() => {
    const theme = config?.general?.theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    // 同步 index.html 防白屏底色（首帧一致）
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#eef1f6" : "#12151c");
  }, [config?.general?.theme]);

  // 标题栏最大化状态监听
  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      try {
        setMaximized(await win.isMaximized());
        const un = await win.onResized(() => {
          win.isMaximized().then(setMaximized).catch(() => {});
        });
        unlisteners.push(un);
        const un2 = await win.onMoved(() => {
          win.isMaximized().then(setMaximized).catch(() => {});
        });
        unlisteners.push(un2);
      } catch {
        /* 非 tauri 环境忽略 */
      }
    });
    return () => unlisteners.forEach((u) => u());
  }, []);

  // 窗口控制
  const winMin = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }, []);
  const winToggleMax = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  }, []);
  const winClose = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  }, []);

  // 双击最大化由 Tauri 内置 drag-region 行为处理（mousedown detail===2 自动 toggleMaximize），
  // React 侧不要再挂 onDoubleClick，否则会 toggle 两次相互抵消。

  if (!config) {
    return (
      <div className="empty" style={{ height: "100%" }}>
        <div className="big">◈</div>
        <div className="tip">正在加载配置…</div>
      </div>
    );
  }

  const pageLabel = [...NAV.map((n) => ({ key: n.key, label: n.label })), { key: "donate", label: "捐赠" }].find(
    (n) => n.key === page
  )?.label ?? "";

  return (
    <div className="app-shell">
      {/* 自定义标题栏（全宽、可拖拽、双击最大化） */}
      <div className="topbar titlebar" data-tauri-drag-region>
        <div className="tb-brand" data-tauri-drag-region>
          <span className="tb-logo">◈</span>
          <span className="tb-title" data-tauri-drag-region>
            ComfyUI Helper
          </span>
        </div>
        <div className="tb-divider" />
        <div className="crumb" data-tauri-drag-region>
          <span>工作区</span>
          <span className="sep">/</span>
          <b>{pageLabel}</b>
        </div>
        <div className="spacer" data-tauri-drag-region />
        <button className="tb-donate" onClick={() => setPage("donate")}>
          ♥ 捐赠
        </button>
        <div className="win-ctrl">
          <button className="wc" title="最小化" onClick={winMin}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
            </svg>
          </button>
          <button className="wc" title={maximized ? "还原" : "最大化"} onClick={winToggleMax}>
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="1.5" y="3.5" width="5.5" height="5.5" fill="none" stroke="currentColor" />
                <path d="M3.5 3.5 V2.5 H8.5 V7.5 H7.5" fill="none" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" />
              </svg>
            )}
          </button>
          <button className="wc wc-close" title="关闭" onClick={winClose}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </button>
        </div>
      </div>

      <aside className="sidebar">
        <div className="sb-mini" data-tauri-drag-region>
          <span className="sb-mini-logo" />
          <span className="sb-mini-txt">工作空间</span>
        </div>
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`nav-item ${page === n.key ? "active" : ""}`}
            onClick={() => setPage(n.key)}
          >
            <span className="ico">{n.ico}</span>
            {n.label}
          </div>
        ))}
        <div className={`nav-item donate ${page === "donate" ? "active" : ""}`} onClick={() => setPage("donate")}>
          <span className="ico">♥</span>捐赠
        </div>
        <div className="sb-foot">
          <span className="ok">● 就绪</span>
          <span>v0.1.0</span>
        </div>
      </aside>

      <main className="main">
        <div className="content">
          {page === "prompt" && <PromptPage />}
          {page === "assets" && <AssetsPage />}
          {page === "lora" && <LoraPage />}
          {page === "plugins" && <PluginsPage />}
          {page === "video" && <VideoPage />}
          {page === "logs" && <LogsPage />}
          {page === "settings" && <SettingsPage />}
          {page === "donate" && <DonatePage />}
        </div>
      </main>

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
