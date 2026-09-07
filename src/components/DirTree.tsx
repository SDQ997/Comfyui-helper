import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/** 树节点数据：rel 为 / 分隔的相对目录，"" 表示根；files 为该目录直接包含的文件数 */
export interface TreeDir {
  rel: string;
  name: string;
  files: number;
}

/** 树中的文件叶节点（与后端条目字段兼容） */
export interface TreeFile {
  rel_dir: string;
  name: string;
  size: number;
}

/** 递归拉取根目录下全部子目录（含空文件夹），返回 / 分隔的 rel 列表（含 ""） */
export async function fetchAllDirs(root: string, maxDepth = 8): Promise<string[]> {
  const out = new Set<string>([""]);
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let subs;
    try {
      subs = await api.listSubdirs(abs);
    } catch {
      return;
    }
    for (const s of subs) {
      const childRel = rel ? `${rel}/${s.name}` : s.name;
      out.add(childRel);
      await walk(s.path, childRel, depth + 1);
    }
  };
  await walk(root, "", 0);
  return [...out];
}

/** 合并文件条目目录与空目录，生成完整 TreeDir 列表 */
export function mergeTreeDirs(
  entries: { rel_dir: string }[],
  emptyRels: string[],
  totalName: string
): TreeDir[] {
  const direct = new Map<string, number>();
  for (const e of entries) direct.set(e.rel_dir, (direct.get(e.rel_dir) ?? 0) + 1);
  const set = new Set<string>(["", ...emptyRels]);
  for (const e of entries) {
    if (!e.rel_dir) continue;
    const parts = e.rel_dir.split("/");
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      set.add(acc);
    }
  }
  return [...set].map((rel) => ({
    rel,
    name: rel === "" ? totalName : rel.split("/").pop() ?? rel,
    files: direct.get(rel) ?? 0,
  }));
}

interface Props {
  dirs: TreeDir[];
  /** 当前目录下的文件（渲染为叶节点）；不传则只显示目录 */
  files?: TreeFile[];
  selected: string;
  onSelect: (rel: string) => void;
  /** 点击文件叶节点（如工作流预览） */
  onOpenFile?: (f: TreeFile) => void;
  /** 请求删除文件夹（rel ≠ ""）；配合 deleteArmed 做二次确认 */
  onDeleteDir?: (rel: string) => void;
  /** 处于二次确认状态的文件夹 rel */
  deleteArmed?: string;
  /** 拖拽文件到文件夹释放（移动文件） */
  onDropFile?: (f: TreeFile, targetRel: string) => void;
  height?: number | string;
}

