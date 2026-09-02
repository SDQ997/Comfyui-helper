import { useState } from "react";
import { useStore } from "../store";
import { api, ChatMessage } from "../api";

export default function PromptPage() {
  const { config, toast } = useStore();
  const [userInput, setUserInput] = useState("");
  const [templateId, setTemplateId] = useState<string>("default");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [manualSystem, setManualSystem] = useState("");
  const [useManual, setUseManual] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const endpoints = config?.endpoints ?? [];
  const templates = config?.templates ?? [];
  const skills = config?.skills ?? [];
  const defaultEp = endpoints.find((e) => e.id === config?.default_endpoint_id) ?? endpoints[0];

  const buildSystemPrompt = (): string => {
    if (useManual) return manualSystem;
    const tpl = templates.find((t) => t.id === templateId);
    const skillContents = skills
      .filter((s) => skillIds.includes(s.id))
      .map((s) => `【Skill: ${s.name}】\n${s.content}`)
      .join("\n\n");
    return [tpl?.content ?? "", skillContents].filter(Boolean).join("\n\n");
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
    const sys = buildSystemPrompt();
    if (!sys.trim()) {
      toast("请选择 System Prompt 模板或手动填写", "err");
      return;
    }
    setBusy(true);
    setOutput("");
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: sys },
        { role: "user", content: userInput },
      ];
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
            填写需求、选择 Skill 与 System Prompt 模板，让 AI 把口述想法润色成可用的 ComfyUI /
            视频生成提示词。
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
                placeholder="手动输入 system prompt…"
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
                    onClick={() => setTemplateId(t.id)}
                  >
                    {t.name}
                  </span>
                ))}
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
              {busy ? "生成中…" : "✦ 生成提示词"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
