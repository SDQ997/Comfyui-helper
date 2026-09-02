// Tauri command 类型封装
import { invoke as rawInvoke } from "@tauri-apps/api/core";

// ---- 操作日志埋点：每次 IPC 命令调用都会记录成功/失败到 logs（供「日志」页查看）----
// 排除日志系统自身的调用避免递归刷屏。
function skipLog(cmd: string): boolean {
  return (
    cmd.startsWith("log_") ||
    cmd.startsWith("frontend_") ||
    cmd === "get_config" ||
    cmd === "ffmpeg_status"
  );
}

function logOp(cmd: string, level: string, detail: string) {
  rawInvoke("log_emit", {
    source: "op",
    level,
    msg: `命令 ${cmd} ${detail}`,
  }).catch(() => {});
}

export const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const t0 = performance.now();
  try {
    const v = await rawInvoke<T>(cmd, args);
    if (!skipLog(cmd)) {
      const ms = Math.round(performance.now() - t0);
      logOp(cmd, "info", `→ 成功 (${ms}ms)`);
    }
    return v;
  } catch (e) {
    if (!skipLog(cmd)) {
      const ms = Math.round(performance.now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      logOp(cmd, "error", `→ 失败 (${ms}ms): ${msg.slice(0, 300)}`);
    }
    throw e;
  }
};

export interface ApiEndpoint {
  id: string;
  name: string;
  kind: "openai" | "anthropic" | "ollama" | string;
  base_url: string;
  api_key: string;
  model: string;
  timeout_secs: number;
}

export interface PromptTemplate { id: string; name: string; content: string; }
export interface Skill { id: string; name: string; content: string; enabled: boolean; }
export interface DirectoryGroup { kind: string; paths: string[]; }
export interface DonateConfig {
  wechat_qr: string; alipay_qr: string; afadian_url: string; show_donate_entry: boolean;
}
export interface AppConfig {
  endpoints: ApiEndpoint[];
  default_endpoint_id: string | null;
  templates: PromptTemplate[];
  skills: Skill[];
  directories: DirectoryGroup[];
  general: {
    language: string; minimize_to_tray: boolean; generate_thumbnails: boolean;
    hide_unmarked_assets: boolean; theme: string;
  };
  donate: DonateConfig;
}

export interface AssetEntry {
  path: string; name: string; kind: string; size: number; modified: number; hidden: boolean;
}
export interface LoraEntry {
  path: string; name: string; size: number; modified: number;
  has_txt: boolean; trigger_words: string[];
}
export interface GitStatus {
  path: string; name: string; branch: string; status: string;
  behind: number; ahead: number; last_commit: string; last_commit_msg: string; has_remote: boolean;
}
export interface VideoMeta {
  path: string; container: string; duration_secs: number; size: number; bitrate: number;
  width: number; height: number; fps: number; codec: string; pix_fmt: string;
  audio_codec: string | null; audio_sample_rate: number | null; audio_channels: number | null;
  frame_count: number | null; raw: unknown;
}
export interface ChatMessage { role: string; content: string; }
export interface LogItem {
  id: number; time: string; level: string; target: string; msg: string;
}

export const api = {
  // config
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (config: AppConfig) => invoke<void>("save_config", { config }),
  getDataDir: () => invoke<string>("get_data_dir"),
  // scan
  scanAssets: (dirs: string[]) => invoke<AssetEntry[]>("scan_assets", { dirs }),
  scanLoras: (dirs: string[]) => invoke<LoraEntry[]>("scan_loras", { dirs }),
  scanPlugins: (dir: string) => invoke<{ path: string; name: string }[]>("scan_plugins", { dir }),
  pluginStatus: (path: string) => invoke<GitStatus>("plugin_status", { path }),
  pluginUpdate: (path: string) => invoke<GitStatus>("plugin_update", { path }),
  // hidden assets
  hiddenList: () => invoke<string[]>("hidden_list"),
  hiddenAdd: (path: string) => invoke<string[]>("hidden_add", { path }),
  hiddenRemove: (path: string) => invoke<string[]>("hidden_remove", { path }),
  hiddenAddMany: (paths: string[]) => invoke<string[]>("hidden_add_many", { paths }),
  hiddenRemoveMany: (paths: string[]) => invoke<string[]>("hidden_remove_many", { paths }),
  // video thumbnail (returns local file path, wrap with convertFileSrc)
  videoThumbnail: (path: string) => invoke<string>("video_thumbnail", { path }),
  // asset delete (to recycle bin)
  deleteAsset: (path: string) => invoke<void>("delete_asset", { path }),
  // lora
  readTriggerWords: (loraPath: string) =>
    invoke<string[]>("read_trigger_words", { loraPath }),
  writeTriggerWords: (loraPath: string, words: string[]) =>
    invoke<string>("write_trigger_words", { loraPath, words }),
  // ffmpeg
  ffmpegStatus: () => invoke<{
    installed: boolean; source: string; ffmpeg_path: string; ffprobe_path: string;
    version: string; downloading: boolean; progress: number;
  }>("ffmpeg_status"),
  downloadFfmpeg: (mirror?: string) =>
    invoke<unknown>("download_ffmpeg", { mirror: mirror ?? null }),
  cancelFfmpeg: () => invoke<void>("cancel_download"),
  // video
  videoMetadata: (path: string) => invoke<VideoMeta>("video_metadata", { path }),
  extractFrames: (path: string, timestamps: number[], outDir: string) =>
    invoke<string[]>("extract_frames", { path, timestamps, outDir }),
  // prompt
  chatCompletion: (endpoint: ApiEndpoint, messages: ChatMessage[], temperature?: number) =>
    invoke<string>("chat_completion", { endpoint, messages, temperature: temperature ?? null }),
  // misc
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  // logs
  logFetch: (afterId: number) => invoke<LogItem[]>("log_fetch", { afterId }),
  logEmit: (source: string, level: string, msg: string) =>
    invoke<void>("log_emit", { source, level, msg }),
};

/** 资产文件转可在 webview 中展示的 URL（asset protocol 由 Tauri fs 插件处理） */
export async function assetUrl(path: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = (secs % 60).toFixed(1);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s.padStart(4, "0")}` : `${m}:${s.padStart(4, "0")}`;
}
