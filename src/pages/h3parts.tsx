import { useMemo, useRef } from "react";
import { create } from "zustand";

/* ============ 行内资源引用 chip ============ */
export interface AssetRef {
  kind: "image" | "video" | "audio";
  index: number;   // 类内序号（从 1 开始）
  name: string;
  thumb?: string;  // 图片缩略 data URL
}

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频" } as const;
const KIND_ICON = { image: "", video: "▶", audio: "♪" } as const;

export function AssetChip({ ref_, onRemove }: { ref_: AssetRef; onRemove?: () => void }) {
  const label = `${KIND_LABEL[ref_.kind]}${ref_.index}`;
  return (
    <span className={`mref-chip ${ref_.kind}`} contentEditable={false} data-ref={label}>
      {ref_.kind === "image" && ref_.thumb ? (
        <img className="mref-thumb" src={ref_.thumb} alt="" />
      ) : (
        <span className="mref-ico">{KIND_ICON[ref_.kind]}</span>
      )}
      <span className="mref-label">{label}</span>
      {onRemove && (
        <button
          className="mref-x"
          title="移除引用"
          onMouseDown={(e) => {
            e.preventDefault(); // 防止夺走编辑器焦点
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ============ @ 资源选择浮层 ============ */
export interface PickerItem {
  key: string;
  kind: "image" | "video" | "audio";
  index: number;
  name: string;
  thumb?: string;
}

export function AssetPickerPanel({
  items, activeIdx, setActiveIdx, onPick,
}: {
  items: PickerItem[];
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  onPick: (it: PickerItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // activeIdx 变化时保持可见
  useMemo(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);
  if (!items.length) return null;
  return (
    <div className="mref-picker" ref={listRef as React.RefObject<HTMLDivElement>}>
      {items.map((it, i) => (
        <div
          key={it.key}
          className={`mref-item ${i === activeIdx ? "active" : ""}`}
          onMouseEnter={() => setActiveIdx(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(it);
          }}
        >
          {it.kind === "image" && it.thumb ? (
            <img className="mref-item-thumb" src={it.thumb} alt="" />
          ) : (
            <span className={`mref-item-ico ${it.kind}`}>{KIND_ICON[it.kind]}</span>
          )}
          <span className="mref-item-label">{KIND_LABEL[it.kind]}{it.index}</span>
        </div>
      ))}
    </div>
  );
}

/* ============ 纯展示用小 store（避免循环依赖主 store 时的额外接线） ============ */
export const useNothing = create<() => void>(() => () => {});
