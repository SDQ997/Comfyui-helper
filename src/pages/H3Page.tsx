import { useRef, useState } from "react";
import { useStore, H3Asset, H3Draft, H3Mode } from "../store";
import { api, ChatMessage } from "../api";
import { buildH3System, h3ParamPrefix } from "../h3";
import { AssetChip, AssetPickerPanel, AssetRef, PickerItem } from "./h3parts";

const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"];

/** 生成模式：资源配额（T2V 无资源；I2V 单图；FL2V 两图；R2V 全量） */
const MODE_META: {
  mode: H3Mode; label: string; full: string; desc: string;
  img: number; vid: number; aud: number;
}[] = [
  { mode: "T2V",  label: "T2V",  full: "文生视频",   desc: "纯文本构建时间线",       img: 0, vid: 0, aud: 0 },
  { mode: "I2V",  label: "I2V",  full: "图生视频",   desc: "单图作为首帧",           img: 1, vid: 0, aud: 0 },
  { mode: "FL2V", label: "FL2V", full: "首尾帧生视频", desc: "图1 首帧 + 图2 尾帧",    img: 2, vid: 0, aud: 0 },
  { mode: "R2V",  label: "R2V",  full: "参考生视频",  desc: "9 图 · 3 视频 · 3 音频", img: 9, vid: 3, aud: 3 },
];

type AssetTab = "image" | "video" | "audio";
const TAB_META: { tab: AssetTab; label: string; accept: string; icon: string }[] = [
  { tab: "image", label: "图片", accept: "image/*", icon: "🖼" },
  { tab: "video", label: "视频", accept: "video/*,.mkv,.flv,.mov", icon: "🎬" },
  { tab: "audio", label: "音频", accept: "audio/*,.flac,.ape,.ogg,.opus,.wma", icon: "🎵" },
];

const modeQuota = (mode: H3Mode, tab: AssetTab): number => {
  const m = MODE_META.find((x) => x.mode === mode)!;
  return tab === "image" ? m.img : tab === "video" ? m.vid : m.aud;
};

