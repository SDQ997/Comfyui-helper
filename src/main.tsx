import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installErrorReporting, reportFatal } from "./error-report";
import "./styles.css";

// 错误上报必须最先安装，之后任何加载/渲染错误都能落到 logs/app.log
installErrorReporting();

// React 渲染崩溃兜底：不让整棵树白屏，错误详情上报日志
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    reportFatal(`React 渲染崩溃: ${err.message}`, info.componentStack ?? err.stack);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 40, color: "#f87171", fontFamily: "monospace" }}>
          <h2>界面渲染出错</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.err.stack || this.state.err.message)}</pre>
          <p style={{ color: "#9aa3b2" }}>详情见 exe 同目录 logs/app.log</p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
