import { ReactNode, useState } from "react";
import { FlowFile, FlowNode } from "./flow";
import { fmtSize } from "../api";

interface Props {
  node: FlowNode;
  depth: number;
  expanded: Set<string>;
  toggle: (rel: string) => void;
  /** 文件行主体（名称 / chips / pills / 路径），页面自定义 */
  renderFileMain: (f: FlowFile) => ReactNode;
  /** 文件行悬停操作（✎ 编辑触发词 / 👁 预览 等），不含 移动/删除（组件统一提供） */
  fileOps?: (f: FlowFile) => ReactNode;
  onMoveFile?: (f: FlowFile) => void;
  onDeleteFile?: (f: FlowFile) => void;
  armedFile?: string; // "rel_dir/name"
  onAddFiles?: (rel: string) => void;
  onNewFolder?: (rel: string) => void;
  onDeleteDir?: (rel: string) => void;
  armedDir?: string;
  /** 模型分类隐藏（仅 depth=0 的分类卡片显示） */
  onHideDir?: (rel: string) => void;
  onDropFile?: (f: FlowFile, targetRel: string, sourceTag?: string) => void;
  /** 拖拽载荷附加标记（如模型分类名，用于跨分类移动） */
  dragTag?: string;
  /** 展开时懒加载（模型分类首次展开扫描） */
  lazyLoading?: boolean;
}

const keyOf = (f: FlowFile) => `${f.rel_dir}/${f.name}`;

/** 折叠卡片流：递归文件夹卡片 + 文件行，与「提示词历史」同一交互语言 */
export default function FolderCardFlow(props: Props) {
  const {
    node, depth, expanded, toggle, renderFileMain, fileOps,
    onMoveFile, onDeleteFile, armedFile, onAddFiles, onNewFolder,
    onDeleteDir, armedDir, onHideDir, onDropFile, dragTag, lazyLoading,
  } = props;

  const [dragOver, setDragOver] = useState(false);
  const isOpen = expanded.has(node.rel);
  const hasKids = node.dirs.length > 0 || node.files.length > 0 || lazyLoading;

  const dropHandlers = onDropFile
    ? {
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); },
        onDragLeave: (e: React.DragEvent) => { e.stopPropagation(); setDragOver(false); },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault(); e.stopPropagation(); setDragOver(false);
          try {
            const { tag, ...f } = JSON.parse(e.dataTransfer.getData("text/plain")) as { tag?: string } & FlowFile;
            if (f && typeof f.rel_dir === "string" && typeof f.name === "string" && f.rel_dir !== node.rel) {
              onDropFile(f as FlowFile, node.rel, tag);
            }
          } catch { /* 非文件拖拽 */ }
        },
      }
    : {};

  const fileRow = (f: FlowFile) => {
    const armed = armedFile === keyOf(f);
    return (
      <div
        key={keyOf(f)}
        className={`fr`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", JSON.stringify({ rel_dir: f.rel_dir, name: f.name, size: f.size, tag: dragTag }));
          e.dataTransfer.effectAllowed = "move";
          (e.currentTarget as HTMLElement).classList.add("dragging");
        }}
        onDragEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("dragging")}
        title="拖拽到目标文件夹卡片可移动"
      >
        <span className="fico">📄</span>
        <div className="fr-main">
          {renderFileMain(f)}
        </div>
        <span className="sz">{fmtSize(f.size)}</span>
        <div className="h-ops">
          {fileOps?.(f)}
          {onMoveFile && (
            <span className="op" title="移动到其他文件夹" onClick={() => onMoveFile(f)}>⇄</span>
          )}
          {onDeleteFile && (
            <span
              className={`op del ${armed ? "armed" : ""}`}
              title={armed ? "再次点击确认删除（进回收站）" : "删除（进回收站）"}
              onClick={() => onDeleteFile(f)}
            >
              {armed ? "确认删除？" : "🗑"}
            </span>
          )}
        </div>
      </div>
    );
  };

  const hideOp =
    onHideDir && depth === 0 ? (
      <span className="op" title="隐藏该分类（不删除文件）" onClick={() => onHideDir(node.rel)}>✕ 隐藏</span>
    ) : null;

  return (
    <div className={`fc ${isOpen ? "open" : ""} ${dragOver ? "drop" : ""}`} {...dropHandlers}>
      <div className="fc-h" onClick={() => hasKids && toggle(node.rel)}>
        <span className={`arrow ${hasKids ? "" : "leaf"}`}>▸</span>
        <span className="fico">{isOpen && node.dirs.length ? "📂" : "📁"}</span>
        <span className="fname">{node.name}</span>
        <div className="meta">
          {node.directCount > 0 && <span className="badge">{node.directCount}</span>}
          {depth === 0 && node.totalCount > node.directCount && (
            <span className="badge c">共 {node.totalCount}</span>
          )}
          {lazyLoading && <span className="badge">…</span>}
        </div>
        <div className="h-ops" onClick={(e) => e.stopPropagation()}>
          {onAddFiles && <span className="op" title="添加文件到此文件夹" onClick={() => onAddFiles(node.rel)}>＋ 添加文件</span>}
          {onNewFolder && <span className="op" title="新建子文件夹" onClick={() => onNewFolder(node.rel)}>＋ 子文件夹</span>}
          {hideOp}
          {onDeleteDir && node.rel !== "" && (
            <span
              className={`op del ${armedDir === node.rel ? "armed" : ""}`}
              title={armedDir === node.rel ? "再次点击确认删除（危险：含内部全部内容）" : "删除文件夹（含内部全部内容，进回收站）"}
              onClick={() => onDeleteDir(node.rel)}
            >
              {armedDir === node.rel ? "确认删除？" : "🗑 删除"}
            </span>
          )}
        </div>
      </div>
      {isOpen && (
        <div className="fc-b" onClick={(e) => e.stopPropagation()}>
          {lazyLoading && node.dirs.length === 0 && node.files.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--tx-4)", padding: "4px 8px" }}>扫描中…</div>
          )}
          {node.dirs.map((d) => (
            <FolderCardFlow key={d.rel} {...props} node={d} depth={depth + 1} />
          ))}
          {node.files.map(fileRow)}
          {!lazyLoading && hasKids === false && (
            <div style={{ fontSize: 11, color: "var(--tx-4)", padding: "4px 8px" }}>空文件夹</div>
          )}
        </div>
      )}
    </div>
  );
}
