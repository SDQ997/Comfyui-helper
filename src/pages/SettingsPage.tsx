import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api, AppConfig } from "../api";
import { applyTheme } from "../theme";

type FfStatus = {
  installed: boolean; source: string; ffmpeg_path: string; ffprobe_path: string;
  version: string; downloading: boolean; progress: number;
};

const SECTIONS = [
  { key: "api", label: "模型 API", ico: "◈" },
  { key: "dirs", label: "目录", ico: "📁" },
  { key: "prompts", label: "System Prompt", ico: "✦" },
  { key: "skills", label: "Skills", ico: "⚡" },
  { key: "general", label: "通用", ico: "⚙" },
  { key: "ffmpeg", label: "FFmpeg", ico: "▶" },
  { key: "backup", label: "导入导出", ico: "⇄" },
  { key: "about", label: "关于", ico: "ⓘ" },
];

export default function SettingsPage() {
  const { config, updateConfig, toast } = useStore();
  const [section, setSection] = useState("api");
  const [ff, setFf] = useState<FfStatus | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [dlProgress, setDlProgress] = useState<number | null>(null);
  const [dlStage, setDlStage] = useState("");
  const [mirror, setMirror] = useState("");
  const [saving, setSaving] = useState(false);
  // Skill 折叠：展开的 skill id 集合（默认全部收拢）
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const toggleSkillExpand = (id: string) =>
    setExpandedSkills((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ---- 草稿模型：所有编辑先写 draft，点「保存设置」才写回并持久化 ----
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const initRef = useRef(false);
  useEffect(() => {
    if (config && !initRef.current) {
      setDraft(JSON.parse(JSON.stringify(config)));
      initRef.current = true;
    }
  }, [config]);

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return JSON.stringify(config) !== JSON.stringify(draft);
  }, [config, draft]);

  // 主题预览：draft 一变就同步 <html data-theme>（真正持久化靠保存）
  useEffect(() => {
    if (!draft?.general?.theme) return;
    applyTheme(draft.general.theme);
  }, [draft?.general?.theme]);

  // 离开设置页时恢复已保存的主题：预览改了但没点保存，全局不能停留在预览色
  useEffect(() => {
    return () => {
      const saved = useStore.getState().config?.general?.theme;
      applyTheme(saved);
    };
  }, []);

  const d = draft; // 简写

  const patchDraft = (patch: Partial<AppConfig>) => {
    if (!d) return;
    setDraft({ ...d, ...patch });
  };
  const uid = () => crypto.randomUUID();

  const saveAll = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await updateConfig(draft);
      toast("设置已保存并生效", "ok");
    } catch (e) {
      toast(`保存失败: ${e}`, "err");
    } finally {
      setSaving(false);
    }
  };
  const resetAll = () => {
    if (config) {
      setDraft(JSON.parse(JSON.stringify(config)));
      toast("已丢弃未保存的修改", "info");
    }
  };

  useEffect(() => {
    api.ffmpegStatus().then(setFf).catch(() => {});
    api.getDataDir().then(setDataDir).catch(() => {});
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    let un2: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      const p = listen<number>("ffmpeg_download_progress", (e) => setDlProgress(e.payload));
      un = () => void p.then((f) => f());
      const p2 = listen<string>("ffmpeg_download_stage", (e) => {
        setDlStage(e.payload);
        if (e.payload.includes("连接")) setDlProgress(0.02);
      });
      un2 = () => void p2.then((f) => f());
    });
    return () => {
      un?.();
      un2?.();
    };
  }, []);

  if (!d) return null;
  const cfg = d;

  // ---- 模板 / Skill ----
  const addTemplate = () =>
    patchDraft({ templates: [...cfg.templates, { id: uid(), name: "新模板", content: "" }] });
  const patchTemplate = (id: string, p: Partial<{ name: string; content: string }>) =>
    patchDraft({ templates: cfg.templates.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  const removeTemplate = (id: string) =>
    patchDraft({ templates: cfg.templates.filter((t) => t.id !== id) });

  const addSkill = (name: string, content: string) => {
    const id = uid();
    patchDraft({ skills: [...cfg.skills, { id, name, content, enabled: true }] });
    // 新建后自动展开便于编辑
    setExpandedSkills((prev) => new Set(prev).add(id));
  };
  const patchSkill = (id: string, p: Partial<{ name: string; content: string; enabled: boolean }>) =>
    patchDraft({ skills: cfg.skills.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const removeSkill = (id: string) => {
    patchDraft({ skills: cfg.skills.filter((s) => s.id !== id) });
    setExpandedSkills((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const importSkillFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({
        multiple: false,
        filters: [{ name: "Skill / Markdown / Text", extensions: ["md", "txt", "markdown"] }],
      });
      if (typeof sel !== "string") return;
      const fname = sel.split(/[\\/]/).pop() ?? "skill";
      const name = fname.replace(/\.(md|txt|markdown)$/i, "");
      const content = await api.readTextFile(sel);
      addSkill(name, content);
      toast(`已导入 Skill「${name}」（记得点保存）`, "ok");
    } catch (e) {
      toast(`导入失败: ${e}`, "err");
    }
  };

  // ---- 目录 ----
  const addDirTo = async (kind: string) => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: true });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    const group = cfg.directories.find((x) => x.kind === kind);
    const merged = [...new Set([...(group?.paths ?? []), ...paths])];
    patchDraft({
      directories: [
        ...cfg.directories.filter((x) => x.kind !== kind),
        { kind, paths: merged },
      ],
    });
    toast(`已加入 ${paths.length} 个目录，点右上「保存设置」生效`, "ok");
  };
  const removeDir = (kind: string, path: string) => {
    const group = cfg.directories.find((x) => x.kind === kind);
    patchDraft({
      directories: [
        ...cfg.directories.filter((x) => x.kind !== kind),
        { kind, paths: (group?.paths ?? []).filter((p) => p !== path) },
      ],
    });
  };

  const dirPaths = (kind: string) => cfg.directories.find((x) => x.kind === kind)?.paths ?? [];

  const DirList = ({ kind, label, hint }: { kind: string; label: string; hint: string }) => (
    <div className="set-field dir-group">
      <div className="lbl">
        {label}
        <div className="sub">{hint}</div>
      </div>
      <div className="v">
        {dirPaths(kind).map((p) => (
          <div className="set-row" key={p}>
            <div className="input" style={{ flex: 1 }}>
              <span className="ico">📁</span>
              <input value={p} readOnly style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }} />
            </div>
            <button className="btn btn-danger btn-sm" onClick={() => removeDir(kind, p)}>
              移除
            </button>
          </div>
        ))}
        <button className="btn btn-line btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => addDirTo(kind)}>
          ＋ 添加目录
        </button>
      </div>
    </div>
  );

  // ---- API 端点 ----
  const addEndpoint = () => {
    const id = uid();
    patchDraft({
      endpoints: [
        ...cfg.endpoints,
        { id, name: "新端点", kind: "openai", base_url: "https://api.openai.com/v1", api_key: "", model: "gpt-4o", timeout_secs: 60, vision: false },
      ],
      default_endpoint_id: cfg.default_endpoint_id ?? id,
    });
  };
  const patchEndpoint = (id: string, patch: Record<string, unknown>) =>
    patchDraft({ endpoints: cfg.endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const removeEndpoint = (id: string) =>
    patchDraft({ endpoints: cfg.endpoints.filter((e) => e.id !== id) });
  const setDefault = (id: string) => patchDraft({ default_endpoint_id: id });

  // ---- ffmpeg 下载 ----
  const downloadFf = async () => {
    setDlProgress(0);
    setDlStage("正在连接镜像…");
    try {
      await api.downloadFfmpeg(mirror.trim() || undefined);
      const st = await api.ffmpegStatus();
      setFf(st);
      setDlProgress(null);
      setDlStage("");
      toast("ffmpeg 安装完成", "ok");
    } catch (e) {
      setDlProgress(null);
      setDlStage("");
      const msg = String(e);
      if (msg.includes("cancel")) toast("已取消下载", "info");
      else toast(`下载失败: ${e}`, "err");
    }
  };
  const openManualDownload = async () => {
    const { open: openUrl } = await import("@tauri-apps/plugin-shell");
    await openUrl("https://www.gyan.dev/ffmpeg/builds/");
  };

  // ---- 配置导入导出 ----
  const exportConfig = async () => {
    if (!draft) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const pad = (n: number) => String(n).padStart(2, "0");
      const now = new Date();
      const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const path = await save({
        defaultPath: `comfyui-helper-config-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await api.writeTextFile(path, JSON.stringify(draft, null, 2));
      toast("配置已导出", "ok");
    } catch (e) {
      toast(`导出失败: ${e}`, "err");
    }
  };

  const importConfig = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!sel) return;
      const path = Array.isArray(sel) ? sel[0] : sel;
      const raw = await api.readTextFile(path);
      const parsed = JSON.parse(raw) as AppConfig;
      // 最小合法性校验
      if (!parsed || !Array.isArray(parsed.endpoints) || !parsed.general) {
        throw new Error("文件结构不符合 ComfyUI Helper 配置格式");
      }
      // 写入草稿并立即持久化（导入即生效，用户可在界面上继续微调后保存）
      setDraft(parsed);
      await updateConfig(parsed);
      toast("配置已导入并保存生效", "ok");
    } catch (e) {
      toast(`导入失败: ${e instanceof Error ? e.message : e}`, "err");
    }
  };

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>设置</h1>
          <div className="desc">
            修改后需点击「保存设置」生效。数据目录：{dataDir}
            {dirty && <span className="pill warn" style={{ marginLeft: 8 }}>有未保存修改</span>}
          </div>
        </div>
        <div className="right" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn btn-ghost btn-sm" onClick={resetAll} disabled={!dirty || saving}>
            撤销
          </button>
          <button className={`btn ${dirty ? "btn-primary" : "btn-line"} btn-sm`} onClick={saveAll} disabled={saving}>
            {saving ? "保存中…" : dirty ? "● 保存设置" : "✓ 已保存"}
          </button>
        </div>
      </div>

      <div className="set-layout">
        <div className="set-side">
          {SECTIONS.map((s) => (
            <div key={s.key} className={`s ${section === s.key ? "active" : ""}`} onClick={() => setSection(s.key)}>
              <span className="ico">{s.ico}</span>
              {s.label}
            </div>
          ))}
        </div>

        <div className="set-main">
          {section === "api" && (
            <div className="card">
              <h3>
                <span className="num">01</span>模型 API
                <span className="tag cyan" style={{ marginLeft: "auto" }}>{cfg.endpoints.length} 个</span>
              </h3>
              <div className="desc" style={{ marginBottom: 12 }}>
                兼容 OpenAI Chat Completions 格式。支持 OpenAI / DeepSeek / 智谱 / Ollama / 自定义网关。改完记得保存。
                勾选「图片理解」的模型可在 AI润色 中上传图片进行分析。
              </div>
              {cfg.endpoints.map((e, idx) => {
                const isDefault = cfg.default_endpoint_id === e.id;
                return (
                  <div key={e.id} className={`ep-card ${isDefault ? "default" : ""}`}>
                    <div className="ep-head">
                      <span className="ep-idx">#{idx + 1}</span>
                      <input
                        className="ep-name"
                        value={e.name}
                        onChange={(ev) => patchEndpoint(e.id, { name: ev.target.value })}
                        placeholder="端点名称"
                      />
                      {isDefault ? (
                        <span className="ep-def" title="AI润色 等功能的默认模型">默认</span>
                      ) : (
                        <button
                          className="ep-setdef"
                          title="设为默认端点"
                          onClick={() => setDefault(e.id)}
                        >
                          设为默认
                        </button>
                      )}
                      <label
                        className={`ep-vision ${e.vision ? "on" : ""}`}
                        title="勾选后，AI润色 可上传图片让该模型分析（需模型本身支持视觉能力，如 gpt-4o / qwen-vl 等）"
                      >
                        <input
                          type="checkbox"
                          checked={!!e.vision}
                          onChange={(ev) => patchEndpoint(e.id, { vision: ev.target.checked })}
                        />
                        🖼 图片理解
                      </label>
                    </div>
                    <div className="ep-fields">
                      <div className="ep-f">
                        <label>类型</label>
                        <select className="sel" value={e.kind} onChange={(ev) => patchEndpoint(e.id, { kind: ev.target.value })}>
                          <option value="openai">OpenAI 兼容</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="ollama">Ollama</option>
                        </select>
                      </div>
                      <div className="ep-f">
                        <label>Base URL</label>
                        <div className="input">
                          <span className="ico">🔗</span>
                          <input value={e.base_url} onChange={(ev) => patchEndpoint(e.id, { base_url: ev.target.value })} placeholder="https://api.openai.com/v1" />
                        </div>
                      </div>
                      <div className="ep-f">
                        <label>API Key</label>
                        <div className="input">
                          <span className="ico">🔑</span>
                          <input type="password" value={e.api_key} onChange={(ev) => patchEndpoint(e.id, { api_key: ev.target.value })} placeholder="sk-..." />
                        </div>
                      </div>
                      <div className="ep-f">
                        <label>模型</label>
                        <div className="input">
                          <input value={e.model} onChange={(ev) => patchEndpoint(e.id, { model: ev.target.value })} placeholder="模型名，如 qwen3.7-flash" />
                        </div>
                      </div>
                      <div className="ep-f ep-f-sm">
                        <label>超时(秒)</label>
                        <div className="input">
                          <input type="number" min={5} max={600} value={e.timeout_secs}
                            onChange={(ev) => patchEndpoint(e.id, { timeout_secs: Number(ev.target.value) || 60 })} />
                        </div>
                      </div>
                      <div className="ep-del-wrap">
                        <button className="btn btn-danger btn-sm" onClick={() => removeEndpoint(e.id)}>删除</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button className="btn btn-line btn-sm" onClick={addEndpoint} style={{ marginTop: 10 }}>
                ＋ 添加 API 端点
              </button>
            </div>
          )}

          {section === "dirs" && (
            <div className="card">
              <h3>
                <span className="num">02</span>目录 <span className="hint">（支持多个）</span>
              </h3>
              <DirList kind="assets" label="资产目录" hint="递归扫描视频 / 图片 / 文本 / 音频" />
              <DirList kind="loras" label="LoRA 目录" hint="扫描 .safetensors / .pt，触发词读取同名 .txt" />
              <DirList kind="plugins" label="插件目录" hint="即 ComfyUI 的 custom_nodes 目录，可为多个 ComfyUI 安装分别配置" />
              <div className="set-divider" />
              <div className="hint">数据目录（config.toml 所在）：{dataDir}</div>
            </div>
          )}

          {section === "prompts" && (
            <div className="card">
              <h3>
                <span className="num">03</span>System Prompt 模板
                <span className="tag cyan">{cfg.templates.length} 个</span>
                <button className="btn btn-line btn-sm" style={{ marginLeft: "auto" }} onClick={addTemplate}>
                  ＋ 新建模板
                </button>
              </h3>
              <div className="desc" style={{ marginBottom: 12 }}>
                在「AI润色」中选择使用的模板（可选增强）；也可勾选「手动填写」直接用输入框写。
              </div>
              {cfg.templates.map((t, idx) => (
                <div key={t.id} className="prompt-editor">
                  <div className="set-row">
                    <div className="input" style={{ width: 220 }}>
                      <input value={t.name} placeholder={`模板 ${idx + 1}`} onChange={(e) => patchTemplate(t.id, { name: e.target.value })} />
                    </div>
                    <button className="btn btn-danger btn-sm" onClick={() => removeTemplate(t.id)} title="删除该模板">删除</button>
                  </div>
                  <textarea className="txa mono" rows={5} placeholder="System Prompt 内容…" value={t.content}
                    onChange={(e) => patchTemplate(t.id, { content: e.target.value })} style={{ marginTop: 8 }} />
                </div>
              ))}
              {cfg.templates.length === 0 && (
                <div className="hint">暂无模板。可点击右上「新建模板」开始维护。</div>
              )}
            </div>
          )}

          {section === "skills" && (
            <div className="card">
              <h3>
                <span className="num">04</span>Skills
                <span className="tag cyan">{cfg.skills.length} 个</span>
                <button className="btn btn-line btn-sm" style={{ marginLeft: "auto" }} onClick={importSkillFile}>⇩ 导入 .md Skill</button>
                <button className="btn btn-primary btn-sm" onClick={() => addSkill("新 Skill", "")}>＋ 新建</button>
              </h3>
              <div className="desc" style={{ marginBottom: 12 }}>
                导入/维护提示词技能片段，在「AI润色」里按需勾选（可选增强），会拼接到 System Prompt 最前。
              </div>
              {cfg.skills.map((s) => {
                const open = expandedSkills.has(s.id);
                return (
                  <div
                    key={s.id}
                    className={`prompt-editor ${open ? "open" : ""}`}
                    style={{ opacity: s.enabled ? 1 : 0.55 }}
                  >
                    <div className="set-row" onClick={() => toggleSkillExpand(s.id)} style={{ cursor: "pointer" }}>
                      <span className="skill-arrow" title={open ? "收起" : "展开内容"}>
                        {open ? "▾" : "▸"}
                      </span>
                      <div className="input" style={{ flex: 1 }}>
                        <span className="ico">✦</span>
                        <input
                          value={s.name}
                          placeholder="Skill 名称"
                          onClick={(ev) => ev.stopPropagation()}
                          onChange={(e) => patchSkill(s.id, { name: e.target.value })}
                        />
                      </div>
                      <span className="hint" style={{ whiteSpace: "nowrap" }}>
                        {s.content.length} 字
                      </span>
                      <label
                        style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <div
                          className={`toggle ${s.enabled ? "on" : ""}`}
                          onClick={() => patchSkill(s.id, { enabled: !s.enabled })}
                        />
                        <span className="hint">启用</span>
                      </label>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          removeSkill(s.id);
                        }}
                        title="删除该 Skill"
                      >
                        删除
                      </button>
                    </div>
                    {open && (
                      <>
                        <textarea
                          className="txa mono"
                          rows={5}
                          placeholder="Skill 内容（规则 / 说明 / 示例）…"
                          value={s.content}
                          onChange={(e) => patchSkill(s.id, { content: e.target.value })}
                          style={{ marginTop: 8 }}
                        />
                        <div className="hint" style={{ marginTop: 6 }}>
                          将作为 <span className="mono">【Skill: {s.name}】</span> 拼接到 System Prompt（AI润色 勾选时生效）。
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {cfg.skills.length === 0 && (
                <div className="hint">暂无 Skill。可点击「导入 .md Skill」从本地文件导入，或点「新建」手动创建。</div>
              )}
            </div>
          )}

          {section === "general" && (
            <div className="card">
              <h3>
                <span className="num">05</span>通用 / 行为
              </h3>
              <div className="set-field">
                <div className="lbl">主题外观</div>
                <div className="v">
                  <div className="set-row">
                    <div className={`seg`}>
                      <div
                        className={`b ${cfg.general.theme !== "light" ? "active" : ""}`}
                        onClick={() => patchDraft({ general: { ...cfg.general, theme: "dark" } })}
                      >
                        🌙 深色
                      </div>
                      <div
                        className={`b ${cfg.general.theme === "light" ? "active" : ""}`}
                        onClick={() => patchDraft({ general: { ...cfg.general, theme: "light" } })}
                      >
                        ☀ 浅色
                      </div>
                    </div>
                  </div>
                  <div className="hint">切换后立即预览，点「保存设置」持久化生效。</div>
                </div>
              </div>
              <div className="set-field">
                <div className="lbl">关闭行为</div>
                <div className="v">
                  <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    <div
                      className={`toggle ${cfg.general.minimize_to_tray ? "on" : ""}`}
                      onClick={() => patchDraft({ general: { ...cfg.general, minimize_to_tray: !cfg.general.minimize_to_tray } })}
                    />
                    <span>关闭窗口时最小化到托盘（默认直接退出，内存零常驻）</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {section === "ffmpeg" && (
            <div className="card">
              <h3>
                <span className="num">06</span>FFmpeg{" "}
                {ff?.installed && <span className="pill ok"><i className="d" />已安装</span>}
                {ff && !ff.installed && <span className="pill warn"><i className="d" />未安装</span>}
              </h3>
              <div className="desc" style={{ marginBottom: 12 }}>
                视频分析模块依赖 ffmpeg / ffprobe（读取元数据、抽帧）。安装到应用数据目录，不影响系统环境。
              </div>
              {ff?.installed ? (
                <div className="meta-kv">
                  <span className="k">来源</span>
                  <span className="v">{ff.source === "system" ? "系统 PATH" : "应用内置"}</span>
                  <span className="k">版本</span>
                  <span className="v">{ff.version}</span>
                  <span className="k">路径</span>
                  <span className="v">{ff.ffmpeg_path}</span>
                </div>
              ) : dlProgress !== null ? (
                <div>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    {dlStage || "下载中…"} — {(dlProgress * 100).toFixed(0)}%（约 80MB）
                  </div>
                  <div style={{ height: 6, background: "var(--bg-3)", borderRadius: 3, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${Math.min(100, dlProgress * 100)}%`, height: "100%",
                        background: "var(--c-cyan)", boxShadow: "0 0 8px var(--c-cyan-glow)",
                        transition: "width 0.2s",
                      }}
                    />
                  </div>
                  <div className="set-row" style={{ marginTop: 8 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        await api.cancelFfmpeg().catch(() => {});
                        setDlProgress(null);
                        setDlStage("");
                      }}
                    >
                      ✕ 取消下载
                    </button>
                    <button
                      className="btn btn-line btn-sm"
                      onClick={async () => {
                        setDlProgress(null);
                        setDlStage("");
                      }}
                    >
                      放弃并隐藏
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    自动下载会依次尝试 ghproxy / GitHub / gyan.dev 镜像（约 80MB，慢属正常）。若始终很慢，可改用浏览器手动下载：
                  </div>
                  <div className="set-row" style={{ marginBottom: 10 }}>
                    <button className="btn btn-primary" onClick={downloadFf}>
                      ⤓ 自动下载并安装
                    </button>
                    <button className="btn btn-line" onClick={openManualDownload}>
                      🌐 手动下载（打开官方下载页）
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        const st = await api.ffmpegStatus().catch(() => null);
                        if (st) setFf(st);
                        toast("已重新检测", "info");
                      }}
                    >
                      ↻ 我已放好文件，重新检测
                    </button>
                  </div>
                  <div className="hint" style={{ background: "var(--bg-3)", padding: "8px 10px", borderRadius: 6 }}>
                    <b>手动下载步骤：</b>
                    <br />
                    1. 打开上方「手动下载」页面，下载 ffmpeg 的 <b>Windows Essentials / full 版 zip</b>；
                    <br />
                    2. 解压 zip，找到其中的 <span className="mono">ffmpeg.exe</span> 与 <span className="mono">ffprobe.exe</span>；
                    <br />
                    3. 把这两个 exe 复制到目录：<span className="mono">{dataDir ? `${dataDir}\\tools` : "应用数据目录\\tools"}</span>；
                    <br />
                    4. 回到本页点「我已放好文件，重新检测」。
                  </div>
                  <div className="set-row" style={{ marginTop: 10 }}>
                    <div className="input" style={{ flex: 1 }}>
                      <span className="ico">🔗</span>
                      <input value={mirror} onChange={(e) => setMirror(e.target.value)} placeholder="自定义镜像 ZIP 直链（可选，自动下载用）" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {section === "backup" && (
            <div className="card">
              <h3>
                <span className="num">07</span>导入导出
              </h3>
              <div className="desc" style={{ marginBottom: 12 }}>
                导出全部配置（模型 API 端点含密钥、System Prompt 模板、Skills、目录、通用设置）为 JSON 备份文件，
                在另一台电脑导入即可完成迁移。<b>备份文件含 API 密钥，请妥善保管。</b>
              </div>
              <div className="set-row">
                <button className="btn btn-primary" onClick={exportConfig}>
                  ⤒ 导出到文件…
                </button>
                <button className="btn btn-line" onClick={importConfig}>
                  ⤓ 从文件导入…
                </button>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                导出文件名默认为 comfyui-helper-config-日期.json。导入时会覆盖当前全部配置，操作前请先导出一份当前配置作为备份。
              </div>
            </div>
          )}

          {section === "about" && (
            <div className="card">
              <h3>
                <span className="num">08</span>关于
              </h3>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 0" }}>
                <div className="sb-logo" style={{ width: 44, height: 44 }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>ComfyUI Helper</div>
                  <div style={{ fontSize: 11.5, color: "var(--tx-3)", fontFamily: "var(--f-mono)", marginTop: 2 }}>
                    v0.1.0 · MIT License · 轻量 ComfyUI 桌面助手
                  </div>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                本软件完全开源免费。如果对你有帮助，欢迎到「捐赠」页支持作者 — 开源不易，感谢支持。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
