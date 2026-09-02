// 前端错误上报：JS 错误 / Promise 拒绝 / React 崩溃边界 → Rust 文件日志。
// 黑屏排查的关键链路：前端任何异常都会落在 exe 同目录 logs/app.log。

import { invoke } from "@tauri-apps/api/core";

function report(level: string, message: string, stack?: string) {
  try {
    invoke("frontend_log", { level, message, stack: stack ?? null }).catch(() => {});
  } catch {
    // ignore
  }
}

function reportFatal(message: string, stack?: string) {
  try {
    invoke("frontend_panic", { message, stack: stack ?? null }).catch(() => {});
  } catch {
    // ignore
  }
}

export function installErrorReporting() {
  // 1. window.onerror —— 同步 JS 错误、资源加载失败
  window.addEventListener("error", (e) => {
    const msg = e.message || `资源加载失败: ${e.filename || "?"}`;
    // script / css 加载失败直接按 FATAL 处理（黑屏最常见原因）
    if (!e.message && e.filename) {
      reportFatal(`资源加载失败: ${e.filename}`, `(line ${e.lineno}, col ${e.colno})`);
    } else {
      reportFatal(`JS 错误: ${msg}`, e.error?.stack);
    }
  });

  // 2. unhandledrejection —— 异步 Promise 错误
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    report(
      "error",
      `未处理的 Promise 拒绝: ${reason?.message ?? String(reason)}`,
      reason?.stack
    );
  });

  // 3. console.error 劫持 —— React 渲染错误等走 console.error 的也落到文件
  const origError = console.error.bind(console);
  console.error = (...args) => {
    const msg = args
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))
      .join(" ");
    report("error", `console.error: ${msg}`);
    origError(...args);
  };

  // 4. 上报「前端已就绪」给看门狗：这是判定启动成功的关键信号
  try {
    invoke("frontend_ready").catch(() => {});
  } catch {
    // ignore
  }
  report("info", `前端已启动 UA=${navigator.userAgent}`);
  window.addEventListener("DOMContentLoaded", () =>
    report("info", "DOM ready")
  );
  window.addEventListener("load", () => report("info", "window.load 完成"));
}

export { reportFatal };
