import { useMemo, useRef } from "react";

/* ============ @ 资源选择浮层 ============ */
const KIND_LABEL = { image: "图片", video: "视频", audio: "音频" } as const;
const KIND_ICON = { image: "", video: "▶", audio: "♪" } as const;

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