/** 树状目录菜单：展开/折叠、层级缩进、文件数角标、文件叶节点、文件夹删除、拖拽移动 */
export default function DirTree({ dirs, files, selected, onSelect, onOpenFile, onDeleteDir, deleteArmed, onDropFile, height }: Props) {
  const childrenMap = useMemo(() => {
    const m = new Map<string, TreeDir[]>();
    for (const d of dirs) {
      // 根节点（rel=""）由组件单独渲染，不能作为自己的子节点，否则无限递归
      if (d.rel === "") continue;
      const parent = d.rel.includes("/") ? d.rel.slice(0, d.rel.lastIndexOf("/")) : "";
      if (!m.has(parent)) m.set(parent, []);
      m.get(parent)!.push(d);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }
    return m;
  }, [dirs]);

  // 每个目录下的文件叶节点
  const filesMap = useMemo(() => {
    const m = new Map<string, TreeFile[]>();
    for (const f of files ?? []) {
      if (!m.has(f.rel_dir)) m.set(f.rel_dir, []);
      m.get(f.rel_dir)!.push(f);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }
    return m;
  }, [files]);

  // 展开状态：默认展开选中节点的全部祖先
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>([""]);
    const parts = selected.split("/").filter(Boolean);
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      s.add(acc);
    }
    return s;
  });

  useEffect(() => {
    setExpanded((prev) => {
      const n = new Set(prev);
      const parts = selected.split("/").filter(Boolean);
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        n.add(acc);
      }
      return n;
    });
  }, [selected]);

  const toggle = (rel: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });
  };

  const totalFiles = dirs.find((d) => d.rel === "")?.files ?? 0;

  // ── 拖拽移动：文件夹行作为投放目标 ──
  const [dragOverRel, setDragOverRel] = useState<string | null>(null);

  const dropHandlers = (targetRel: string) =>
    onDropFile
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverRel(targetRel);
          },
          onDragLeave: (e: React.DragEvent) => {
            e.stopPropagation();
            setDragOverRel((cur) => (cur === targetRel ? null : cur));
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverRel(null);
            try {
              const raw = e.dataTransfer.getData("text/plain");
              const f = JSON.parse(raw) as TreeFile;
              if (f && typeof f.rel_dir === "string" && typeof f.name === "string") {
                onDropFile(f, targetRel);
              }
            } catch {
              /* 非文件拖拽，忽略 */
            }
          },
        }
      : {};

  const folderDragCls = (rel: string) =>
    onDropFile && dragOverRel === rel ? " dragover" : "";

  const delBtn = (rel: string) => {
    if (!onDeleteDir || rel === "") return null;
    const armed = deleteArmed === rel;
    return (
      <span
        className={`dt-del ${armed ? "armed" : ""}`}
        title={armed ? "再次点击确认删除（危险操作，含内部全部内容）" : "删除文件夹（含内部全部内容，进回收站）"}
        onClick={(e) => {
          e.stopPropagation();
          onDeleteDir(rel);
        }}
      >
        {armed ? "确认删除？" : "🗑"}
      </span>
    );
  };

  const formatKb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)}G` : n >= 1024 * 1024 ? `${(n / 1024 ** 2).toFixed(0)}M` : `${(n / 1024).toFixed(0)}K`);

  const renderNode = (d: TreeDir, depth: number): React.ReactNode => {
    const kids = childrenMap.get(d.rel) ?? [];
    const dirFiles = filesMap.get(d.rel) ?? [];
    const isOpen = expanded.has(d.rel);
    const isSel = selected === d.rel;
    return (
      <div key={d.rel}>
        <div
          className={`dt-row ${isSel ? "sel" : ""}${folderDragCls(d.rel)}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => onSelect(d.rel)}
          {...dropHandlers(d.rel)}
        >
          <span
            className={`dt-arrow ${kids.length ? "" : "leaf"} ${isOpen ? "open" : ""}`}
            onClick={(e) => {
              if (kids.length) {
                e.stopPropagation();
                toggle(d.rel);
              }
            }}
          >
            {kids.length ? "▸" : ""}
          </span>
          <span className="dt-ico">{isOpen && kids.length ? "📂" : "📁"}</span>
          <span className="dt-name" title={d.rel}>{d.name}</span>
          {d.files > 0 && <span className="dt-n">{d.files}</span>}
          {delBtn(d.rel)}
        </div>
        {isOpen && (
          <>
            {kids.length > 0 && <div>{kids.map((k) => renderNode(k, depth + 1))}</div>}
            {dirFiles.length > 0 && (
              <div>{dirFiles.map((f) => (
                <div key={`f:${f.rel_dir}/${f.name}`}>
                  <div
                    className="dt-row dt-file"
                    style={{ paddingLeft: 6 + (depth + 1) * 14 }}
                    onClick={() => onOpenFile?.(f)}
                  >
                    <span className="dt-arrow leaf" />
                    <span className="dt-ico">📄</span>
                    <span className="dt-name" title={f.name}>{f.name}</span>
                    {f.size > 0 && <span className="dt-n">{formatKb(f.size)}</span>}
                  </div>
                </div>
              ))}</div>
            )}
          </>
        )}
      </div>
    );
  };

  const roots = childrenMap.get("") ?? [];
  const rootFiles = filesMap.get("") ?? [];

  return (
    <div className="dtree" style={{ height }}>
      <div className={`dt-row ${selected === "" ? "sel" : ""}${folderDragCls("")}`} style={{ paddingLeft: 6 }} onClick={() => onSelect("")} {...dropHandlers("")}>
        <span
          className={`dt-arrow ${roots.length ? "" : "leaf"} ${expanded.has("") ? "open" : ""}`}
          onClick={(e) => {
            if (roots.length) {
              e.stopPropagation();
              toggle("");
            }
          }}
        >
          {roots.length ? "▸" : ""}
        </span>
        <span className="dt-ico">{expanded.has("") && roots.length ? "📂" : "🏠"}</span>
        <span className="dt-name">全部</span>
        {totalFiles > 0 && <span className="dt-n">{totalFiles}</span>}
      </div>
      {expanded.has("") && (
        <>
          {roots.map((r) => renderNode(r, 1))}
          {rootFiles.map((f) => (
            <div key={`f:${f.rel_dir}/${f.name}`}>
              <div
                className="dt-row dt-file"
                style={{ paddingLeft: 6 + 14 }}
                onClick={() => onOpenFile?.(f)}
              >
                <span className="dt-arrow leaf" />
                <span className="dt-ico">📄</span>
                <span className="dt-name" title={f.name}>{f.name}</span>
                {f.size > 0 && <span className="dt-n">{formatKb(f.size)}</span>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
