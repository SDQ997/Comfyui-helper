import { useRef, useState } from "react";
import { useStore, H3Asset, H3HistoryEntry, H3Mode } from "../store";
import { api, ChatMessage } from "../api";
import { buildH3System, h3ParamPrefix } from "../h3";
import { AssetPickerPanel, PickerItem } from "./h3parts";

const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"];

/** 生成模式：资源配额（T2V 无资源；I2V 单图；FL2V 首尾帧各一张，允许缺尾帧；R2V 全量） */
const MODE_META: {
  mode: H3Mode; label: string; full: string; desc: string;
  img: number; vid: number; aud: number;
}[] = [
  { mode: "T2V",  label: "T2V",  full: "文生视频",   desc: "纯文本构建时间线",       img: 0, vid: 0, aud: 0 },
  { mode: "I2V",  label: "I2V",  full: "图生视频",   desc: "单图作为首帧",           img: 1, vid: 0, aud: 0 },
  { mode: "FL2V", label: "FL2V", full: "首尾帧生视频", desc: "首帧必选，尾帧可选",      img: 2, vid: 0, aud: 0 },
  { mode: "R2V",  label: "R2V",  full: "参考生视频",  desc: "9 图 · 3 视频 · 3 音频", img: 9, vid: 3, aud: 3 },
];

/** FL2V 模式下图片槽位名称：首帧 / 尾帧 */
const slotLabel = (tab: AssetTab, idx: number, mode: H3Mode): string => {
  if (mode === "FL2V" && tab === "image") {
    return idx === 0 ? "首帧" : "尾帧";
  }
  const kindLabel = tab === "image" ? "图片" : tab === "video" ? "视频" : "音频";
  return `${kindLabel}${idx + 1}`;
};

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

