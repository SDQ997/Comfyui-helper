import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, FileEntry, DirInfo } from "../api";
import FolderCardFlow from "../components/FolderCardFlow";
import { FlowFile, buildFlow, allFlowRels, FlowNode, prefixFlow } from "../components/flow";
import { fetchAllDirs, mergeTreeDirs } from "../components/DirTree";
import MoveModal from "../components/MoveModal";
import NameModal from "../components/NameModal";

const MODEL_EXTS = ["safetensors", "ckpt", "pt", "pth", "bin", "sft", "gguf", "onnx"];

const joinPath = (root: string, rel: string) =>
  rel ? `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}` : root.replace(/[\\/]+$/, "");

const LS_KEY = "comfyui_helper_model_hidden_cats_v1";

interface CatData {
  entries: FileEntry[];
  emptyDirs: string[];
}

export default function ModelsPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "models");
  const [dirIdx, setDirIdx] = useState(0);
  const [cats, setCats] = useState<DirInfo[]>([]);
  const [hiddenCats, setHiddenCats] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [catData, setCatData] = useState<Record<string, CatData>>({});
  const scannedRef = useRef<Set<string>>(new Set()); // 已扫描/扫描中的分类（跨渲染防重入）
  const [scanning, setScanning] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [refs, setRefs] = useState<string[]>([]);

  const [armDelFile, setArmDelFile] = useState("");
  const [armDelDir, setArmDelDir] = useState("");
  const [moving, setMoving] = useState<{ cat: string; f: FileEntry } | null>(null);
  const [newSubAt, setNewSubAt] = useState<string | null>(null);   // 分类内新建子文件夹（"cat" 或 "cat/rel"）
  const [newCat, setNewCat] = useState(false);

  const activeDir = dirs[dirIdx] ?? "";

  useEffect(() => {
    if (!activeDir) return;
    try {
      const all = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
      setHiddenCats(all[activeDir] ?? []);
    } catch {
      setHiddenCats([]);
    }
    setCatData({});
    setExpanded(new Set());
    scannedRef.current.clear();
    setScanning(new Set());
  }, [activeDir]);

  const persistHidden = (root: string, list: string[]) => {
    try {
      const all = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
      all[root] = list;
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch { /* 忽略 */ }
  };

  const loadCats = useCallback(async () => {
    if (!activeDir) return;
    try {
      setCats(await api.listSubdirs(activeDir));
    } catch (e) {
      toast(`读取分类失败: ${e}`, "err");
    }
  }, [activeDir, toast]);

  useEffect(() => { loadCats(); }, [loadCats]);

  // 分类懒加载：首次展开时扫描；force=true 强制重扫（增删改后刷新）
  const scanCat = useCallback(async (cat: string, force = false) => {
    if (!force && scannedRef.current.has(cat)) return;
    scannedRef.current.add(cat);
    setScanning((s) => new Set(s).add(cat));
    setCatData((m) => (m[cat] ? m : { ...m, [cat]: { entries: [], emptyDirs: [""] } }));
    try {
      const [list, allDirs] = await Promise.all([
        api.scanFiles([joinPath(activeDir, cat)], MODEL_EXTS),
        fetchAllDirs(joinPath(activeDir, cat)),
      ]);
      setCatData((m) => ({ ...m, [cat]: { entries: list, emptyDirs: allDirs } }));
    } catch (e) {
      scannedRef.current.delete(cat); // 失败允许重试
      toast(`扫描失败: ${e}`, "err");
    } finally {
      setScanning((s) => { const n = new Set(s); n.delete(cat); return n; });
    }
  }, [activeDir, toast]);

  const toggleCat = (cat: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(cat)) n.delete(cat);
      else { n.add(cat); void scanCat(cat); }
      return n;
    });
  };

  // 工作流引用
  const loadRefs = useCallback(async () => {
    const wfDirs = dirsOf(config, "workflows");
    if (!wfDirs.length) return;
    try {
      const wfs = await api.scanFiles(wfDirs, ["json"]);
      setRefs(await api.extractModelRefs(wfs.map((w) => w.path)));
    } catch { /* 联动失败不影响主功能 */ }
  }, [config]);

  useEffect(() => { loadRefs(); }, [loadRefs]);

  const visibleCats = useMemo(() => cats.filter((c) => !hiddenCats.includes(c.name)), [cats, hiddenCats]);
  const isUsed = useCallback((f: FileEntry) => {
    const n = f.name.toLowerCase();
    return refs.some((r) => {
      const rl = r.toLowerCase().replace(/\\/g, "/");
      return rl.endsWith("/" + n) || rl === n;
    });
  }, [refs]);

  const addDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    const group = config?.directories.find((d) => d.kind === "models");
    const paths = group ? group.paths : [];
    if (paths.includes(sel)) return;
    await updateConfig({
      directories: [
        ...(config?.directories.filter((d) => d.kind !== "models") ?? []),
        { kind: "models", paths: [...paths, sel] },
      ],
    });
  };

  const addCategory = async (name: string) => {
    try {
      await api.createSubdir(activeDir, name);
      toast(`已创建分类「${name}」`, "ok");
      setNewCat(false);
      await loadCats();
    } catch (e) {
      toast(`创建失败: ${e}`, "err");
    }
  };

  const addSubFolder = async (cat: string, rel: string, name: string) => {
    try {
      await api.createSubdir(joinPath(joinPath(activeDir, cat), rel), name);
      toast(`已创建文件夹「${name}」`, "ok");
      setNewSubAt(null);
      await scanCat(cat, true);
    } catch (e) {
      toast(`创建失败: ${e}`, "err");
    }
  };

  const pickAndAdd = async (cat: string, rel: string) => {
    const dest = joinPath(joinPath(activeDir, cat), rel);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, filters: [{ name: "Model", extensions: MODEL_EXTS }] });
    if (!Array.isArray(sel) || sel.length === 0) return;
    try {
      const n = await api.copyFilesIn(sel, dest);
      toast(`已添加 ${n} 个模型文件`, "ok");
      await scanCat(cat, true);
    } catch (e) {
      toast(`添加失败: ${e}`, "err");
    }
  };

  const deleteDir = async (cat: string, rel: string) => {
    const full = rel === "" ? cat : `${cat}/${rel}`;
    const key = rel === "" ? cat : rel; // 卡片标识
    if (armDelDir !== key) {
      setArmDelDir(key);
      setTimeout(() => setArmDelDir((cur) => (cur === key ? "" : cur)), 3500);
      return;
    }
    setArmDelDir("");
    try {
      await api.deleteAny(joinPath(activeDir, full));
      toast(`已删除文件夹及内部全部内容（进回收站）`, "ok");
      if (rel === "") {
        // 删除的是整个分类
        setCatData((m) => { const n = { ...m }; delete n[cat]; return n; });
        scannedRef.current.delete(cat);
        await loadCats();
      } else {
        await scanCat(cat, true);
      }
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
    }
  };

  const deleteFile = async (cat: string, f: FlowFile) => {
    const key = `${cat}/${f.rel_dir}/${f.name}`;
    if (armDelFile !== key) {
      setArmDelFile(key);
      setTimeout(() => setArmDelFile((cur) => (cur === key ? "" : cur)), 3500);
      return;
    }
    setArmDelFile("");
    const data = catData[cat];
    const src = data?.entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name);
    if (!src) return;
    try {
      await api.deleteAny(src.path);
      toast(`已删除 ${src.name}（进回收站）`, "ok");
      await scanCat(cat, true);
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
    }
  };

  const moveFileTo = async (srcCat: string, f: FlowFile, destCat: string, targetRel: string) => {
    const data = catData[srcCat];
    const src = data?.entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name);
    if (!src) return;
    if (srcCat === destCat && f.rel_dir === targetRel) return;
    try {
      await api.moveFile(src.path, joinPath(joinPath(activeDir, destCat), targetRel));
      toast(`已移动 ${f.name} → ${destCat}${targetRel ? `/${targetRel}` : " 根目录"}`, "ok");
      setMoving(null);
      await scanCat(srcCat, true);
      if (destCat !== srcCat) await scanCat(destCat, true);
    } catch (e) {
      toast(`移动失败: ${e}`, "err");
    }
  };

  const hideCat = (name: string) => {
    const next = [...hiddenCats, name];
    setHiddenCats(next);
    persistHidden(activeDir, next);
  };

  const restoreCat = (name: string) => {
    const next = hiddenCats.filter((x) => x !== name);
    setHiddenCats(next);
    persistHidden(activeDir, next);
  };

  // 搜索：跨已扫描分类拍平
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const out: { cat: string; e: FileEntry }[] = [];
    for (const [cat, data] of Object.entries(catData)) {
      for (const e of data.entries) {
        if (e.name.toLowerCase().includes(q)) out.push({ cat, e });
      }
    }
    return out;
  }, [catData, search]);

  const unusedTotal = (cat: string) => {
    const data = catData[cat];
    if (!data || !refs.length) return 0;
    return data.entries.filter((f) => !isUsed(f)).length;
  };

  const catFlow = (cat: string): FlowNode =>
    prefixFlow(buildFlow(catData[cat]?.entries ?? [], catData[cat]?.emptyDirs ?? [""], cat), cat);

  /** 分类内子卡片的 rel 是 "cat/rel"，换算成分类内相对路径 */
  const relIn = (cat: string, rel: string) => (rel === cat ? "" : rel.slice(cat.length + 1));

  const renderFileMain = (cat: string) => (f: FlowFile) => {
    const data = catData[cat];
    const src = data?.entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name);
    const used = src ? isUsed(src) : false;
    return (
      <>
        <div className="fr-name">{f.name}</div>
        {search.trim() && <div className="fr-path">{`${cat}/${f.rel_dir || ""}`}</div>}
        {refs.length > 0 && (
          <span className={`pill ${used ? "ok" : "warn"}`}>
            <i className="d" />
            {used ? "已引用" : "未引用"}
          </span>
        )}
      </>
    );
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>
            模型管理 <span className="tag cyan">{`${visibleCats.length} 个分类`}</span>
          </h1>
          <div className="desc">
            models 根目录的一级子目录自动为分类：点分类卡片展开（首次展开自动扫描）；悬停可添加 / 新建子文件夹 / 隐藏 / 删除；页脚统计各分类未引用数量。
            {refs.length > 0 && ` 已分析 ${refs.length} 个模型引用（来自工作流）。`}
          </div>
        </div>
        <div className="right">
          <button
            className="btn btn-ghost btn-sm"
            disabled={!activeDir}
            onClick={async () => {
              setLoading(true);
              setCatData({});
              scannedRef.current.clear();
              for (const c of visibleCats) await scanCat(c.name);
              setLoading(false);
            }}
          >
            {loading ? "扫描中…" : "↻ 重新扫描全部"}
          </button>
          <button className="btn btn-line btn-sm" onClick={addDir}>＋ 添加目录</button>
          <button className="btn btn-primary btn-sm" onClick={() => setNewCat(true)} disabled={!activeDir}>＋ 新建分类</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="dir-chips">
          {dirs.length === 0 && <span className="hint">尚未配置 models 根目录</span>}
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
          <input placeholder="搜索模型名称（已扫描分类内全局）…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const n = new Set(expanded);
              visibleCats.forEach((c) => {
                if (!scannedRef.current.has(c.name)) void scanCat(c.name);
                allFlowRels(catFlow(c.name)).forEach((r) => n.add(r));
              });
              setExpanded(n);
            }}
          >⊞ 展开全部</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>⊟ 收起全部</button>
        </div>
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">◎</div>
          <div className="tip">请先点击「＋ 添加目录」选择 ComfyUI 的 models 根目录。</div>
        </div>
      ) : searchHits ? (
        <div className="flow-stack">
          <div className="hidden-bar">搜索「{search.trim()}」：命中 {searchHits.length} 个（仅已扫描分类）</div>
          {searchHits
            .map(({ cat, e }) => (
            <div key={`${cat}/${e.path}`} className="fr">
              <span className="fico">📄</span>
              <div className="fr-main">
                <div className="fr-name">{e.name}</div>
                <div className="fr-path">{`${cat}/${e.rel_dir || ""}`}</div>
              </div>
              <span className={`pill ${isUsed(e) ? "ok" : "warn"}`}><i className="d" />{isUsed(e) ? "已引用" : "未引用"}</span>
            </div>
          ))}
          {searchHits.length === 0 && <div className="empty card"><div className="big">🔍</div><div className="tip">无匹配结果（仅搜索已展开扫描过的分类）</div></div>}
        </div>
      ) : (
        <div className="flow-stack">
          {hiddenCats.length > 0 && (
            <div className="hidden-bar">
              已隐藏 {hiddenCats.length} 个分类：
              {hiddenCats.map((n) => (
                <span key={n} className="chip clickable" title="点击恢复显示" onClick={() => restoreCat(n)}>{n} ↩</span>
              ))}
            </div>
          )}
          {visibleCats.map((c) => {
            const data = catData[c.name];
            const flow = catFlow(c.name);
            const node: FlowNode = { ...flow, name: c.name };
            return (
              <FolderCardFlow
                key={c.path}
                node={node}
                depth={0}
                expanded={expanded}
                toggle={(rel) => {
                  if (rel === c.name) toggleCat(c.name);
                  else setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; });
                }}
                renderFileMain={renderFileMain(c.name)}
                onMoveFile={(f) => {
                  const src = data?.entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name);
                  if (src) setMoving({ cat: c.name, f: src });
                }}
                onDeleteFile={(f) => void deleteFile(c.name, f)}
                armedFile={armDelFile}
                onAddFiles={(rel) => void pickAndAdd(c.name, relIn(c.name, rel))}
                onNewFolder={(rel) => setNewSubAt(rel)}
                onDeleteDir={(rel) => void deleteDir(c.name, relIn(c.name, rel))}
                armedDir={armDelDir}
                onHideDir={hideCat}
                dragTag={c.name}
                onDropFile={(f, t, tag) => void moveFileTo(tag || c.name, f, c.name, relIn(c.name, t))}
                lazyLoading={!data || scanning.has(c.name)}
              />
            );
          })}
          {visibleCats.length === 0 && (
            <div className="empty card">
              <div className="big">◎</div>
              <div className="tip">models 目录下暂无分类 —— 点「＋ 新建分类」创建，或恢复底部已隐藏分类。</div>
            </div>
          )}
          {refs.length > 0 && (
            <div className="hidden-bar">
              未引用统计：
              {visibleCats.map((c) => (
                <span key={c.path} className="badge">{c.name}：{unusedTotal(c.name)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {moving && (
        <MoveModal
          fileName={moving.f.name}
          fromRel={moving.f.rel_dir}
          dirs={mergeTreeDirs(catData[moving.cat]?.entries ?? [], catData[moving.cat]?.emptyDirs ?? [""], moving.cat)}
          onConfirm={(targetRel) => void moveFileTo(moving.cat, { rel_dir: moving.f.rel_dir, name: moving.f.name, size: moving.f.size }, moving.cat, targetRel)}
          onClose={() => setMoving(null)}
        />
      )}
      {newSubAt !== null && (() => {
        const parts = newSubAt.split("/");
        const cat = parts[0];
        const rel = parts.slice(1).join("/");
        return (
          <NameModal
            title={`新建子文件夹 — ${newSubAt}`}
            placeholder="文件夹名称…"
            onConfirm={(name) => void addSubFolder(cat, rel, name)}
            onClose={() => setNewSubAt(null)}
          />
        );
      })()}
      {newCat && (
        <NameModal
          title="新建分类（创建同名文件夹）"
          placeholder="分类名称，如 my_checkpoints…"
          onConfirm={(name) => void addCategory(name)}
          onClose={() => setNewCat(false)}
        />
      )}
    </div>
  );
}
