// MiniMax H3 内置 skill：随软件打包，作为 MiniMax 助手页面的固定 system prompt
import skillMd from "./assets/h3/SKILL.md?raw";
import baseEn from "./assets/h3/base-en.txt?raw";
import refEn from "./assets/h3/ref-en.txt?raw";

export { skillMd, baseEn, refEn };

/** 组装 H3 system prompt：SKILL.md 主体 + 按输入模式追加对应参考指南 */
export function buildH3System(hasRefAssets: boolean): string {
  const head = `${skillMd.trim()}

You are executing this skill for the user. Follow it exactly.`;
  return hasRefAssets
    ? `${head}

=== Reference Guide (full-reference mode: Ref2VA — follow this when any Picture/Video/Audio reference is attached) ===

${refEn.trim()}`
    : `${head}

=== Base Guide (T2VA / I2VA / FL2VA / L2VA — follow this for base text/keyframe modes) ===

${baseEn.trim()}`;
}

/** 用户 prompt 开头的参数前缀，如 "16:9,15s," */
export function h3ParamPrefix(ratio: string, durationSec: number): string {
  return `${ratio},${Math.round(durationSec)}s,`;
}
