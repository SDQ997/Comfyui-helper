import { create } from "zustand";
import { api, AppConfig } from "./api";

interface Toast { id: number; text: string; kind: "ok" | "err" | "info"; }

/** 提示词历史条目：一次成功生成的完整快照 */
export interface PromptHistoryEntry {
  id: string;
  time: string;          // ISO 时间
  system: string;        // 实际拼接的 system prompt（含 Skill，可为空）
  user: string;          // 用户输入文本
  images: string[];      // 随请求上传的图片 data URL（缩略预览 + 复原）
  output: string;        // AI 生成内容
  temperature: number;
  model?: string;        // 端点名称快照
}

/** AI润色草稿：跨页面保留，切走再切回不丢内容 */
export interface PromptDraft {
  userInput: string;
  templateId: string;
  skillIds: string[];
  manualSystem: string;
  useManual: boolean;
  temperature: number;
  output: string;
  images: { dataUrl: string; name: string }[];
}

/** MiniMax 助手资源引用（图片/视频/音频） */
export interface H3Asset {
  id: string;
  kind: "image" | "video" | "audio";
  name: string;
  /** 图片：压缩后 data URL；视频/音频：本地路径（仅作为标识与缩略线索，不发给 AI） */
  dataUrl: string;
  /** 图片发给 AI 用 data URL；视频/音频发文件名占位 */
  size: number;
}

/** MiniMax 助手历史条目 */
export interface H3HistoryEntry {
  id: string;
  time: string;
  mode: string;         // T2V / I2V / FL2V / R2V
  systemMode: string;   // base / ref（记录当次使用的指南）
  user: string;         // 已拼参数前缀的最终 user prompt
  assets: { kind: "image" | "video" | "audio"; name: string }[];
  output: string;
  temperature: number;
  model?: string;
  ratio: string;
  duration: number;
}

export type H3Mode = "T2V" | "I2V" | "FL2V" | "R2V";

/** MiniMax 助手草稿 */
export interface H3Draft {
  mode: H3Mode;
  text: string;
  images: H3Asset[];
  videos: H3Asset[];
  audios: H3Asset[];
  ratio: string;
  duration: number;
  temperature: number;
  output: string;
}

const LS_KEY = "comfyui_helper_prompt_history_v1";
const MAX_HISTORY = 50;
const H3_LS_KEY = "comfyui_helper_h3_history_v1";
const H3_MAX_HISTORY = 50;

function loadHistory(): PromptHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    // 旧数据用共享计数器生成 id，重启后可能重复 → 载入时统一重发，杜绝 React key 撞车
    return Array.isArray(arr) ? arr.map((e: PromptHistoryEntry) => ({ ...e, id: newHistId() })) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: PromptHistoryEntry[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // 存储满时静默降级：丢弃图片仅保留文本
    try {
      const slim = list.map((e) => ({ ...e, images: [] }));
      localStorage.setItem(LS_KEY, JSON.stringify(slim));
    } catch {
      /* 忽略 */
    }
  }
}

function loadH3History(): H3HistoryEntry[] {
  try {
    const raw = localStorage.getItem(H3_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    // 同 loadHistory：旧数据 id 可能重复，载入时统一重发
    return Array.isArray(arr) ? arr.map((e: H3HistoryEntry) => ({ ...e, id: newHistId() })) : [];
  } catch {
    return [];
  }
}

function saveH3History(list: H3HistoryEntry[]) {
  try {
    localStorage.setItem(H3_LS_KEY, JSON.stringify(list));
  } catch {
    try {
      localStorage.setItem(H3_LS_KEY, JSON.stringify(list.slice(0, 20)));
    } catch {
      /* 忽略 */
    }
  }
}

interface Store {
  config: AppConfig | null;
  page: string;
  toasts: Toast[];

  // 提示词助手全局草稿（跨页面保留）
  promptDraft: PromptDraft;
  setPromptDraft: (patch: Partial<PromptDraft>) => void;

  // 提示词历史（localStorage 持久化）
  promptHistory: PromptHistoryEntry[];
  addPromptHistory: (entry: Omit<PromptHistoryEntry, "id" | "time">) => void;
  clearPromptHistory: () => void;

  // MiniMax 助手：草稿 + 历史
  h3Draft: H3Draft;
  setH3Draft: (patch: Partial<H3Draft>) => void;
  h3History: H3HistoryEntry[];
  addH3History: (entry: Omit<H3HistoryEntry, "id" | "time">) => void;
  clearH3History: () => void;

  setPage: (p: string) => void;
  loadConfig: () => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
/** 历史条目唯一 id：旧实现用共享计数器，重启后归零导致与已存条目 id 撞车（React key 重复 → 列表错乱/展不开），改用 UUID */
const newHistId = () => crypto.randomUUID();

export const useStore = create<Store>((set, get) => ({
  config: null,
  page: "prompt",
  toasts: [],
  setPage: (page) => set({ page }),

  promptDraft: {
    userInput: "",
    templateId: "",
    skillIds: [],
    manualSystem: "",
    useManual: false,
    temperature: 0.7,
    output: "",
    images: [],
  },
  setPromptDraft: (patch) =>
    set((s) => ({ promptDraft: { ...s.promptDraft, ...patch } })),

  promptHistory: loadHistory(),
  addPromptHistory: (entry) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const item: PromptHistoryEntry = { ...entry, id: newHistId(), time };
    set((s) => {
      const list = [item, ...s.promptHistory].slice(0, MAX_HISTORY);
      saveHistory(list);
      return { promptHistory: list };
    });
  },
  clearPromptHistory: () => {
    saveHistory([]);
    set({ promptHistory: [] });
  },

  h3Draft: {
    mode: "T2V",
    text: "",
    images: [],
    videos: [],
    audios: [],
    ratio: "16:9",
    duration: 15,
    temperature: 0.7,
    output: "",
  },
  setH3Draft: (patch) => set((s) => ({ h3Draft: { ...s.h3Draft, ...patch } })),

  h3History: loadH3History(),
  addH3History: (entry) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const item: H3HistoryEntry = { ...entry, id: newHistId(), time };
    set((s) => {
      const list = [item, ...s.h3History].slice(0, H3_MAX_HISTORY);
      saveH3History(list);
      return { h3History: list };
    });
  },
  clearH3History: () => {
    saveH3History([]);
    set({ h3History: [] });
  },

  loadConfig: async () => {
    const config = await api.getConfig();
    set({ config });
  },
  updateConfig: async (patch) => {
    const cur = get().config;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ config: next });
    try {
      await api.saveConfig(next);
    } catch (e) {
      get().toast(`保存配置失败: ${e}`, "err");
    }
  },
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), 3600);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function dirsOf(config: AppConfig | null, kind: string): string[] {
  return config?.directories.find((d) => d.kind === kind)?.paths ?? [];
}
