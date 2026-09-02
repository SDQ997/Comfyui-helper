import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, LoraEntry, fmtSize } from "../api";

export default function LoraPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "loras");
  const [dirIdx, setDirIdx] = useState(0);
  const [entries, setEntries] = useState<LoraEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<LoraEntry | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [armDeletePath, setArmDeletePath] = useState("");

  const activeDir = dirs[dirIdx] ?? "";

  const rescan = useCallback(async () => {
    if (!activeDir) return;
    setLoading(true);
    try {
      setEntries(await api.scanLoras([activeDir]));
    } catch (e) {
      toast(`扫描失败: ${e}`, "err");
    } finally {
      setLoading(false);
    }
  }, [activeDir, toast]);

  useEffect(() => {
    rescan();
  }, [rescan]);

  // 把文本解析为触发词数组（顿号/逗号/分号/换行均可作分隔符，自动去重保序）
  const parseWords = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[、，,;；\n\r]+/)) {
      const s = raw.trim();
      if (s.length > 0 && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };

  const previewWords = useMemo(() => parseWords(editText), [editText]);

  const filtered = useMemo(() => {
    let list = entries;
    if (filter === "no-txt") list = list.filter((e) => !e.has_txt);
    if (filter === "has-words") list = list.filter((e) => e.trigger_words.length > 0);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) => e.name.toLowerCase().includes(q) || e.trigger_words.some((w) => w.toLowerCase().includes(q))
      );
    }
    return list;
  }, [entries, filter, search]);

  const addDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    const group = config?.directories.find((d) => d.kind === "loras");
    const paths = group ? group.paths : [];
    if (paths.includes(sel)) return;
    await updateConfig({
      directories: [
        ...(config?.directories.filter((d) => d.kind !== "loras") ?? []),
        { kind: "loras", paths: [...paths, sel] },
      ],
    });
  };

  const openEditor = async (e: LoraEntry) => {
    setEditing(e);
    try {
      const words = await api.readTriggerWords(e.path);
      setEditText(words.join("、"));
    } catch (err) {
      // 读不到时用扫描结果兜底
      setEditText(e.trigger_words.join("、"));
      void err;
    }
  };

  const saveWords = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const words = parseWords(editText);
      const txt = await api.writeTriggerWords(editing.path, words);
      toast(
        words.length
          ? `已保存 ${words.length} 个触发词 → ${txt.split(/[\\/]/).pop()}`
          : "已清空触发词（空文件）",
        "ok"
      );
      setEditing(null);
      await rescan();
    } catch (e) {
      toast(`写入失败: ${e}`, "err");
    } finally {
      setSaving(false);
    }
  };

  // 点击单个触发词 chip 即复制该词
  const copyOneWord = async (e: LoraEntry, w: string) => {
    void e;
    await navigator.clipboard.writeText(w);
    toast(`已复制「${w}」`, "ok");
  };

  // 行内快捷：删除一个词（常用于快速改错）
  const removeWordInline = async (e: LoraEntry, w: string) => {
    try {
      const next = e.trigger_words.filter((x) => x !== w);
      await api.writeTriggerWords(e.path, next);
      toast(`已删除「${w}」`, "ok");
      await rescan();
    } catch (err) {
      toast(`操作失败: ${err}`, "err");
    }
  };

  // 删除整个 LoRA（同名 .txt 一并进回收站）
  const deleteOne = async (e: LoraEntry) => {
    try {
      await api.deleteLora(e.path);
      toast(`已删除 ${e.name}（进回收站）`, "ok");
      await rescan();
    } catch (err) {
      toast(`删除失败: ${err}`, "err");
    }
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>
            LoRA 管理 <span className="tag cyan">{entries.length} 个</span>
          </h1>
          <div className="desc">
            扫描指定目录下的 .safetensors。触发词保存在同名 .txt 中（顿号/逗号分隔）；点「编辑」直接增删改，保存即写回文件。
          </div>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "↻ 重新扫描"}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="dir-chips">
          {dirs.length === 0 && <span className="hint">尚未配置 LoRA 目录</span>}
          {dirs.map((d, i) => (
            <span key={d} className={`dc ${i === dirIdx ? "active" : ""}`} onClick={() => setDirIdx(i)} title={d}>
              {d}
            </span>
          ))}
          <button className="dc add" onClick={addDir}>＋ 添加目录</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="input" style={{ flex: 1, maxWidth: 340 }}>
          <span className="ico">🔍</span>
          <input placeholder="搜索名称 / 触发词…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="tabs">
          <div className={`t ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
            全部 <span className="n">{entries.length}</span>
          </div>
          <div className={`t ${filter === "no-txt" ? "active" : ""}`} onClick={() => setFilter("no-txt")}>
            ⚠ 无 txt <span className="n">{entries.filter((e) => !e.has_txt).length}</span>
          </div>
          <div className={`t ${filter === "has-words" ? "active" : ""}`} onClick={() => setFilter("has-words")}>
            有触发词 <span className="n">{entries.filter((e) => e.trigger_words.length > 0).length}</span>
          </div>
        </div>
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">✓</div>
          <div className="tip">请先点击「＋ 添加目录」选择 LoRA 根目录。</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto", maxHeight: "calc(100vh - 250px)" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 48 }}></th>
                <th>名称</th>
                <th>触发词（点击词复制，× 删除）</th>
                <th style={{ width: 90 }}>大小</th>
                <th style={{ width: 170 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.path}>
                  <td>
                    <div
                      style={{
                        width: 34, height: 34, borderRadius: 6, background: "var(--bg-4)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "var(--tx-3)", fontSize: 13,
                      }}
                    >
                      ✦
                    </div>
                  </td>
                  <td>
                    <div className="name">{e.name}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--tx-4)" }}>{e.path}</div>
                  </td>
                  <td>
                    {e.trigger_words.length ? (
                      <div className="chip-row">
                        {e.trigger_words.map((w) => (
                          <span
                            key={w}
                            className="chip clickable"
                            title="点击复制该触发词"
                            onClick={() => copyOneWord(e, w)}
                          >
                            {w}
                            <button
                              className="chip-x"
                              title="删除该触发词"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                removeWordInline(e, w);
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="hint" style={{ fontSize: 11 }}>（无触发词，点右侧「编辑」添加）</span>
                    )}
                  </td>
                  <td className="mono">{fmtSize(e.size)}</td>
                  <td>
                    <div className="row-ops">
                      <button className="btn btn-line btn-sm" onClick={() => openEditor(e)}>编辑</button>
                      <button
                        className={`btn btn-sm btn-danger ${armDeletePath === e.path ? "armed" : "btn-danger-soft"}`}
                        onClick={() => {
                          if (armDeletePath !== e.path) {
                            setArmDeletePath(e.path);
                            setTimeout(() => {
                              setArmDeletePath((cur) => (cur === e.path ? "" : cur));
                            }, 3500);
                            return;
                          }
                          setArmDeletePath("");
                          void deleteOne(e);
                        }}
                        title="删除该 LoRA（同名 .txt 一并删除，进回收站）"
                      >
                        {armDeletePath === e.path ? "确认删除？" : "🗑"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="modal-mask" onClick={() => !saving && setEditing(null)}>
          <div className="modal" style={{ width: 620 }} onClick={(ev) => ev.stopPropagation()}>
            <h2>触发词 — {editing.name}</h2>
            <div className="hint" style={{ marginBottom: 6 }}>
              写入文件：<span className="mono">{editing.path.replace(/\.[^.]+$/, ".txt")}</span>
            </div>
            <div className="hint" style={{ marginBottom: 10 }}>
              支持顿号、逗号、换行分隔；下方实时预览。
            </div>
            <textarea
              className="txa mono"
              rows={4}
              placeholder={"输入触发词…\n例如：cat、orange fur、sleepy（可换行，可混用顿号/逗号）"}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              style={{ marginBottom: 10 }}
              autoFocus
            />
            <div className="chip-row" style={{ marginBottom: 12, minHeight: 30 }}>
              {previewWords.length === 0 && <span className="hint">还没有任何触发词</span>}
              {previewWords.map((w) => (
                <span key={w} className="chip">
                  {w}
                  <button
                    className="chip-x"
                    onClick={() =>
                      setEditText((t) =>
                        parseWords(t)
                          .filter((x) => x !== w)
                          .join("、")
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="m-ops">
              <span className="hint" style={{ marginRight: "auto" }}>
                共 {previewWords.length} 个
              </span>
              <button className="btn btn-line" onClick={() => setEditing(null)} disabled={saving}>
                取消
              </button>
              <button className="btn btn-primary" onClick={saveWords} disabled={saving}>
                {saving ? "保存中…" : "保存并写回 txt"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
