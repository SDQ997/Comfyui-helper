import { useState } from "react";

interface Props {
  title: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

/** 单行文本输入弹窗（新建子文件夹 / 新建分类） */
export default function NameModal({ title, placeholder, confirmText = "创建", onConfirm, onClose }: Props) {
  const [name, setName] = useState("");
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="input" style={{ marginBottom: 4 }}>
          <input
            autoFocus
            placeholder={placeholder ?? "名称…"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
            }}
          />
        </div>
        <div className="hint" style={{ marginBottom: 14 }}>回车确认；非法字符会自动替换为下划线。</div>
        <div className="m-ops">
          <button className="btn btn-line" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onConfirm(name.trim())}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
