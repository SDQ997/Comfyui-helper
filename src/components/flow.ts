/** 折叠卡片流的数据构建：文件 + 目录列表 → 嵌套树 */

export interface FlowFile {
  rel_dir: string; // "/" 分隔，"" = 根
  name: string;
  size: number;
}

export interface FlowNode {
  rel: string; // "" = 根
  name: string;
  dirs: FlowNode[];
  files: FlowFile[]; // 直系文件
  directCount: number;
  totalCount: number; // 递归文件数
}

/** 从文件集合 + 目录 rel 列表（含空目录）构建以 root 为根的嵌套树 */
export function buildFlow(files: FlowFile[], dirRels: string[], rootName: string): FlowNode {
  const dirSet = new Set<string>(["", ...dirRels]);
  for (const f of files) {
    if (!f.rel_dir) continue;
    const parts = f.rel_dir.split("/");
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirSet.add(acc);
    }
  }

  const fileMap = new Map<string, FlowFile[]>();
  for (const f of files) {
    if (!fileMap.has(f.rel_dir)) fileMap.set(f.rel_dir, []);
    fileMap.get(f.rel_dir)!.push(f);
  }

  const build = (rel: string, name: string): FlowNode => {
    const prefix = rel ? `${rel}/` : "";
    const dirs: FlowNode[] = [];
    for (const d of dirSet) {
      if (d === rel || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.includes("/")) continue; // 只取直系
      dirs.push(build(d, rest));
    }
    dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const own = (fileMap.get(rel) ?? []).slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const totalCount = dirs.reduce((s, x) => s + x.totalCount, 0) + own.length;
    return { rel, name, dirs, files: own, directCount: own.length, totalCount };
  };

  return build("", rootName);
}

/** 收集树中全部目录 rel（用于展开全部/收起全部） */
export function allFlowRels(root: FlowNode): string[] {
  const out: string[] = [root.rel];
  const walk = (n: FlowNode) => n.dirs.forEach((d) => { out.push(d.rel); walk(d); });
  walk(root);
  return out;
}

/** 给整棵树的 rel 加前缀（根 rel="" → prefix），使多棵树的展开 key 互不冲突 */
export function prefixFlow(root: FlowNode, prefix: string): FlowNode {
  if (!prefix) return root;
  const walk = (n: FlowNode): FlowNode => ({
    ...n,
    rel: n.rel ? `${prefix}/${n.rel}` : prefix,
    dirs: n.dirs.map(walk),
  });
  return walk(root);
}
