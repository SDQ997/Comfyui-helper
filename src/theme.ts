/** 应用主题到 <html data-theme> 并同步窗口底色 meta（App 启动 / 设置预览 / 离开设置恢复 共用） */
export function applyTheme(theme: string | undefined | null) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  // 同步 index.html 防白屏底色（首帧一致）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#eef1f6" : "#12151c");
}
