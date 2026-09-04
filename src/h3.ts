// MiniMax H3 内置 skill：随软件打包，作为 MiniMax 助手页面的固定 system prompt
import skillMd from "./assets/h3/SKILL.md?raw";
import baseEn from "./assets/h3/base-en.txt?raw";
import refEn from "./assets/h3/ref-en.txt?raw";

export { skillMd, baseEn, refEn };

/**
 * 模式 → 指南映射（严格遵循 skill 语义）：
 * - T2V / I2V / FL2V → Base 指南（base-en.txt）：输出 integrated_multimodal_description / overall_soundscape / non_diegetic_music
 *   （I2VA、FL2VA 是 base-en.txt 中明确定义的 base 关键帧模式，不是 Full-Reference）
 * - R2V → Full-Reference 指南（ref-en.txt）：输出六段结构 subject_definitions / summary /
 *   retention_analysis / detailed_description / overall_soundscape / non_diegetic_music
 */
const MODE_TASK: Record<string, string> = {
  T2V: `Generation mode: T2VA (text-to-video, base mode).
- No reference assets are attached. Build the complete audiovisual timeline from text.
- Output structure: exactly the three core fields in this order — integrated_multimodal_description, overall_soundscape, non_diegetic_music. No first-line alignment instruction.`,
  I2V: `Generation mode: I2VA (image-to-video, base mode).
- Exactly 1 reference image is attached to this message (the base64 image after the text). It is <Picture 1>: the actual first frame of the target video at 0.00 seconds, belonging to [Shot 1].
- Output structure: the FIRST line must be exactly "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced." — then one blank line — then the three core fields (integrated_multimodal_description / overall_soundscape / non_diegetic_music).
- Derive style, subjects, composition and scene anchors from <Picture 1>, then develop the action forward. Keep identity, clothing, colors and spatial relationships consistent.`,
  FL2V: `Generation mode: FL2VA (first-and-last-frame, base mode).
- Exactly 2 reference images are attached to this message in order: <Picture 1> anchors the 0.00-second opening, <Picture 2> anchors the final frame at the end of the video.
- Output structure: the FIRST line must be the FL2VA alignment instruction "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the S.SS-second mark of the target video." where S.SS is the requested duration formatted to exactly two decimals — then one blank line — then the three core fields.
- Describe the continuous path between the two frames. Favor a single shot so the model can interpolate continuously; the last frame must be reached by the end of the video.`,
  R2V: `Generation mode: Ref2VA (full-reference mode).
- Reference assets are attached / cited in the user prompt with these exact labels: <Picture N> (images), <Video N> (videos), <Audio N> (audio). Keep every label consistent across all sections; never leave a label undefined.
- Output structure: ALL SIX sections in this exact order — subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. The summary must begin with a square-bracketed task-type prefix (e.g. [reference generation + audio reference]).
- Make detailed_description explicit per shot (composition, subjects, environment, actions, camera, sound, and where each referenced asset appears) — never reduce it to a plot summary.`,
};

/** 组装 H3 system prompt：SKILL.md + 按生成模式追加对应指南 + Current Task 锁定输出结构 */
export function buildH3System(
  mode: "T2V" | "I2V" | "FL2V" | "R2V",
  opts?: { images?: number; videos?: number; audios?: number; duration?: number },
): string {
  const head = `${skillMd.trim()}

You are executing this skill for the user. Follow it exactly.`;
  const isRef = mode === "R2V";
  const guide = isRef ? refEn.trim() : baseEn.trim();
  const guideTitle = isRef
    ? "=== Reference Guide (full-reference mode: Ref2VA — follow this ONLY) ==="
    : "=== Base Guide (T2VA / I2VA / FL2VA / L2VA — follow this ONLY) ===";

  let task = MODE_TASK[mode] ?? MODE_TASK.T2V;
  if (opts) {
    const counts: string[] = [];
    if (mode === "R2V") {
      if (opts.images) counts.push(`${opts.images} image(s) labeled <Picture 1>…<Picture ${opts.images}>`);
      if (opts.videos) counts.push(`${opts.videos} video(s) labeled <Video 1>…<Video ${opts.videos}>`);
      if (opts.audios) counts.push(`${opts.audios} audio track(s) labeled <Audio 1>…<Audio ${opts.audios}>`);
    } else if (mode === "I2V") {
      counts.push(`1 image labeled <Picture 1> (sent as the attached image)`);
    } else if (mode === "FL2V") {
      counts.push(`2 images labeled <Picture 1> (first frame) and <Picture 2> (last frame), sent as the attached images in order`);
    }
    if (counts.length) task += `\n- Attached assets: ${counts.join("; ")}.`;
    if (opts.duration) {
      task += `\n- Requested duration: ${opts.duration} seconds. Every timestamp, cut time, and the S.SS alignment mark must fit within this duration.`;
    }
  }

  return `${head}

${guideTitle}

${guide}

=== Current Task ===

${task}

=== Label Mapping (user prompt → skill labels) ===

The user prompt may cite assets as <Picture N> / <Video N> / <Audio N> (already normalized). Use these exact labels in your output sections. Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.`;
}

/**
 * 用户 prompt 开头的参数前缀：mode,ratio,Ns[,首尾帧标注],
 * FL2V 动态标注：两张图 → 「图片1为首帧，图片2为尾帧」；只有一张 → 「图片1为首帧」
 */
export function h3ParamPrefix(mode: string, ratio: string, durationSec: number, imgCount = 2): string {
  const base = `${mode},${ratio},${Math.round(durationSec)}s,`;
  if (mode === "FL2V") {
    if (imgCount >= 2) return `${base}图片1为首帧，图片2为尾帧,`;
    if (imgCount === 1) return `${base}图片1为首帧,`;
    return base;
  }
  return base;
}
