import { useState } from "react";
import DirTree, { TreeDir } from "./DirTree";

interface Props {
  fileName: string;
  fromRel: string;        // 当前所在目录（"" = 根）
  dirs: TreeDir[];        // 可选目标目录集合
  onConfirm: (targetRel: string) => void;
  onClose: () => void;
}

/** 移动文件：左侧树选择目标文件夹 → 确认移动 */
export default function MoveModal({ fileName, fromRel, dirs, onConfirm, onClose }: Props) {
  const [target, setTarget] = useState<string | null>(null);

  const targetName = (rel: string) => {
    if (rel === fromRel) return "（当前所在位置）";
    const d = dirs.find((x) => x.rel === rel);
    return d ? (rel === "" ? "根目录（全部）" : d.rel) : rel;
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" style={{ width: 520, height: "auto", maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span>📦 移动文件</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-xs" onClick={onClose}>✕</button>
          </span>
        </div>
        <div style={{ padding: "10px 14px 0", fontSize: 12, color: "var(--tx-2)" }}>
          <div>
            📄 <b>{fileName}</b>
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            当前位置：{fromRel === "" ? "根目录" : fromRel}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 8px" }}>
          <DirTree dirs={dirs} selected="__picker__" onSelect={(rel) => setTarget(rel)} />
        </div>
        <div className="m-ops" style={{ padding: "10px 14px", borderTop: "1px solid var(--line-1)", marginTop: 0 }}>
          <span className="hint" style={{ marginRight: "auto" }}>
            {target !== null ? `目标：${targetName(target)}` : "在上方选择目标文件夹"}
          </span>
          <button className="btn btn-line" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={target === null || target === fromRel}
            onClick={() => target !== null && onConfirm(target)}
          >
            移动到此处
          </button>
        </div>
      </div>
    </div>
  );
}