function H3HistoryItem({ item }: { item: H3HistoryEntry }) {
  const { toast } = useStore();
  const [open, setOpen] = useState(false);

  const copy = async (text: string, label: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`, "ok");
    } catch {
      toast("复制失败", "err");
    }
  };

  return (
    <div className={`ph-item ${open ? "open" : ""}`}>
      <div className="ph-head" onClick={() => setOpen(!open)} title={open ? "收起" : "展开"}>
        <span className="ph-arrow">{open ? "▾" : "▸"}</span>
        <span className="ph-time">{item.time.slice(5, 16)}</span>
        {item.model && <span className="ph-model">{item.model}</span>}
        {item.assets.length > 0 && <span className="ph-imgs">资源×{item.assets.length}</span>}
        <span className="ph-sum mono">
          [{item.mode},{item.ratio},{item.duration}s] {item.user.replace(/\s+/g, " ").slice(0, 50)}{item.user.length > 50 ? "…" : ""}
        </span>
        <span className="ph-out-len">{item.output.length} 字</span>
      </div>

      {open && (
        <div className="ph-body">
          <div className="ph-sec">
            <div className="ph-sec-h">
              <span>用户提示词（{item.mode} · {item.systemMode} 指南 · T {item.temperature.toFixed(2)}）</span>
              <button className="ph-copy" onClick={() => copy(item.user, "用户提示词 ")}>📋 复制</button>
            </div>
            <div className="ph-sec-b mono">{item.user}</div>
          </div>

          {item.assets.length > 0 && (
            <div className="ph-sec">
              <div className="ph-sec-h"><span>引用资源</span></div>
              <div className="ph-sec-b mono">{item.assets.map((a) => `${a.kind === "image" ? "图片" : a.kind === "video" ? "视频" : "音频"}:${a.name}`).join("\n")}</div>
            </div>
          )}

          <div className="ph-sec">
            <div className="ph-sec-h">
              <span>生成内容</span>
              <button className="ph-copy" onClick={() => copy(item.output, "生成内容 ")}>📋 复制</button>
            </div>
            <div className="ph-sec-b mono out">{item.output}</div>
          </div>

          <div className="ph-ops">
            <button
              className="btn btn-line btn-xs"
              onClick={() => useStore.getState().setH3Draft({ text: item.user, output: item.output })}
            >
              ↩ 载入到编辑器
            </button>
            <button className="btn btn-line btn-xs" onClick={() => copy(`【用户】${item.user}\n\n【生成】${item.output}`, "完整记录 ")}>
              📋 复制全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function H3Page() {
  const { config, toast, h3Draft: draft, setH3Draft, h3History, addH3History, clearH3History } = useStore();
  const [busy, setBusy] = useState(false);
  const [histOpen, setHistOpen] = useState(false);

  // @ 浮层状态
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([]);
  const [pickerActive, setPickerActive] = useState(0);
  // 触发 @ 的光标偏移（选择后在原位插入「图片1」等文字）
  const atOffsetRef = useRef<number | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

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

  /** 删除资源后，同步清理提示词文本中的引用标签：被删的移除，后面同类的编号前移 */
  const removeAsset = (tab: AssetTab, id: string) => {
    const list = assetsOf(tab);
    const removedIdx = list.findIndex((a) => a.id === id); // 0-based
    const remain = list.filter((a) => a.id !== id);
    const kindLabel = tab === "image" ? "图片" : tab === "video" ? "视频" : "音频";
    const nextText = draft.text.replace(new RegExp(`${kindLabel}\\d+`, "g"), (m) => {
      const n = parseInt(m.slice(kindLabel.length), 10);
      if (n === removedIdx + 1) return ""; // 被删引用直接移除
      if (n > removedIdx + 1) return `${kindLabel}${n - 1}`; // 编号前移
      return m;
    });
    setH3Draft({ [tab === "image" ? "images" : tab === "video" ? "videos" : "audios"]: remain, text: nextText });
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

  /* ---------- 模式切换：清空提示词与结果，超出新配额的资源自动移除（保留前 room 个） ---------- */
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
      // 不同模式的提示词写法完全不同（base 三字段 vs ref 六段），切换即清空重写
      text: "",
      output: "",
    });
    atOffsetRef.current = null;
    if (removedAny) toast(`已切换到 ${mode}：提示词已清空，超出配额的资源已移除`, "info");
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
    insertRefText(slotLabel(it.kind, it.index - 1, draft.mode));
  };

  /** 在触发 @ 的光标处把 @ 替换为引用文字（如「图片1」），光标落在文字之后 */
  const insertRefText = (label: string) => {
    const el = editorRef.current;
    const cur = draft.text;
    let pos = atOffsetRef.current;
    atOffsetRef.current = null;
    if (pos === null) pos = el ? el.selectionStart : cur.length;
    const next = cur.slice(0, pos) + label + cur.slice(pos + 1); // @ 占 1 字符，直接替换
    const caret = pos + label.length;
    setH3Draft({ text: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

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
    if (draft.mode === "FL2V" && (draft.images.length < 1 || draft.images.length > 2)) {
      toast("FL2V（首尾帧）需要 1~2 张图片：首帧必选，尾帧可选", "err");
      return;
    }
    const bodyText = draft.text.trim();
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
    const userPrompt = `${h3ParamPrefix(draft.mode, draft.ratio, draft.duration, draft.images.length)}${draft.text}`;
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
          提交格式预览：<span className="mono">{h3ParamPrefix(draft.mode, draft.ratio, draft.duration, draft.images.length)}</span>你的描述…
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
                      <span className="h3-asset-name">{slotLabel(tab, i, draft.mode)}</span>
                      <button className="h3-asset-x" title="移除" onClick={() => removeAsset(tab, a.id)}>×</button>
                    </div>
                  ))}
                  {list.length < q && (
                    <button className="h3-asset-add" onClick={() => pickFiles(tab)} title={`添加${label}`}>
                      ＋
                      {/* 空槽位文字说明：FL2V 图片显示「首帧/尾帧」，其余显示序号名 */}
                      <span className="h3-slot-hint">{slotLabel(tab, list.length, draft.mode)}</span>
                    </button>
                  )}
                  {/* FL2V 尾帧可选说明 */}
                  {draft.mode === "FL2V" && tab === "image" && (
                    <span className="hint" style={{ alignSelf: "center" }}>首帧必选，尾帧可留空</span>
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

      {/* 提示词编辑区（纯文本 + @ 引用插入） */}
      <div className="panel" style={{ marginBottom: 12, position: "relative" }}>
        <h3><i className="dot" />提示词
          <span className="h-meta">输入 @ 引用资源，选择后以「图片1」等文字插入</span>
        </h3>
        <textarea
          ref={editorRef}
          className="h3-editable"
          rows={4}
          value={draft.text}
          placeholder="描述你的视频需求… 输入 @ 可引用上方资源"
          onChange={(e) => {
            const v = e.target.value;
            setH3Draft({ text: v });
            // 输入 @：光标前一个字符是 @ 即触发（不限位置），记录 @ 偏移并弹出资源浮层
            const pos = e.target.selectionStart;
            if (pos > 0 && v[pos - 1] === "@") {
              atOffsetRef.current = pos - 1;
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
        {pickerOpen && (
          <AssetPickerPanel
            items={pickerItems}
            activeIdx={pickerActive}
            setActiveIdx={setPickerActive}
            onPick={applyPick}
          />
        )}
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
          <span className="ph-title">⏱ MiniMax 助手历史</span>
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
              <H3HistoryItem key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
