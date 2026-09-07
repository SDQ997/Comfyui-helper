/** ComfyUI 报错监控：错误块解析 + 上下文提取 + 持久化（localStorage，容量封顶） */

export interface ComfyError {
  id: string; // prompt_id（执行错误）或内容 hash（日志错误）
  first_seen: string; // ISO 时间
  last_seen: string;
  count: number;
  kind: "exec" | "log"; // exec = history 结构化错误；log = 仅从控制台日志识别
  summary: string; // 一行摘要（列表展示）
  node_type: string;
  node_id: string;
  exception_type: string;
  exception_message: string;
  traceback: string[];
  context: string[]; // 错误前的日志上下文
  node_inputs: { name: string; value: string }[];
  analysis?: string; // AI 分析结果
  analyzed_at?: string;
}

const LS_KEY = "comfyui_monitor_errors_v1";
const MAX_KEEP = 200;

export const DEFAULT_BASE = "http://127.0.0.1:8188";

export const DEFAULT_ANALYSIS_PROMPT = `你是 ComfyUI 排错助手。根据用户提供的报错上下文（异常类型与消息、错误堆栈、报错前的日志、出错节点的输入参数），用简体中文给出简洁、易懂、可操作的结论。

输出结构（严格遵守）：

【结论】用大白话一两句话说明出了什么问题、直接原因是什么。避免堆砌术语；张量维度、堆栈行号等证据一笔带过即可。
【怎么解决】按"最简单、最可能有效"优先给出 1~3 步。判断时优先考虑这些常见对应关系：
- 权重/特征维度不匹配、架构不符 → 明确指出"应换用与 XX 兼容的模型/文本编码器"（如指出来源架构家族更好）
- 显存不足（OOM）→ 降低分辨率/批量数，或换量化版（fp8/gguf）
- 文件/路径不存在 → 指出缺什么文件、应放到哪个目录
- 节点缺失/导入失败 → 指出缺哪个自定义节点包、如何安装
- 参数取值非法 → 指出哪个参数、应改成什么
【其他可能】可选；仅在有依据时列出，最多 2 条。
【置信度】高 / 中 / 低。

硬性规则：
- 严禁输出"重新下载模型""清理缓存并重启""更新 ComfyUI 到最新版"这类无差别模板建议——除非报错证据直接指向该原因（如文件校验失败、明确的版本 bug）。
- 不要整段复述堆栈；引用证据不超过一行。
- 【结论】与【怎么解决】合计不超过 250 字，宁短勿长。
- 如果上下文信息不足以定位，在【结论】里直说，并列出还缺什么信息（如：具体用的哪个模型文件、哪个节点报错）。`;

export const LS_PROMPT_KEY = "comfyui_monitor_analysis_prompt";

export function loadErrors(): ComfyError[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as ComfyError[];
    // 旧记录迁移：清洗 ANSI 脏字符
    return list.map((e) => ({
      ...e,
      summary: cleanLine(e.summary ?? ""),
      exception_type: cleanLine(e.exception_type ?? ""),
      exception_message: cleanLine(e.exception_message ?? ""),
      traceback: (e.traceback ?? []).map(cleanLine),
      context: (e.context ?? []).map(cleanLine),
    }));
  } catch {
    return [];
  }
}

export function saveErrors(list: ComfyError[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_KEEP)));
  } catch { /* 存储满则放弃最旧的 */ }
}

/** 简易内容 hash（用于日志型错误去重） */
export function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const TRACEBACK_START = /Traceback \(most recent call last\):/;
const BLOCK_START = [
  TRACEBACK_START,
  /!!! Exception during processing !!!/,
  /Error occurred when executing/,
  /CUDA out of memory/i,
  /Prompt execution error/i,
];

/** 兜底剥离 ANSI 转义（Rust 侧已剥离，此处防残留）+ 去掉 [ERROR] 之类级别标签 */
function cleanLine(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/(\[[A-Z]+\]\s*)+/g, "")
    .replace(/\n$/, "");
}

function looksLikeTracebackBody(line: string): boolean {
  return (
    /^\s/.test(line) ||
    /^During handling /.test(line) ||
    /^(?:[\w.]+(?:Error|Exception|Interrupt|Warning))(?::|$)/.test(line.trim()) ||
    line.includes("Error") ||
    line.includes("Exception")
  );
}

