import { useRef, useState } from "react";
import { useStore, PromptHistoryEntry } from "../store";
import { api, ChatMessage } from "../api";

/* ---------- 历史条目：收拢/展开 + 分段复制 ---------- */
function HistoryItem({ item }: { item: PromptHistoryEntry }) {
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

  const hhmm = item.time.slice(5, 16); // MM-DD HH:MM

  return (
    <div className={`ph-item ${open ? "open" : ""}`}>
      <div className="ph-head" onClick={() => setOpen(!open)} title={open ? "收起" : "展开"}>
        <span className="ph-arrow">{open ? "▾" : "▸"}</span>
        <span className="ph-time">{hhmm}</span>
        {item.model && <span className="ph-model">{item.model}</span>}
        {item.images.length > 0 && <span className="ph-imgs">🖼×{item.images.length}</span>}
        <span className="ph-sum">
          {item.user.replace(/\s+/g, " ").slice(0, 60)}
          {item.user.length > 60 ? "…" : ""}
        </span>
        <span className="ph-out-len">{item.output.length} 字</span>
      </div>

      {open && (
        <div className="ph-body">
          <div className="ph-sec">
            <div className="ph-sec-h">
              <span>System Prompt</span>
              {item.system && (
                <button className="ph-copy" onClick={() => copy(item.system, "System Prompt ")}>
                  📋 复制
                </button>
              )}
            </div>
            <div className="ph-sec-b mono">
              {item.system || <span className="ph-none">（未使用）</span>}
            </div>
          </div>

          <div className="ph-sec">
            <div className="ph-sec-h">
              <span>用户提示词</span>
              {item.images.length > 0 && (
                <span className="ph-thumbs">
                  {item.images.map((u, i) => (
                    <img key={i} src={u} alt={`图${i + 1}`} title={`图 ${i + 1}`} />
                  ))}
                </span>
              )}
              <button className="ph-copy" onClick={() => copy(item.user, "用户提示词 ")}>
                📋 复制
              </button>
            </div>
            <div className="ph-sec-b mono">{item.user}</div>
          </div>

          <div className="ph-sec">
            <div className="ph-sec-h">
              <span>生成内容 · T {item.temperature.toFixed(2)}</span>
              <button className="ph-copy" onClick={() => copy(item.output, "生成内容 ")}>
                📋 复制
              </button>
            </div>
            <div className="ph-sec-b mono out">{item.output}</div>
          </div>

          <div className="ph-ops">
            <button
              className="btn btn-line btn-xs"
              onClick={() =>
                useStore.getState().setPromptDraft({
                  userInput: item.user,
                  output: item.output,
                  images: item.images.map((dataUrl, i) => ({ dataUrl, name: `历史图 ${i + 1}` })),
                })
              }
            >
              ↩ 载入到编辑器
            </button>
            <button className="btn btn-line btn-xs" onClick={() => copy(`${item.system ? item.system + "\n\n---\n\n" : ""}【用户】${item.user}\n\n【生成】${item.output}`, "完整记录 ")}>
              📋 复制全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PromptPage() {
  const { config, toast, promptDraft: draft, setPromptDraft, promptHistory, clearPromptHistory } = useStore();
  const [busy, setBusy] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const endpoints = config?.endpoints ?? [];
  const templates = config?.templates ?? [];
  const skills = config?.skills ?? [];
  const defaultEp = endpoints.find((e) => e.id === config?.default_endpoint_id) ?? endpoints[0];
  const visionReady = !!defaultEp?.vision;

  const setUserInput = (v: string) => setPromptDraft({ userInput: v });
  const setTemplateId = (v: string) => setPromptDraft({ templateId: v });
  const setSkillIds = (fn: (ids: string[]) => string[]) => setPromptDraft({ skillIds: fn(draft.skillIds) });
  const setManualSystem = (v: string) => setPromptDraft({ manualSystem: v });
  const setUseManual = (v: boolean) => setPromptDraft({ useManual: v });
  const setTemperature = (v: number) => setPromptDraft({ temperature: v });
  const setOutput = (v: string) => setPromptDraft({ output: v });
  const setImages = (fn: (prev: { dataUrl: string; name: string }[]) => { dataUrl: string; name: string }[]) =>
    setPromptDraft({ images: fn(draft.images) });

  const toggleTemplate = (id: string) =>
    setTemplateId(draft.templateId === id ? "" : id); // 再次点击取消选择

  // ---- 图片选择与压缩 ----
  const MAX_IMAGES = 4;
  const addImages = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const room = MAX_IMAGES - draft.images.length;
    if (room <= 0) {
      toast(`最多上传 ${MAX_IMAGES} 张图片`, "err");
      return;
    }
    const picked = Array.from(files).slice(0, room);
    for (const f of picked) {
      if (!f.type.startsWith("image/")) {
        toast(`跳过非图片文件: ${f.name}`, "err");
        continue;
      }
      try {
        const dataUrl = await compressImage(f, 1280);
        setImages((prev) => [...prev, { dataUrl, name: f.name }]);
      } catch (e) {
        toast(`读取图片失败: ${f.name} (${e})`, "err");
      }
    }
  };

  /** 读取图片并等比缩放转 data URL（长边超过 maxSide 则压缩，控制 base64 体积） */
  const compressImage = (file: File, maxSide: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读文件失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解码失败"));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          // 无需缩放且体积 < 1.5MB 时直接用原始 data URL（保持 PNG 透明度等）
          if (scale >= 1 && file.size < 1.5 * 1024 * 1024) {
            resolve(reader.result as string);
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("canvas 不可用"));
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });

  const buildSystemPrompt = (): string => {
    // Skill 块：放在最前，避免被模板/手动指令覆盖弱化
    const skillBlock = skills
      .filter((s) => draft.skillIds.includes(s.id))
      .map((s) => `【Skill: ${s.name}】\n${s.content}`)
      .join("\n\n");

    let base = "";
    if (draft.useManual) {
      base = draft.manualSystem.trim();
    } else {
      const tpl = templates.find((t) => t.id === draft.templateId);
      base = tpl?.content?.trim() ?? "";
    }

    const parts: string[] = [];
    if (skillBlock) parts.push(skillBlock);
    if (base) parts.push(base);
    return parts.join("\n\n");
  };

  const generate = async () => {
    if (!defaultEp) {
      toast("请先在设置中配置 AI 模型 API", "err");
      return;
    }
    if (!draft.userInput.trim()) {
      toast("请填写提示词内容", "err");
      return;
    }
    // System Prompt 模板 / Skill / 手动填写均为可选：一个都没选时直接用用户输入生成
    const sys = buildSystemPrompt();
    setBusy(true);
    setOutput("");
    try {
      let userContent: ChatMessage["content"] = draft.userInput;
      // 有图片时组装 OpenAI 多模态格式：text + image_url（base64 data URL）
      if (draft.images.length > 0) {
        userContent = [
          { type: "text", text: draft.userInput },
          ...draft.images.map((im) => ({ type: "image_url", image_url: { url: im.dataUrl } })),
        ];
      }
      const messages: ChatMessage[] = [];
      if (sys.trim()) messages.push({ role: "system", content: sys });
      messages.push({ role: "user", content: userContent });
      const result = await api.chatCompletion(defaultEp, messages, draft.temperature);
      setOutput(result);
      // 成功后写入历史快照（含 system / user / 图片 / 输出）
      useStore.getState().addPromptHistory({
        system: sys,
        user: draft.userInput,
        images: draft.images.map((im) => im.dataUrl),
        output: result,
        temperature: draft.temperature,
        model: defaultEp.name,
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

  const { userInput, templateId, skillIds, manualSystem, useManual, temperature, output, images } = draft;

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>AI润色</h1>
          <div className="desc">
            填写需求即可直接生成；也可选择 Skill 与 System Prompt 模板让 AI
            按特定风格润色成 ComfyUI / 视频生成提示词。切换页面不会丢失当前内容。
          </div>
        </div>
      </div>

      {!defaultEp && (
        <div className="empty card" style={{ marginBottom: 14 }}>
          <div className="big">⚠</div>
          <div className="tip">
            尚未配置 AI 模型 API。请前往 <b>设置 → 模型 API</b> 添加 OpenAI 兼容端点后返回使用。
          </div>
        </div>
      )}

      <div className="pa-layout">
        <div className="pa-col">
          <div className="panel">
            <h3>
              <i className="dot" />System Prompt 模板
              <span className="h-meta">
                <label style={{ cursor: "pointer", display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" checked={useManual} onChange={(e) => setUseManual(e.target.checked)} />
                  手动填写
                </label>
              </span>
            </h3>
            {useManual ? (
              <textarea
                className="txa mono"
                rows={6}
                placeholder="手动输入 system prompt…（勾选的 Skill 会拼接在其后）"
                value={manualSystem}
                onChange={(e) => setManualSystem(e.target.value)}
              />
            ) : (
              <div className="template-pills">
                {templates.length === 0 && <span className="hint">暂无模板，请在设置中添加</span>}
                {templates.map((t) => (
                  <span
                    key={t.id}
                    className={`p ${templateId === t.id ? "active" : ""}`}
                    title={templateId === t.id ? "再次点击取消选择" : "选择该模板"}
                    onClick={() => toggleTemplate(t.id)}
                  >
                    {t.name}
                    {templateId === t.id ? " ✕" : ""}
                  </span>
                ))}
              </div>
            )}
            {!useManual && templateId && (
              <div className="hint" style={{ marginTop: 6 }}>
                已选择模板；点选中的模板可取消。模板与 Skill 均为可选，不选直接生成。
              </div>
            )}
          </div>

          <div className="panel">
            <h3>
              <i className="dot" />Skills
              <span className="h-meta">{skillIds.length} 个已选</span>
            </h3>
            <div className="template-pills">
              {skills.length === 0 && <span className="hint">暂无 Skill，请在设置中导入</span>}
              {skills.map((s) => (
                <span
                  key={s.id}
                  className={`skill-chip ${skillIds.includes(s.id) ? "on" : ""}`}
                  onClick={() =>
                    setSkillIds((ids) =>
                      ids.includes(s.id) ? ids.filter((i) => i !== s.id) : [...ids, s.id]
                    )
                  }
                >
                  {s.name}
                </span>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>
              <i className="dot" />用户输入
              <span className="h-meta">{userInput.length} 字</span>
            </h3>
            {visionReady ? (
              <div
                className="img-upload"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void addImages(e.dataTransfer.files);
                }}
              >
                {images.map((im, idx) => (
                  <div key={idx} className="img-thumb">
                    <img src={im.dataUrl} alt={im.name} title={im.name} />
                    <button
                      className="img-x"
                      title="移除图片"
                      onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button
                    className="img-add"
                    title={`上传图片（最多 ${MAX_IMAGES} 张，可直接拖入）`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    ＋<span>图片</span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    void addImages(e.target.files);
                    e.target.value = ""; // 允许重复选择同一文件
                  }}
                />
              </div>
            ) : (
              <div className="hint" style={{ marginBottom: 6 }}>
                💡 在「设置 → 模型 API」中为当前模型勾选「🖼 图片理解」后，可在此上传图片让 AI 分析参考。
              </div>
            )}
            <textarea
              className="txa"
              rows={8}
              placeholder="用口述的方式描述你的需求…&#10;例：一个雨夜的霓虹街道，电影感构图，慢镜头…"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
            />
            <div className="set-row" style={{ marginTop: 10 }}>
              <span className="hint" style={{ minWidth: 90 }}>
                Temperature {temperature.toFixed(2)}
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: "var(--c-cyan)" }}
              />
            </div>
          </div>
        </div>

        <div className="pa-col">
          <div className="panel" style={{ flex: 1 }}>
            <h3>
              <i className="dot" />生成结果
              <span className="h-meta">{output ? `${output.length} 字符` : "等待生成"}</span>
            </h3>
            <div className={`out-box ${output ? "" : "empty-out"}`}>
              {output || "// 点击「生成提示词」开始，AI 润色结果将显示在这里…"}
            </div>
          </div>
          <div className="set-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-line" onClick={copyOut} disabled={!output}>
              📋 复制
            </button>
            <button className="btn btn-primary" onClick={generate} disabled={busy}>
              {busy ? "生成中…" : images.length > 0 ? `✦ 生成提示词（含 ${images.length} 图）` : "✦ 生成提示词"}
            </button>
          </div>
        </div>
      </div>

      {/* ---- 提示词历史（默认收拢，点击展开） ---- */}
      <div className="ph-panel">
        <div className="ph-panel-h" onClick={() => setHistOpen(!histOpen)} title={histOpen ? "收起历史" : "展开历史"}>
          <span className="ph-arrow">{histOpen ? "▾" : "▸"}</span>
          <span className="ph-title">⏱ AI润色历史</span>
          <span className="h-meta">{promptHistory.length} 条</span>
          <span style={{ flex: 1 }} />
          <button
            className="ph-clear"
            title="清空全部历史"
            onClick={(e) => {
              e.stopPropagation();
              if (promptHistory.length === 0) return;
              if (confirm(`确定清空全部 ${promptHistory.length} 条 AI润色历史？此操作不可恢复。`)) {
                clearPromptHistory();
                toast("历史已清空", "ok");
              }
            }}
          >
            🗑 清空
          </button>
        </div>
        {histOpen && (
          <div className="ph-list">
            {promptHistory.length === 0 && (
              <div className="ph-empty">暂无历史记录 —— 每次成功生成后，系统提示词、用户提示词与生成内容会自动保存在这里。</div>
            )}
            {promptHistory.map((item) => (
              <HistoryItem key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
