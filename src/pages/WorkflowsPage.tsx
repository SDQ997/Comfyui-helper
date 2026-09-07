import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, FileEntry } from "../api";
import FolderCardFlow from "../components/FolderCardFlow";
import { FlowFile, buildFlow, allFlowRels } from "../components/flow";
import { fetchAllDirs, mergeTreeDirs } from "../components/DirTree";
import MoveModal from "../components/MoveModal";
import NameModal from "../components/NameModal";

/** 路径拼接：root 是 Windows 风格（D:\x\y），rel 统一使用 / */
const joinPath = (root: string, rel: string) =>
  rel ? `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}` : root.replace(/[\\/]+$/, "");

export default function WorkflowsPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "workflows");
  const [dirIdx, setDirIdx] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [emptyDirs, setEmptyDirs] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["", "«root»"]));
  const [jsonOpen, setJsonOpen] = useState<string>(""); // "rel_dir/name"

  const [armDelFile, setArmDelFile] = useState("");
  const [armDelDir, setArmDelDir] = useState("");
  const [moving, setMoving] = useState<FileEntry | null>(null);
  const [newFolderAt, setNewFolderAt] = useState<string | null>(null);

  const activeDir = dirs[dirIdx] ?? "";

  const rescan = useCallback(async () => {
    if (!activeDir) return;
    setLoading(true);
    try {
      const [list, allDirs] = await Promise.all([
        api.scanFiles([activeDir], ["json"]),
        fetchAllDirs(activeDir),
      ]);
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
    setExpanded(new Set(["", "«root»"]));
    setJsonOpen("");
  }, [rescan]);

  const root = useMemo(() => buildFlow(entries, emptyDirs, activeDir.split(/[\\/]/).pop() || ""), [entries, emptyDirs, activeDir]);
  const findByKey = useCallback(
    (f: FlowFile) => entries.find((e) => e.rel_dir === f.rel_dir && e.name === f.name),
    [entries]
  );

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  const addDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    const group = config?.directories.find((d) => d.kind === "workflows");
    const paths = group ? group.paths : [];
    if (paths.includes(sel)) return;
    await updateConfig({
      directories: [
        ...(config?.directories.filter((d) => d.kind !== "workflows") ?? []),
        { kind: "workflows", paths: [...paths, sel] },
      ],
    });
  };

  const pickAndAdd = async (rel: string) => {
    const dest = joinPath(activeDir, rel);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: true,
      filters: [{ name: "ComfyUI Workflow", extensions: ["json"] }],
    });
    if (!Array.isArray(sel) || sel.length === 0) return;
    try {
      const n = await api.copyFilesIn(sel, dest);
      toast(`已添加 ${n} 个工作流到 ${rel === "" ? "根目录" : rel}`, "ok");
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
      await api.deleteAny(src.path);
      toast(`已删除 ${src.name}（进回收站）`, "ok");
      if (jsonOpen === key) setJsonOpen("");
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

  const toggleJson = async (f: FlowFile) => {
    const key = `${f.rel_dir}/${f.name}`;
    if (jsonOpen === key) { setJsonOpen(""); return; }
    const src = findByKey(f);
    if (!src) return;
    try {
      const text = await api.readTextFile(src.path);
      try {
        setJsonText((m) => ({ ...m, [key]: JSON.stringify(JSON.parse(text), null, 2) }));
      } catch {
        setJsonText((m) => ({ ...m, [key]: text }));
      }
      setJsonOpen(key);
    } catch (e) {
      toast(`读取失败: ${e}`, "err");
    }
  };

  const [jsonText, setJsonText] = useState<Record<string, string>>({});

  const copyJson = async (key: string) => {
    const t = jsonText[key];
    if (!t) return;
    await navigator.clipboard.writeText(t);
    toast("已复制到剪贴板", "ok");
  };

  const renderFileMain = (f: FlowFile) => {
    const key = `${f.rel_dir}/${f.name}`;
    const jt = jsonOpen === key ? jsonText[key] : undefined;
    return (
      <>
        <div className="fr-name clickable" title="点击展开 / 收起 JSON" onClick={() => void toggleJson(f)}>{f.name}</div>
        {search.trim() && <div className="fr-path">{f.rel_dir || "根目录"}</div>}
        {jt !== undefined && (
          <div className="fr-json">
            <div className="json-ops">
              <button className="btn btn-line btn-sm" onClick={() => void copyJson(key)}>📋 复制</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setJsonOpen("")}>收起</button>
            </div>
            <pre>{jt}</pre>
          </div>
        )}
      </>
    );
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>
            工作流管理 <span className="tag cyan">{entries.length} 个</span>
          </h1>
          <div className="desc">
            整页折叠卡片：目录分组与 ComfyUI 端一致；点工作流文件行内展开 JSON；悬停卡片头添加 / 删除，文件行可拖拽移动。
          </div>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "↻ 重新扫描"}
          </button>
          <button className="btn btn-line btn-sm" onClick={addDir}>＋ 添加目录</button>
          <button className="btn btn-primary btn-sm" onClick={() => pickAndAdd("")} disabled={!activeDir}>
            ＋ 添加工作流到根目录
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="dir-chips">
          {dirs.length === 0 && <span className="hint">尚未配置工作流目录（推荐 ComfyUI 的 user/default/workflows）</span>}
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
          <input placeholder="搜索工作流名称（全局）…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set(allFlowRels(root)))}>⊞ 展开全部</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set([""]))}>⊟ 收起全部</button>
          <button className="btn btn-line btn-sm" onClick={() => setNewFolderAt("")}>📁 新建根文件夹</button>
        </div>
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">❏</div>
          <div className="tip">请先点击「＋ 添加目录」选择工作流根目录。</div>
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
                <div className="fr-name clickable" onClick={() => void toggleJson(e)}>{e.name}</div>
                <div className="fr-path">{e.rel_dir || "根目录"}</div>
                {jsonOpen === `${e.rel_dir}/${e.name}` && jsonText[`${e.rel_dir}/${e.name}`] !== undefined && (
                  <div className="fr-json">
                    <div className="json-ops">
                      <button className="btn btn-line btn-sm" onClick={() => void copyJson(`${e.rel_dir}/${e.name}`)}>📋 复制</button>
                    </div>
                    <pre>{jsonText[`${e.rel_dir}/${e.name}`]}</pre>
                  </div>
                )}
              </div>
              <div className="h-ops">
                <span className="op" onClick={() => void toggleJson(e)} title="行内预览">👁</span>
                <span className="op" onClick={() => setMoving(e)} title="移动">⇄</span>
              </div>
            </div>
          ))}
          {searchHits.length === 0 && <div className="empty card"><div className="big">🔍</div><div className="tip">无匹配结果</div></div>}
        </div>
      ) : (
        <div className="flow-stack">
          {root.dirs.map((d) => (
            <FolderCardFlow
              key={d.rel}
              node={d}
              depth={0}
              expanded={expanded}
              toggle={(rel) => setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; })}
              renderFileMain={renderFileMain}
              fileOps={(f) => <span className="op" title="行内预览 JSON" onClick={() => void toggleJson(f)}>👁</span>}
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
          {root.files.length > 0 && (
            <FolderCardFlow
              node={{ ...root, name: "根目录", rel: "«root»", dirs: [], totalCount: root.files.length }}
              depth={0}
              expanded={expanded}
              toggle={(rel) => setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; })}
              renderFileMain={renderFileMain}
              fileOps={(f) => <span className="op" title="行内预览 JSON" onClick={() => void toggleJson(f)}>👁</span>}
              onMoveFile={(f) => { const src = findByKey(f); if (src) setMoving(src); }}
              onDeleteFile={deleteFile}
              armedFile={armDelFile}
              onAddFiles={() => void pickAndAdd("")}
              onNewFolder={() => setNewFolderAt("")}
              onDropFile={(f, t) => void moveFileTo(f, t)}
            />
          )}
          {root.dirs.length === 0 && root.files.length === 0 && (
            <div className="empty card">
              <div className="big">❏</div>
              <div className="tip">暂无工作流 —— 点「＋ 添加工作流到根目录」，或展开文件夹在对应层级添加。</div>
            </div>
          )}
        </div>
      )}

      {moving && (
        <MoveModal
          fileName={moving.name}
          fromRel={moving.rel_dir}
          dirs={mergeTreeDirs(entries, emptyDirs, activeDir.split(/[\\/]/).pop() || "")}
          onConfirm={(targetRel) => void moveFileTo({ rel_dir: moving.rel_dir, name: moving.name, size: moving.size }, targetRel)}
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
    </div>
  );
}