export interface RawLine {
  t: string;
  m: string;
}

/**
 * 从原始日志行中提取错误块。
 * 返回本轮新识别的错误（调用方负责去重合并），context 取错误块之前的 before 行。
 */
export function extractLogErrors(all: RawLine[], prevCount: number, before = 15): ComfyError[] {
  const fresh = all.slice(Math.max(0, Math.min(prevCount, all.length)));
  if (fresh.length === 0) return [];
  const startIdxAll = all.length - fresh.length;
  const out: ComfyError[] = [];
  let i = 0;
  while (i < fresh.length) {
    const line = fresh[i].m;
    if (BLOCK_START.some((re) => re.test(line))) {
      const isTrace = TRACEBACK_START.test(line);
      // 收集错误块主体
      const block: RawLine[] = [fresh[i]];
      let j = i + 1;
      while (j < fresh.length && block.length < 50) {
        const l = fresh[j].m;
        if (isTrace ? looksLikeTracebackBody(l) : BLOCK_START.some((re) => re.test(l)) || looksLikeTracebackBody(l)) {
          block.push(fresh[j]);
          // 异常行（非缩进的 xxxError: msg）之后再收一行就停（Traceback 已到顶）
          if (isTrace && !/^\s/.test(l)) {
            j++;
            break;
          }
          j++;
        } else break;
      }
      const absStart = startIdxAll + i;
      const context = all.slice(Math.max(0, absStart - before), absStart).map((r) => cleanLine(r.m));
      const traceback = block.map((r) => cleanLine(r.m));
      const body = traceback.join("\n");
      // 摘要：优先 "!!! Exception during processing !!!" 的下一行，其次异常消息行
      const bangIdx = traceback.findIndex((l) => l.includes("!!! Exception during processing !!!"));
      const excLine =
        (bangIdx >= 0 && bangIdx + 1 < traceback.length ? traceback[bangIdx + 1] : "") ||
        [...traceback].reverse().find((l) => /^(?:[\w.]+(?:Error|Exception))(?::)\s*.+/.test(l.trim())) ||
        traceback[0];
      let sum = (excLine ?? traceback[0]).trim();
      if (/^Traceback/.test(sum)) {
        const errLine = traceback.find((l) => /(Error|Exception)\b[: ]/.test(l) && !/^Traceback/.test(l));
        if (errLine) sum = errLine.trim();
      }
      out.push({
        id: "log-" + hashStr(body.slice(0, 400)),
        first_seen: block[0].t || new Date().toISOString(),
        last_seen: block[0].t || new Date().toISOString(),
        count: 1,
        kind: "log",
        summary: sum.slice(0, 140),
        node_type: "",
        node_id: "",
        exception_type: (excLine?.trim().split(":")[0] ?? "").trim(),
        exception_message: (excLine ?? "").trim(),
        traceback,
        context,
        node_inputs: [],
      });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** 组装发给 AI 的用户消息（仅报错上下文，不附带完整工作流） */
export function buildAnalysisBody(e: ComfyError): string {
  const parts: string[] = [];
  parts.push(`== 报错时间 ==\n${e.first_seen}`);
  if (e.kind === "exec") {
    parts.push(`== 异常类型 ==\n${e.exception_type || "（未提供）"}`);
    parts.push(`== 异常消息 ==\n${e.exception_message || "（未提供）"}`);
    parts.push(`== 出错节点 ==\n${e.node_type}（节点 #${e.node_id}）`);
    if (e.node_inputs.length) {
      const inputs = e.node_inputs
        .slice(0, 40)
        .map((i) => `  ${i.name}: ${i.value}`)
        .join("\n");
      parts.push(`== 出错节点输入参数 ==\n${inputs}`);
    }
  }
  if (e.traceback.length) {
    parts.push(`== 错误堆栈 ==\n${e.traceback.slice(0, 60).join("\n")}`);
  }
  if (e.context.length) {
    parts.push(`== 报错前的日志上下文 ==\n${e.context.slice(-30).join("\n")}`);
  }
  return parts.join("\n\n");
}
