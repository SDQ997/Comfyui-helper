import { create } from "zustand";
import { api, AppConfig } from "./api";

interface Toast { id: number; text: string; kind: "ok" | "err" | "info"; }

interface Store {
  config: AppConfig | null;
  page: string;
  toasts: Toast[];
  setPage: (p: string) => void;
  loadConfig: () => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useStore = create<Store>((set, get) => ({
  config: null,
  page: "prompt",
  toasts: [],
  setPage: (page) => set({ page }),
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
