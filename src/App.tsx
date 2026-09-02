import { useEffect } from "react";
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

  useEffect(() => {
    loadConfig().catch((e) => useStore.getState().toast(`加载配置失败: ${e}`, "err"));
  }, []);

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
      <aside className="sidebar">
        <div className="sb-brand">
          <div className="sb-logo" />
          <div className="sb-name">
            ComfyUI Helper<span className="ver">v0.1</span>
          </div>
        </div>
        <div className="sb-section">工作区</div>
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
        <div className="topbar">
          <div className="crumb">
            <span>工作区</span>
            <span className="sep">/</span>
            <b>{pageLabel}</b>
          </div>
          <div className="spacer" />
          <button className="tb-donate" onClick={() => setPage("donate")}>
            ♥ 捐赠
          </button>
        </div>
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
