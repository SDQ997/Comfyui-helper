import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Md from "../components/Md";
import { api } from "../api";
import { useStore } from "../store";
import {
  ComfyError, RawLine, DEFAULT_BASE, DEFAULT_ANALYSIS_PROMPT,
  LS_PROMPT_KEY, loadErrors, saveErrors, extractLogErrors, buildAnalysisBody,
} from "../components/comfyErrors";

const LS_BASE_KEY = "comfyui_monitor_base";
const POLL_MS = 2500;

export default function ComfyMonitorPage() {
  const { config, toast } = useStore();
  const endpoints = config?.endpoints ?? [];
  const defaultEp = endpoints.find((e) => e.id === config?.default_endpoint_id) ?? endpoints[0];

  const [base, setBase] = useState(() => localStorage.getItem(LS_BASE_KEY) || DEFAULT_BASE);
  const [editingBase, setEditingBase] = useState(false);
  const [baseDraft, setBaseDraft] = useState(base);
  const [paused, setPaused] = useState(false);
  const [conn, setConn] = useState<"ok" | "fail" | "connecting">("connecting");
  const [errors, setErrors] = useState<ComfyError[]>(() => loadErrors());
  const [openId, setOpenId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState("");

  const lastLineKey = useRef<string | null>(null); // 上一轮日志末行标识（增量识别）
  const firstFetch = useRef(true);
  const rawRef = useRef<RawLine[]>([]);
  const errorsRef = useRef(errors);
  errorsRef.current = errors;

  const mergeErrors = useCallback((items: ComfyError[]) => {
    if (items.length === 0) return;
    setErrors((prev) => {
      const list = [...prev];
      for (const e of items) {
        const i = list.findIndex((x) => x.id === e.id);
        if (i >= 0) {
          const f = list[i];
          list[i] = { ...f, count: f.count + 1, last_seen: e.last_seen, context: e.context, traceback: e.traceback, node_inputs: e.node_inputs };
        } else {
          list.unshift(e);
        }
      }
      // 按"解析后的真实时间"倒序（历史错误带 UTC Z 后缀、日志错误是本地 naive 时间，
      // 不能用字典序比较，否则两类混排时会乱序）
      list.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
      const capped = list.slice(0, 200);
      saveErrors(capped);
      return capped;
    });
  }, []);

  const poll = useCallback(async () => {
    // 1) 控制台日志（增量错误识别）
    try {
      const raw = await api.comfyuiRawLogs(base);
      setConn("ok");
      rawRef.current = raw;
      const lastKey = lastLineKey.current;
      let start = 0;
      if (lastKey && !firstFetch.current) {
        let idx = -1;
        for (let i = raw.length - 1; i >= 0; i--) {
          if (raw[i].t + "|" + raw[i].m === lastKey) { idx = i; break; }
        }
        start = idx >= 0 ? idx + 1 : 0; // 找不到说明缓冲已大幅滚动，按全量处理
      }
      const found = extractLogErrors(raw, start);
      // 演进末行标识
      if (raw.length) lastLineKey.current = raw[raw.length - 1].t + "|" + raw[raw.length - 1].m;
      firstFetch.current = false;
      mergeErrors(found);
    } catch {
      setConn("fail");
    }
    // 2) history 结构化执行错误
    try {
      const hs = await api.comfyuiHistoryErrors(base);
      const existing = new Set(errorsRef.current.map((e) => e.id));
      const items: ComfyError[] = hs
        .filter((h) => !existing.has(h.prompt_id))
        .map((h) => ({
          id: h.prompt_id,
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          count: 1,
          kind: "exec" as const,
          summary: (h.exception_message || h.exception_type || h.node_type).split("\n")[0].slice(0, 140),
          node_type: h.node_type,
          node_id: h.node_id,
          exception_type: h.exception_type,
          exception_message: h.exception_message,
          traceback: h.traceback,
          context: [],
          node_inputs: h.node_inputs,
        }));
      mergeErrors(items);
    } catch { /* 连接状态由 raw 决定 */ }
  }, [base, mergeErrors]);

  useEffect(() => {
    if (paused) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(t);
  }, [paused, poll]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const byType = new Map<string, number>();
    for (const e of errors) {
      const k0 = e.kind === "exec" ? e.node_type || "执行错误" : e.exception_type || "日志错误";
      const k = k0.length > 22 ? k0.slice(0, 22) + "…" : k0;
      byType.set(k, (byType.get(k) ?? 0) + 1);
    }
    return {
      total: errors.length,
      today: errors.filter((e) => new Date(e.last_seen).toDateString() === today).length,
      top: [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [errors]);

  const analyze = async (e: ComfyError) => {
    if (!defaultEp) {
      toast("尚未配置 AI 模型 —— 请先到「设置 → AI 模型」添加端点", "err");
      return;
    }
    setAnalyzing(e.id);
    try {
      const sys = localStorage.getItem(LS_PROMPT_KEY) ?? DEFAULT_ANALYSIS_PROMPT;
      const res = await api.chatCompletion(
        defaultEp,
        [
          { role: "system", content: sys },
          { role: "user", content: buildAnalysisBody(e) },
        ],
        0.3
      );
      setErrors((prev) => {
        const list = prev.map((x) => (x.id === e.id ? { ...x, analysis: res, analyzed_at: new Date().toISOString() } : x));
        saveErrors(list);
        return list;
      });
      toast("分析完成", "ok");
    } catch (err) {
      toast(`AI 分析失败: ${err}`, "err");
    } finally {
      setAnalyzing("");
    }
  };

  const clearAll = () => {
    if (errors.length === 0) return;
    setErrors([]);
    saveErrors([]);
    toast("已清空报错记录", "ok");
  };

  const connNode =
    conn === "ok" ? (
      <span className="pill ok"><i className="d" />已连接 {paused ? "（监控已暂停）" : "（监控中）"}</span>
    ) : conn === "fail" ? (
      <span className="pill err"><i className="d" />无法连接 ComfyUI</span>
    ) : (
      <span className="pill"><i className="d" />连接中…</span>
    );

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>
            ComfyUI 监控 <span className="tag cyan">{stats.total} 条报错</span>
          </h1>
          <div className="desc">
            实时读取 ComfyUI 内部日志（/internal/logs/raw）与执行历史（/history），自动聚合报错块、提取出错节点参数；
            每条报错可一键交给 AI 分析（复用「AI 润色」配置的模型）。
          </div>
        </div>
        <div className="right">
          {connNode}
          <button
            className="btn btn-line btn-sm"
            onClick={() => {
              setBaseDraft(base);
              setEditingBase((s) => !s);
            }}
          >
            ⚙ 地址
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPaused((p) => !p)}>
            {paused ? "▶ 恢复监控" : "⏸ 暂停监控"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearAll}>🗑 清空记录</button>
        </div>
      </div>

      {editingBase && (
        <div className="hidden-bar" style={{ marginBottom: 10 }}>
          ComfyUI API 地址：
          <div className="input" style={{ width: 280 }}>
            <input
              value={baseDraft}
              onChange={(ev) => setBaseDraft(ev.target.value)}
              placeholder="http://127.0.0.1:8188"
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  const b = baseDraft.trim().replace(/\/+$/, "") || DEFAULT_BASE;
                  setBase(b);
                  localStorage.setItem(LS_BASE_KEY, b);
                  lastLineKey.current = null;
                  firstFetch.current = true;
                  setEditingBase(false);
                  setConn("connecting");
                }
              }}
              autoFocus
            />
          </div>
          <span style={{ color: "var(--tx-4)" }}>回车保存；ComfyUI 未启动或地址不对时无法监控</span>
        </div>
      )}

      <div className="toolbar">
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge">总计 {stats.total}</span>
          <span className="badge">今日 {stats.today}</span>
          {stats.top.map(([k, n]) => (
            <span key={k} className="badge c">{k} × {n}</span>
          ))}
        </div>
      </div>

      {errors.length === 0 ? (
        <div className="empty card">
          <div className="big">{conn === "fail" ? "✕" : "✓"}</div>
          <div className="tip">
            {conn === "fail"
              ? "无法连接 ComfyUI —— 请确认 ComfyUI 已启动，且 API 地址正确（默认 http://127.0.0.1:8188）"
              : "暂无报错 —— 监控运行中，ComfyUI 出错时会自动记录在这里"}
          </div>
        </div>
      ) : (
        <div className="flow-stack" style={{ overflow: "auto", maxHeight: "calc(100vh - 260px)", paddingBottom: 6 }}>
          {errors.map((e) => {
            const open = openId === e.id;
            return (
              <div key={e.id} className={`fc ${open ? "open" : ""}`}>
                <div className="fc-h" onClick={() => setOpenId(open ? null : e.id)}>
                  <span className="arrow">▸</span>
                  <span className="fico">{e.kind === "exec" ? "⚡" : "☰"}</span>
                  {(() => {
                    // 类型短名：取异常类名最后一段（torch.cuda.OutOfMemoryError → OutOfMemoryError）
                    const t = (e.exception_type || "").trim();
                    const short = t ? (t.split(".").pop() ?? t).slice(0, 18) : "";
                    return short ? <span className="badge t" title={t}>{short}</span> : null;
                  })()}
                  <div className="fr-main">
                    <div className="fr-name">{e.summary || e.exception_type || "未知错误"}</div>
                    <div className="fr-path">
                      {new Date(e.last_seen).toLocaleString()}
                      {e.kind === "exec" && ` · ${e.node_type}（节点 #${e.node_id}）`}
                      {e.count > 1 && ` · 已复现 ${e.count} 次`}
                    </div>
                  </div>
                  <div className="meta">
                    {e.analysis ? <span className="pill ok"><i className="d" />已分析</span> : null}
                  </div>
                </div>
                {open && (
                  <div className="fc-b" onClick={(ev) => ev.stopPropagation()}>
                    {e.kind === "exec" && e.node_inputs.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, color: "var(--tx-3)", fontWeight: 600 }}>出错节点输入参数</div>
                        <pre className="fr-json" style={{ maxHeight: 160 }}>
                          {e.node_inputs.map((i) => `${i.name}: ${i.value}`).join("\n")}
                        </pre>
                      </>
                    )}
                    {e.traceback.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, color: "var(--tx-3)", fontWeight: 600 }}>错误堆栈</div>
                        <pre className="fr-json">{e.traceback.join("\n")}</pre>
                      </>
                    )}
                    {e.context.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, color: "var(--tx-3)", fontWeight: 600 }}>报错前的日志上下文</div>
                        <pre className="fr-json" style={{ maxHeight: 160, color: "var(--tx-4)" }}>{e.context.join("\n")}</pre>
                      </>
                    )}
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void analyze(e)}
                        disabled={analyzing === e.id}
                        title={defaultEp ? `使用 ${defaultEp.name}（${defaultEp.model}）分析` : "未配置 AI 模型"}
                      >
                        {analyzing === e.id ? "🤖 分析中…" : e.analysis ? "🤖 重新分析" : "🤖 AI 分析"}
                      </button>
                      {e.analysis && (
                        <button
                          className="btn btn-line btn-sm"
                          onClick={() => {
                            void navigator.clipboard.writeText(e.analysis ?? "");
                            toast("已复制分析结果", "ok");
                          }}
                        >
                          ⧉ 复制结果
                        </button>
                      )}
                    </div>
                    {e.analysis && (
                      <div className="fr-json md-box" style={{ background: "var(--bg-2)", padding: "4px 12px", borderRadius: 8 }}>
                        <Md text={e.analysis} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
