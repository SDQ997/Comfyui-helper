import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, LoraEntry, fmtSize } from "../api";
import FolderCardFlow from "../components/FolderCardFlow";
import { FlowFile, buildFlow, allFlowRels } from "../components/flow";
import { fetchAllDirs, mergeTreeDirs } from "../components/DirTree";
import MoveModal from "../components/MoveModal";
import NameModal from "../components/NameModal";

const joinPath = (root: string, rel: string) =>
  rel ? `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}` : root.replace(/[\\/]+$/, "");

export default function LoraPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "loras");
  const [dirIdx, setDirIdx] = useState(0);
  const [entries, setEntries] = useState<LoraEntry[]>([]);
  const [emptyDirs, setEmptyDirs] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

  const [editing, setEditing] = useState<LoraEntry | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [armDelFile, setArmDelFile] = useState("");
  const [armDelDir, setArmDelDir] = useState("");
  const [moving, setMoving] = useState<LoraEntry | null>(null);
  const [newFolderAt, setNewFolderAt] = useState<string | null>(null); // "" = 根

  const activeDir = dirs[dirIdx] ?? "";

  const rescan = useCallback(async () => {
    if (!activeDir) return;
    setLoading(true);
    try {
      const [list, allDirs] = await Promise.all([api.scanLoras([activeDir]), fetchAllDirs(activeDir)]);
      setEntries(list);
      setEmptyDirs(allDirs);
    } catch (e) {
      toast(`扫描失败: ${e}`, "err");
    } finally {
      setLoading(false);
    }
  }, [activeDir, toast]);

  useEffect(() => {
    rescan();
    setExpanded(new Set(["", "\u00abroot\u00bb"]));
  }, [rescan]);

  const root = useMemo(() => buildFlow(entries, emptyDirs, activeDir.split(/[\\/]/).pop() || ""), [entries, emptyDirs, activeDir]);
  const toFlow = (e: LoraEntry): FlowFile => ({ rel_dir: e.rel_dir, name: e.name, size: e.size });
  const findByKey = useCallback(
    (f: FlowFile) => entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name),
    [entries]
  );

  // 把文本解析为触发词数组（顿号/逗号/分号/换行均可，自动去重保序）
  const parseWords = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[、，,;；\n\r]+/)) {
      const s = raw.trim();
      if (s.length > 0 && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
  };
  const previewWords = useMemo(() => parseWords(editText), [editText]);

  // 搜索：全局拍平；否则整树卡片流（根展开即全部）
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return entries.filter((e) => e.name.toLowerCase().includes(q) || e.trigger_words.some((w) => w.toLowerCase().includes(q)));
  }, [entries, search]);

  const shown = useMemo(() => {
    let list = entries;
    if (filter === "no-txt") list = list.filter((e) => !e.has_txt);
    if (filter === "has-words") list = list.filter((e) => e.trigger_words.length > 0);
    return list;
  }, [entries, filter]);

  const rootShown = useMemo(
    () => buildFlow(shown, emptyDirs, activeDir.split(/[\\/]/).pop() || ""),
    [shown, emptyDirs, activeDir]
  );

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

  const pickAndAdd = async (rel: string) => {
    const dest = joinPath(activeDir, rel);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: true,
      filters: [{ name: "LoRA", extensions: ["safetensors", "pt", "pth", "ckpt"] }],
    });
    if (!Array.isArray(sel) || sel.length === 0) return;
    try {
      const n = await api.copyFilesIn(sel, dest);
      toast(`已添加 ${n} 个 LoRA 到 ${rel === "" ? "根目录" : rel}`, "ok");
      await rescan();
    } catch (e) {
      toast(`添加失败: ${e}`, "err");
    }
  };

  const addFolder = async (parentRel: string, name: string) => {
    try {
      await api.createSubdir(joinPath(activeDir, parentRel), name);
      toast(`已创建文件夹「${name}」`, "ok");
      setNewFolderAt(null);
      setExpanded((s) => new Set(s).add(parentRel));
      await rescan();
    } catch (e) {
      toast(`创建失败: ${e}`, "err");
    }
  };

  const deleteDir = async (rel: string) => {
    if (armDelDir !== rel) {
      setArmDelDir(rel);
      setTimeout(() => setArmDelDir((cur) => (cur === rel ? "" : cur)), 3500);
      return;
    }
    setArmDelDir("");
    try {
      await api.deleteAny(joinPath(activeDir, rel));
      toast(`已删除文件夹及内部全部内容（进回收站）`, "ok");
      await rescan();
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
    }
  };

  const deleteFile = async (f: FlowFile) => {
    const key = `${f.rel_dir}/${f.name}`;
    if (armDelFile !== key) {
      setArmDelFile(key);
      setTimeout(() => setArmDelFile((cur) => (cur === key ? "" : cur)), 3500);
      return;
    }
    setArmDelFile("");
    const src = findByKey(f);
    if (!src) return;
    try {
      await api.deleteLora(src.path);
      toast(`已删除 ${src.name}（同名 .txt 一并进回收站）`, "ok");
      await rescan();
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
    }
  };

  const moveFileTo = async (f: FlowFile, targetRel: string) => {
    if (targetRel === "\u00abroot\u00bb") targetRel = ""; // 根目录卡的哨兵 key
    const src = findByKey(f);
    if (!src || f.rel_dir === targetRel) return;
    try {
      await api.moveFile(src.path, joinPath(activeDir, targetRel));
      toast(`已移动 ${f.name} → ${targetRel === "" ? "根目录" : targetRel}`, "ok");
      setMoving(null);
      await rescan();
    } catch (e) {
      toast(`移动失败: ${e}`, "err");
    }
  };

  const openEditor = async (e: LoraEntry) => {
    setEditing(e);
    try {
      const words = await api.readTriggerWords(e.path);
      setEditText(words.join("、"));
    } catch {
      setEditText(e.trigger_words.join("、"));
    }
  };

  const saveWords = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const words = parseWords(editText);
      const txt = await api.writeTriggerWords(editing.path, words);
      toast(words.length ? `已保存 ${words.length} 个触发词 → ${txt.split(/[\\/]/).pop()}` : "已清空触发词（空文件）", "ok");
      setEditing(null);
      await rescan();
    } catch (e) {
      toast(`写入失败: ${e}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const copyOneWord = async (w: string) => {
    await navigator.clipboard.writeText(w);
    toast(`已复制「${w}」`, "ok");
  };

  const removeWordInline = async (e: LoraEntry, w: string) => {
    try {
      await api.writeTriggerWords(e.path, e.trigger_words.filter((x) => x !== w));
      toast(`已删除「${w}」`, "ok");
      await rescan();
    } catch (err) {
      toast(`操作失败: ${err}`, "err");
    }
  };

  const noTxtCount = entries.filter((e) => !e.has_txt).length;
  const hasWordsCount = entries.filter((e) => e.trigger_words.length > 0).length;

  const renderFileMain = (f: FlowFile) => {
    const src = findByKey(f);
    if (!src) return <div className="fr-name">{f.name}</div>;
    return (
      <>
        <div className="fr-name">{src.name}</div>
        {src.trigger_words.length ? (
          <div className="chip-row">
            {src.trigger_words.map((w) => (
              <span key={w} className="chip clickable" title="点击复制该触发词" onClick={() => void copyOneWord(w)}>
                {w}
                <button
                  className="chip-x"
                  title="删除该触发词"
                  onClick={(ev) => { ev.stopPropagation(); void removeWordInline(src, w); }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <div className="hint" style={{ fontSize: 11, marginTop: 3 }}>（无触发词，点悬停操作 ✎ 添加）</div>
        )}
      </>
    );
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>
            LoRA 管理 <span className="tag cyan">{entries.length} 个</span>
          </h1>
          <div className="desc">
            整页折叠卡片，与提示词历史同款操作：点文件夹展开再展开；悬停卡片头可添加文件 / 新建子文件夹 / 删除；文件行悬停可编辑触发词 / 移动 / 删除，也可直接拖到目标文件夹。
          </div>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "↻ 重新扫描"}
          </button>
          <button className="btn btn-line btn-sm" onClick={addDir}>＋ 添加目录</button>
          <button className="btn btn-primary btn-sm" onClick={() => pickAndAdd("")} disabled={!activeDir}>
            ＋ 添加 LoRA 到根目录
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
          <input placeholder="搜索名称 / 触发词（全局）…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="tabs">
          <div className={`t ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
            全部 <span className="n">{entries.length}</span>
          </div>
          <div className={`t ${filter === "no-txt" ? "active" : ""}`} onClick={() => setFilter("no-txt")}>
            ⚠ 无 txt <span className="n">{noTxtCount}</span>
          </div>
          <div className={`t ${filter === "has-words" ? "active" : ""}`} onClick={() => setFilter("has-words")}>
            有触发词 <span className="n">{hasWordsCount}</span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set(allFlowRels(root)))}>⊞ 展开全部</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set([""]))}>⊟ 收起全部</button>
          <button className="btn btn-line btn-sm" onClick={() => setNewFolderAt("")}>📁 新建根文件夹</button>
        </div>
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">✓</div>
          <div className="tip">请先点击「＋ 添加目录」选择 LoRA 根目录。</div>
        </div>
      ) : loading ? (
        <div className="empty card"><div className="big">…</div><div className="tip">扫描中…</div></div>
      ) : searchHits ? (
        <div className="flow-stack">
          <div className="hidden-bar">搜索「{search.trim()}」：命中 {searchHits.length} 个</div>
          {searchHits.map((e) => (
            <div key={e.path} className="fr">
              <span className="fico">📄</span>
              <div className="fr-main">
                <div className="fr-name">{e.name}</div>
                <div className="fr-path">{e.rel_dir || "根目录"}</div>
                {e.trigger_words.length > 0 && (
                  <div className="chip-row">
                    {e.trigger_words.map((w) => (
                      <span key={w} className="chip clickable" onClick={() => void copyOneWord(w)}>{w}</span>
                    ))}
                  </div>
                )}
              </div>
              <span className="sz">{fmtSize(e.size)}</span>
              <div className="h-ops">
                <span className="op" onClick={() => void openEditor(e)} title="编辑触发词">✎</span>
                <span className="op" onClick={() => setMoving(e)} title="移动">⇄</span>
              </div>
            </div>
          ))}
          {searchHits.length === 0 && <div className="empty card"><div className="big">🔍</div><div className="tip">无匹配结果</div></div>}
        </div>
      ) : (
        <div className="flow-stack">
          {rootShown.dirs.map((d) => (
            <FolderCardFlow
              key={d.rel}
              node={d}
              depth={0}
              expanded={expanded}
              toggle={(rel) => setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; })}
              renderFileMain={renderFileMain}
              fileOps={(f) => {
                const src = findByKey(f);
                return src ? <span className="op" title="编辑触发词（写回同名 .txt）" onClick={() => void openEditor(src)}>✎</span> : null;
              }}
              onMoveFile={(f) => { const src = findByKey(f); if (src) setMoving(src); }}
              onDeleteFile={deleteFile}
              armedFile={armDelFile}
              onAddFiles={(rel) => void pickAndAdd(rel)}
              onNewFolder={(rel) => setNewFolderAt(rel)}
              onDeleteDir={deleteDir}
              armedDir={armDelDir}
              onDropFile={(f, t) => void moveFileTo(f, t)}
            />
          ))}
          {/* 根目录直系文件 */}
          {rootShown.files.length > 0 && (
            <FolderCardFlow
              node={{ ...rootShown, name: "根目录", rel: "«root»", dirs: [], totalCount: rootShown.files.length }}
              depth={0}
              expanded={expanded}
              toggle={(rel) => setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; })}
              renderFileMain={renderFileMain}
              fileOps={(f) => {
                const src = findByKey(f);
                return src ? <span className="op" title="编辑触发词（写回同名 .txt）" onClick={() => void openEditor(src)}>✎</span> : null;
              }}
              onMoveFile={(f) => { const src = findByKey(f); if (src) setMoving(src); }}
              onDeleteFile={deleteFile}
              armedFile={armDelFile}
              onAddFiles={() => void pickAndAdd("")}
              onNewFolder={() => setNewFolderAt("")}
              onDropFile={(f, t) => void moveFileTo(f, t)}
            />
          )}
          {rootShown.dirs.length === 0 && rootShown.files.length === 0 && (
            <div className="empty card">
              <div className="big">✓</div>
              <div className="tip">暂无 LoRA —— 点「＋ 添加 LoRA 到根目录」，或展开文件夹在对应层级添加。</div>
            </div>
          )}
        </div>
      )}

      {moving && (
        <MoveModal
          fileName={moving.name}
          fromRel={moving.rel_dir}
          dirs={mergeTreeDirs(entries, emptyDirs, activeDir.split(/[\\/]/).pop() || "")}
          onConfirm={(targetRel) => void moveFileTo(toFlow(moving), targetRel)}
          onClose={() => setMoving(null)}
        />
      )}
      {newFolderAt !== null && (
        <NameModal
          title={`新建子文件夹 — ${newFolderAt === "" ? "根目录" : newFolderAt}`}
          placeholder="文件夹名称…"
          onConfirm={(name) => void addFolder(newFolderAt, name)}
          onClose={() => setNewFolderAt(null)}
        />
      )}
      {editing && (
        <div className="modal-mask" onClick={() => !saving && setEditing(null)}>
          <div className="modal" style={{ width: 620 }} onClick={(ev) => ev.stopPropagation()}>
            <h2>触发词 — {editing.name}</h2>
            <div className="hint" style={{ marginBottom: 6 }}>
              写入文件：<span className="mono">{editing.path.replace(/\.[^.]+$/, ".txt")}</span>
            </div>
            <div className="hint" style={{ marginBottom: 10 }}>支持顿号、逗号、换行分隔；下方实时预览。</div>
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
                    onClick={() => setEditText((t) => parseWords(t).filter((x) => x !== w).join("、"))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="m-ops">
              <span className="hint" style={{ marginRight: "auto" }}>共 {previewWords.length} 个</span>
              <button className="btn btn-line" onClick={() => setEditing(null)} disabled={saving}>取消</button>
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
