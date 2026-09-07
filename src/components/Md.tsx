import { ReactNode } from "react";

/**
 * 轻量 Markdown 渲染（AI 输出展示用）：支持标题、加粗、行内代码、代码块、
 * 无序/有序列表、分隔线、段落。React 文本节点自动转义，无 XSS 风险。
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    const key = `${keyBase}-${i}`;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return <strong key={key}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return <code key={key}>{p.slice(1, -1)}</code>;
    }
    return <span key={key}>{p}</span>;
  });
}

export default function Md({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      blocks.push(
        <pre key={k++} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|—{2,})\s*$/.test(line)) {
      blocks.push(<hr key={k++} className="md-hr" />);
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(
        <div key={k++} className="md-h">
          {inline(h[2], `h${k}`)}
        </div>
      );
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={k++} className="md-ul">
          {items.map((it, n) => (
            <li key={n}>{inline(it, `ul${k}-${n}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表（含 ①②③ 等中文序号开头）
    if (/^\s*(\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*(\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(\d+[.、)]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/, ""));
        i++;
      }
      blocks.push(
        <ol key={k++} className="md-ol">
          {items.map((it, n) => (
            <li key={n}>{inline(it, `ol${k}-${n}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落
    blocks.push(
      <div key={k++} className="md-p">
        {inline(line, `p${k}`)}
      </div>
    );
    i++;
  }

  return <div className="md">{blocks}</div>;
}
