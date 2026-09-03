import { useRef, useState } from "react";
import { useStore } from "../store";
import { api, ChatMessage } from "../api";

export default function PromptPage() {
  const { config, toast } = useStore();
  const [userInput, setUserInput] = useState("");
  const [templateId, setTemplateId] = useState<string>(""); // 空 = 未选模板
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [manualSystem, setManualSystem] = useState("");
  const [useManual, setUseManual] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  // 图片上传：data URL 列表（base64），仅当默认端点勾选「图片理解」时可用
  const [images, setImages] = useState<{ dataUrl: string; name: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const endpoints = config?.endpoints ?? [];
  const templates = config?.templates ?? [];
  const skills = config?.skills ?? [];
  const defaultEp = endpoints.find((e) => e.id === config?.default_endpoint_id) ?? endpoints[0];
  const visionReady = !!defaultEp?.vision;

  const toggleTemplate = (id: string) =>
    setTemplateId((cur) => (cur === id ? "" : id)); // 再次点击取消选择

  // ---- 图片选择与压缩 ----
  const MAX_IMAGES = 4;
  const addImages = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const room = MAX_IMAGES - images.length;
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
      .filter((s) => skillIds.includes(s.id))
      .map((s) => `【Skill: ${s.name}】\n${s.content}`)
      .join("\n\n");

    let base = "";
    if (useManual) {
      base = manualSystem.trim();
    } else {
      const tpl = templates.find((t) => t.id === templateId);
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
    if (!userInput.trim()) {
      toast("请填写提示词内容", "err");
      return;
    }
    // System Prompt 模板 / Skill / 手动填写均为可选：一个都没选时直接用用户输入生成
    const sys = buildSystemPrompt();
    setBusy(true);
    setOutput("");
    try {
      let userContent: ChatMessage["content"] = userInput;
      // 有图片时组装 OpenAI 多模态格式：text + image_url（base64 data URL）
      if (images.length > 0) {
        userContent = [
          { type: "text", text: userInput },
          ...images.map((im) => ({ type: "image_url", image_url: { url: im.dataUrl } })),
        ];
      }
      const messages: ChatMessage[] = [];
      if (sys.trim()) messages.push({ role: "system", content: sys });
      messages.push({ role: "user", content: userContent });
      const result = await api.chatCompletion(defaultEp, messages, temperature);
      setOutput(result);
      toast("生成完成", "ok");
    } catch (e) {
      toast(`生成失败: ${e}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const copyOut = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      toast("已复制到剪贴板", "ok");
    } catch {
      toast("复制失败", "err");
    }
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>提示词助手</h1>
          <div className="desc">
            填写需求即可直接生成；也可选择 Skill 与 System Prompt 模板让 AI
            按特定风格润色成 ComfyUI / 视频生成提示词。
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
    </div>
  );
}
