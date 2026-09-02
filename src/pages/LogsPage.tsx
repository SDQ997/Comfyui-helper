import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, LogItem } from "../api";const LV: Record<string, string> = {
  INFO: "var(--c-cyan)",
  WARN: "var(--c-amber)",
  ERROR: "var(--c-red)",
  FATAL: "#ff6b6b",
  DEBUG: "var(--tx-3)",
};

export default function LogsPage() {
  const [items, setItems] = useState<LogItem[]>([]);
  const [lastId, setLastId] = useState(0);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [logDir, setLogDir] = useState("");
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getDataDir().then((d) => setLogDir(d + "\\logs\\app.log")).catch(() => {});
  }, []);

  const poll = useCallback(async () => {
    try {
      const got = await api.logFetch(lastId);
      if (got.length) {
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...got.filter((g) => !seen.has(g.id))].slice(-3000);
        });
        setLastId(got[got.length - 1].id);
      }
    } catch {
      /* IPC 暂不可用时忽略 */
    }
  }, [lastId]);

  useEffect(() => {
    if (paused) return;
    poll(); // 立即拉一次
    const t = setInterval(poll, 800);
    return () => clearInterval(t);
  }, [poll, paused]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter((i) => {
      if (level !== "all" && i.level !== level) return false;
      if (q && !(i.msg + " " + i.target).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filter, level]);

  // 自动滚动
  useEffect(() => {
    const el = boxRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [filtered.length, autoScroll]);

  const clearView = () => {
    setItems([]);
    setLastId(0);
  };

  const copyAll = async () => {
    const text = filtered
      .map((i) => `[${i.time}] [${i.level}] [${i.target}] ${i.msg}`)
      .join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-h">
        <div>
          <h1>日志</h1>
          <div className="desc">
            软件全部操作（后端命令、AI 请求、前端交互、错误）实时记录。文件位置：{logDir || "…"}
          </div>
        </div>
        <div className="right" style={{ gap: 8, display: "flex" }}>
          <div className="input" style={{ width: 180 }}>
            <span className="ico">🔍</span>
            <input placeholder="过滤内容…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <select className="sel" style={{ width: 96 }} value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">全部级别</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
          </select>
          <button className={`btn ${paused ? "btn-primary" : "btn-line"} btn-sm`} onClick={() => setPaused(!paused)}>
            {paused ? "▶ 继续" : "⏸ 暂停"}
          </button>
          <button className="btn btn-line btn-sm" onClick={copyAll}>
            {copied ? "✓ 已复制" : "📋 复制"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearView}>
            清空视图
          </button>
          <label
            className="btn btn-ghost btn-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          >
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
        </div>
      </div>

      <div
        className="card"
        style={{ flex: 1, display: "flex", minHeight: 0, padding: 0, overflow: "hidden", maxHeight: "calc(100vh - 200px)" }}
      >
        <div ref={boxRef} className="log-box">
          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 40 }}>
              <div className="big">☰</div>
              <div className="tip">暂无日志。操作任意功能后日志会实时出现在这里。</div>
            </div>
          )}
          {filtered.map((i) => (
            <div key={i.id} className={`log-line lv-${i.level.toLowerCase()}`}>
              <span className="t">{i.time.slice(11)}</span>
              <span className="lv" style={{ color: LV[i.level] ?? "var(--tx-2)" }}>
                {i.level}
              </span>
              <span className="tg">{i.target}</span>
              <span className="msg">{i.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