export default function H3Page() {
  const { config, toast, h3Draft: draft, setH3Draft, h3History, addH3History, clearH3History } = useStore();
  const [busy, setBusy] = useState(false);
  const [histOpen, setHistOpen] = useState(false);

  // @ 浮层状态
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([]);
  const [pickerActive, setPickerActive] = useState(0);
  // @ 触发点：{文本段下标, @ 前的光标偏移}
  const atTriggerRef = useRef<{ partIdx: number; textOffset: number } | null>(null);
  // 插入 chip 后希望聚焦的文本段下标（渲染后由 effect 消费）
  const caretHintRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputTabRef = useRef<AssetTab>("image");
  const [hint, setHint] = useState<string>("");

  const endpoints = config?.endpoints ?? [];
  const defaultEp = endpoints.find((e) => e.id === config?.default_endpoint_id) ?? endpoints[0];
  const curMode = MODE_META.find((m) => m.mode === draft.mode)!;

  /* ---------- 资源管理 ---------- */
  const assetsOf = (k: AssetTab): H3Asset[] => (k === "image" ? draft.images : k === "video" ? draft.videos : draft.audios);
  const setAssets = (k: AssetTab, fn: (prev: H3Asset[]) => H3Asset[]) =>
    setH3Draft(k === "image" ? { images: fn(draft.images) } : k === "video" ? { videos: fn(draft.videos) } : { audios: fn(draft.audios) });

  /** 清除 parts 中对指定 asset 的引用，并重排剩余引用的编号 */
  const removeAsset = (tab: AssetTab, id: string) => {
    const remain = assetsOf(tab).filter((a) => a.id !== id);
    const removedIdx = assetsOf(tab).findIndex((a) => a.id === id); // 0-based
    setAssets(tab, () => remain);
    const nextParts: H3Draft["parts"] = draft.parts.map((p) => {
      if (p.type !== "ref") return p;
      try {
        const r = JSON.parse(p.assetId) as AssetRef;
        if (r.kind === tab) {
          const oldIdx = r.index - 1;
          if (oldIdx === removedIdx) return null; // 引用被删，chip 移除
          if (oldIdx > removedIdx) {
            const nr: AssetRef = { ...r, index: r.index - 1 };
            return { type: "ref", assetId: JSON.stringify(nr) };
          }
        }
        return p;
      } catch { return p; }
    }).filter((p): p is H3Draft["parts"][number] => p !== null);
    setH3Draft({ parts: nextParts });
  };

  const pickFiles = (tab: AssetTab) => {
    inputTabRef.current = tab;
    // 强制 React 重渲染 input 以应用新 accept（通过 key 重建）
    const input = fileInputRef.current;
    if (input) {
      input.accept = TAB_META.find((m) => m.tab === tab)!.accept;
    }
    input?.click();
  };

  const onFilesChosen = async (files: FileList | null) => {
    const tab = inputTabRef.current;
    const meta = TAB_META.find((m) => m.tab === tab)!;
    const quota = modeQuota(draft.mode, tab);
    if (!files?.length) return;
    const cur = assetsOf(tab);
    const room = quota - cur.length;
    if (room <= 0) {
      toast(`当前模式下${meta.label}最多 ${quota} 个`, "err");
      return;
    }
    const picked = Array.from(files).slice(0, room);
    for (const f of picked) {
      const baseType = f.type.split("/")[0];
      const extOk = meta.accept.split(",").some((a) => !a.startsWith(".") && f.type.startsWith(a.replace("/*", "/")))
        || meta.accept.split(",").some((a) => a.startsWith(".") && f.name.toLowerCase().endsWith(a));
      if (!baseType.startsWith(meta.accept.split("/")[0]) && !extOk) {
        toast(`跳过非${meta.label}文件: ${f.name}`, "err");
        continue;
      }
      try {
        let dataUrl: string;
        if (tab === "image") {
          dataUrl = await compressImage(f, 1280);
        } else {
          dataUrl = f.name; // 视频/音频只存名字标识，不发内容
        }
        const asset: H3Asset = { id: crypto.randomUUID(), kind: tab, name: f.name, dataUrl, size: f.size };
        setAssets(tab, (prev) => [...prev, asset]);
      } catch (e) {
        toast(`读取文件失败: ${f.name} (${e})`, "err");
      }
    }
  };

  /** 读取图片并等比缩放转 data URL（长边压缩到 maxSide） */
  const compressImage = (file: File, maxSide: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读文件失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解码失败"));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          if (scale >= 1 && file.size < 1.5 * 1024 * 1024) {
            resolve(reader.result as string);
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("canvas 不可用")); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });

  /* ---------- 模式切换：超出新配额的资源自动移除（保留前 room 个） ---------- */
  const switchMode = (mode: H3Mode) => {
    if (mode === draft.mode) return;
    const imgKeep = assetsOf("image").slice(0, modeQuota(mode, "image"));
    const vidKeep = assetsOf("video").slice(0, modeQuota(mode, "video"));
    const audKeep = assetsOf("audio").slice(0, modeQuota(mode, "audio"));
    const removedAny =
      imgKeep.length !== draft.images.length ||
      vidKeep.length !== draft.videos.length ||
      audKeep.length !== draft.audios.length;
    setH3Draft({
      mode,
      images: imgKeep,
      videos: vidKeep,
      audios: audKeep,
      parts: draft.parts.filter((p) => {
        if (p.type !== "ref") return true;
        try {
          const r = JSON.parse(p.assetId) as AssetRef;
          const kindArr = r.kind === "image" ? imgKeep : r.kind === "video" ? vidKeep : audKeep;
          return r.index <= kindArr.length;
        } catch { return true; }
      }),
    });
    if (removedAny) toast(`已切换到 ${mode}：超出配额的资源及其引用已移除`, "info");
  };

  /* ---------- @ 浮层 ---------- */
  const openPicker = () => {
    const items: PickerItem[] = [];
    draft.images.forEach((a, i) => items.push({ key: a.id, kind: "image", index: i + 1, name: a.name, thumb: a.dataUrl }));
    draft.videos.forEach((a, i) => items.push({ key: a.id, kind: "video", index: i + 1, name: a.name }));
    draft.audios.forEach((a, i) => items.push({ key: a.id, kind: "audio", index: i + 1, name: a.name }));
    if (!items.length) {
      setHint("当前模式下无可引用资源 —— 请先在上方添加");
      setTimeout(() => setHint(""), 2600);
      return;
    }
    setPickerItems(items);
    setPickerActive(0);
    setPickerOpen(true);
  };

  const applyPick = (it: PickerItem) => {
    setPickerOpen(false);
    insertRefAfterText({ kind: it.kind, index: it.index, name: it.name, thumb: it.thumb });
  };

  /**
   * 在「触发 @ 的光标位置」插入引用 chip：
   * - 记录触发浮层时的 {文本段下标, @ 前光标偏移}
   * - 插入时以 @ 所在偏移为界，把该文本段切成前/后两段，chip 落在中间
   * - 若无记录（异常路径）退化为段末插入
   */
  const insertRefAfterText = (r: AssetRef) => {
    const parts = [...draft.parts];
    const a = atTriggerRef.current;
    atTriggerRef.current = null;
    let inserted = false;
    if (a && parts[a.partIdx]?.type === "text") {
      const tp = parts[a.partIdx] as { type: "text"; text: string };
      const cut = a.textOffset; // @ 字符所在偏移（@ 即被丢弃）
      const before = tp.text.slice(0, cut);
      const after = tp.text.slice(cut + 1); // 跳过 @
      const replacement: H3Draft["parts"] = [
        { type: "text", text: before },
        { type: "ref", assetId: JSON.stringify(r) },
        { type: "text", text: after },
      ];
      parts.splice(a.partIdx, 1, ...replacement);
      inserted = true;
      // 光标回到 chip 后的文本段开头
      caretHintRef.current = a.partIdx + 2;
    } else {
      parts.push({ type: "ref", assetId: JSON.stringify(r) });
      caretHintRef.current = parts.length; // 追加的新文本段
      parts.push({ type: "text", text: "" });
    }
    if (!inserted) {
      // 上面 push 了 ref 与空文本段，无需再处理
    }
    setH3Draft({ parts });
  };

  /** chip 上的 × 移除引用（按 assetId 匹配） */
  const removeRefPart = (assetId: string) => {
    setH3Draft({ parts: draft.parts.filter((p) => !(p.type === "ref" && p.assetId === assetId)) });
  };

  /* ---------- parts 工具 ---------- */
  /** parts → 纯文本（ref 转成 <图片1> 标签形式） */
  const partsToText = () =>
    draft.parts
      .map((p) => {
        if (p.type === "text") return p.text;
        try {
          const r = JSON.parse(p.assetId) as AssetRef;
          const label = `${r.kind === "image" ? "图片" : r.kind === "video" ? "视频" : "音频"}${r.index}`;
          return `<${label}>`;
        } catch {
          return "";
        }
      })
      .join("");

  const partsToUserPrompt = () => `${h3ParamPrefix(draft.mode, draft.ratio, draft.duration)}${partsToText()}`;

  /* ---------- 生成 ---------- */
  const generate = async () => {
    if (!defaultEp) {
      toast("请先在设置中配置 AI 模型 API", "err");
      return;
    }
    // 模式资源校验
    if (draft.mode === "I2V" && draft.images.length !== 1) {
      toast("I2V（图生视频）需要恰好 1 张图片作为首帧", "err");
      return;
    }
    if (draft.mode === "FL2V" && draft.images.length !== 2) {
      toast("FL2V（首尾帧）需要恰好 2 张图片：图1 首帧、图2 尾帧", "err");
      return;
    }
    const bodyText = partsToText().trim();
    if (!bodyText) {
      toast("请描述需求（可用 @ 引用资源）", "err");
      return;
    }
    const hasRef = draft.mode !== "T2V";
    const sys = buildH3System(draft.mode, {
      images: draft.images.length,
      videos: draft.videos.length,
      audios: draft.audios.length,
      duration: draft.duration,
    });
    const userPrompt = partsToUserPrompt();
    setBusy(true);
    setH3Draft({ output: "" });
    try {
      let userContent: ChatMessage["content"] = userPrompt;
      if (draft.images.length > 0) {
        userContent = [
          { type: "text", text: userPrompt },
          ...draft.images.map((im) => ({ type: "image_url", image_url: { url: im.dataUrl } })),
        ];
      }
      const messages: ChatMessage[] = [{ role: "system", content: sys }, { role: "user", content: userContent }];
      const result = await api.chatCompletion(defaultEp, messages, draft.temperature);
      setH3Draft({ output: result });
      addH3History({
        mode: draft.mode,
        systemMode: hasRef ? "ref" : "base",
        user: userPrompt,
        assets: [
          ...draft.images.map((a) => ({ kind: "image" as const, name: a.name })),
          ...draft.videos.map((a) => ({ kind: "video" as const, name: a.name })),
          ...draft.audios.map((a) => ({ kind: "audio" as const, name: a.name })),
        ],
        output: result,
        temperature: draft.temperature,
        model: defaultEp.name,
        ratio: draft.ratio,
        duration: draft.duration,
      });
      toast("生成完成", "ok");
    } catch (e) {
      toast(`生成失败: ${e}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const copyOut = async () => {
    if (!draft.output) return;
    try {
      await navigator.clipboard.writeText(draft.output);
      toast("已复制到剪贴板", "ok");
    } catch {
      toast("复制失败", "err");
    }
  };

  const quota = (tab: AssetTab) => modeQuota(draft.mode, tab);

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>MiniMax 助手</h1>
          <div className="desc">
            专为 MiniMax H3 视频生成打造：内置 h3-prompt-writing skill，按生成模式自动匹配 Base / Full-Reference 指南。
            输入 <b>@</b> 快速引用资源；视频 / 音频文件不会上传，AI 仅获知其编号与角色。
          </div>
        </div>
      </div>

      {!defaultEp && (
        <div className="empty card" style={{ marginBottom: 14 }}>
          <div className="big">⚠</div>
          <div className="tip">尚未配置 AI 模型 API。请前往 <b>设置 → 模型 API</b> 添加端点后返回使用。</div>
        </div>
      )}

      {/* 参数栏：生成模式 + 比例 + 时长 */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="h3-params">
          <div className="h3-param-group">
            <span className="h3-param-lbl">模式</span>
            <div className="template-pills">
              {MODE_META.map((m) => (
                <span
                  key={m.mode}
                  className={`p ${draft.mode === m.mode ? "active" : ""}`}
                  title={`${m.full}：${m.desc}`}
                  onClick={() => switchMode(m.mode)}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <span className="hint">{curMode.full} — {curMode.desc}</span>
          </div>
        </div>
        <div className="h3-params" style={{ marginTop: 10 }}>
          <div className="h3-param-group">
            <span className="h3-param-lbl">比例</span>
            <div className="template-pills">
              {RATIOS.map((r) => (
                <span
                  key={r}
                  className={`p ${draft.ratio === r ? "active" : ""}`}
                  onClick={() => setH3Draft({ ratio: r })}
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
          <div className="h3-param-group">
            <span className="h3-param-lbl">时长</span>
            <div className="input" style={{ width: 90 }}>
              <input
                type="number" min={4} max={20} value={draft.duration}
                onChange={(e) => setH3Draft({ duration: Math.max(4, Math.min(20, Number(e.target.value) || 15)) })}
              />
              <span className="ico">秒</span>
            </div>
            <span className="hint">4~20 秒，默认 15</span>
          </div>
          <div className="h3-param-group">
            <span className="h3-param-lbl">Temperature</span>
            <input
              type="range" min={0} max={2} step={0.05} value={draft.temperature}
              onChange={(e) => setH3Draft({ temperature: parseFloat(e.target.value) })}
              style={{ width: 120, accentColor: "var(--c-cyan)" }}
            />
            <span className="hint mono">{draft.temperature.toFixed(2)}</span>
          </div>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          提交格式预览：<span className="mono">{h3ParamPrefix(draft.mode, draft.ratio, draft.duration)}</span>你的描述…
        </div>
      </div>

      {/* 资源区（按模式显示可用类别与配额） */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <h3><i className="dot" />参考资源
          <span className="h-meta">
            {TAB_META.filter((m) => quota(m.tab) > 0)
              .map((m) => `${assetsOf(m.tab).length}/${quota(m.tab)} ${m.label}`)
              .join(" · ")}
          </span>
        </h3>
        {TAB_META.every((m) => quota(m.tab) === 0) ? (
          <div className="hint">T2V 模式不使用参考资源，直接描述需求即可。</div>
        ) : (
          TAB_META.map(({ tab, label, icon }) => {
            const q = quota(tab);
            if (q === 0) return null; // 当前模式禁用该类资源
            const list = assetsOf(tab);
            return (
              <div key={tab} className="h3-asset-row">
                <div className="h3-asset-head">
                  <span className="h3-asset-lbl">{icon} {label}</span>
                  <span className="hint">{list.length}/{q}</span>
                </div>
                <div className="h3-asset-list">
                  {list.map((a, i) => (
                    <div key={a.id} className="h3-asset-item" title={a.name}>
                      {tab === "image" ? (
                        <img src={a.dataUrl} alt={a.name} />
                      ) : (
                        <span className={`h3-asset-ico ${tab}`}>{tab === "video" ? "▶" : "♪"}</span>
                      )}
                      <span className="h3-asset-name">{label}{i + 1}</span>
                      <button className="h3-asset-x" title="移除" onClick={() => removeAsset(tab, a.id)}>×</button>
                    </div>
                  ))}
                  {list.length < q && (
                    <button className="h3-asset-add" onClick={() => pickFiles(tab)} title={`添加${label}`}>
                      ＋
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
        <input
          ref={fileInputRef} type="file" style={{ display: "none" }}
          accept={TAB_META.find((m) => m.tab === inputTabRef.current)?.accept}
          onChange={(e) => { void onFilesChosen(e.target.files); e.target.value = ""; }}
        />
      </div>

      {/* 提示词编辑区（rich parts 渲染 + @ 浮层） */}
      <div className="panel" style={{ marginBottom: 12, position: "relative" }}>
        <h3><i className="dot" />提示词
          <span className="h-meta">输入 @ 引用资源；图片以内嵌缩略展示</span>
        </h3>
        <div className="h3-editor" onClick={(e) => {
          const ta = e.currentTarget.querySelector("textarea");
          ta?.focus();
        }}>
          {draft.parts.map((p, i) => {
            if (p.type === "text") {
              return (
                <textarea
                  key={i}
                  ref={(el) => {
                    // 渲染后把光标放回 chip 后的文本段
                    if (caretHintRef.current === i && el) {
                      caretHintRef.current = null;
                      el.focus();
                      el.setSelectionRange(0, 0);
                    }
                  }}
                  className="h3-editable"
                  rows={Math.max(1, Math.ceil((p.text.length || 1) / 60))}
                  value={p.text}
                  placeholder={draft.parts.length === 1 ? "描述你的视频需求… 输入 @ 可引用上方资源" : ""}
                  onChange={(e) => {
                    const parts = [...draft.parts];
                    parts[i] = { type: "text", text: e.target.value };
                    setH3Draft({ parts });
                    // 检测 @ 触发：记录文本段下标与光标位置（@ 所在偏移）
                    if (e.target.value.endsWith("@")) {
                      atTriggerRef.current = { partIdx: i, textOffset: e.target.selectionStart - 1 };
                      openPicker();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (pickerOpen) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setPickerActive((pickerActive + 1) % pickerItems.length); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setPickerActive((pickerActive - 1 + pickerItems.length) % pickerItems.length); return; }
                      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyPick(pickerItems[pickerActive]); return; }
                      if (e.key === "Escape") { setPickerOpen(false); return; }
                    }
                  }}
                />
              );
            }
            // ref chip
            try {
              const r = JSON.parse(p.assetId) as AssetRef;
              return (
                <span key={i} className="h3-chip-wrap">
                  <AssetChip ref_={r} onRemove={() => removeRefPart(p.assetId)} />
                </span>
              );
            } catch { return null; }
          })}
          {pickerOpen && (
            <AssetPickerPanel
              items={pickerItems}
              activeIdx={pickerActive}
              setActiveIdx={setPickerActive}
              onPick={applyPick}
            />
          )}
        </div>
        {hint && <div className="hint" style={{ marginTop: 6, color: "var(--c-amber)" }}>{hint}</div>}
      </div>

      {/* 生成结果 */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <h3><i className="dot" />生成结果
          <span className="h-meta">{draft.output ? `${draft.output.length} 字符` : "等待生成"}</span>
        </h3>
        <div className={`out-box ${draft.output ? "" : "empty-out"}`}>
          {draft.output || "// 填写需求并点击生成，H3 结构化提示词将显示在这里…"}
        </div>
      </div>
      <div className="set-row" style={{ justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-line" onClick={copyOut} disabled={!draft.output}>📋 复制</button>
        <button className="btn btn-primary" onClick={generate} disabled={busy}>
          {busy ? "生成中…" : `✦ 生成 H3 提示词（${draft.mode},${draft.ratio},${draft.duration}s）`}
        </button>
      </div>

      {/* 历史 */}
      <div className="ph-panel">
        <div className="ph-panel-h" onClick={() => setHistOpen(!histOpen)}>
          <span className="ph-arrow">{histOpen ? "▾" : "▸"}</span>
          <span className="ph-title">⏱ H3 提示词历史</span>
          <span className="h-meta">{h3History.length} 条</span>
          <span style={{ flex: 1 }} />
          <button
            className="ph-clear"
            onClick={(e) => {
              e.stopPropagation();
              if (!h3History.length) return;
              if (confirm(`确定清空全部 ${h3History.length} 条历史？`)) {
                clearH3History();
                toast("历史已清空", "ok");
              }
            }}
          >
            🗑 清空
          </button>
        </div>
        {histOpen && (
          <div className="ph-list">
            {h3History.length === 0 && (
              <div className="ph-empty">暂无历史 —— 每次生成会记录模式、参数前缀、资源引用与输出。</div>
            )}
            {h3History.map((item) => (
              <div key={item.id} className="ph-item">
                <div className="ph-head" title={item.user}>
                  <span className="ph-time">{item.time.slice(5, 16)}</span>
                  {item.model && <span className="ph-model">{item.model}</span>}
                  <span className="ph-sum mono">[{item.mode},{item.ratio},{item.duration}s] {item.assets.length ? `资源×${item.assets.length} · ` : ""}{item.user.replace(/\s+/g, " ").slice(0, 50)}{item.user.length > 50 ? "…" : ""}</span>
                  <span className="ph-out-len">{item.output.length} 字</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
