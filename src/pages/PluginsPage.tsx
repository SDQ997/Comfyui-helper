import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, GitStatus } from "../api";

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  "up-to-date": { label: "已最新", cls: "ok" },
  behind: { label: "可更新", cls: "warn" },
  ahead: { label: "领先", cls: "cyan" },
  diverged: { label: "冲突", cls: "err" },
  "no-remote": { label: "无远程", cls: "" },
  "no-remote-branch": { label: "无远程分支", cls: "" },
  error: { label: "错误", cls: "err" },
  unknown: { label: "未检查", cls: "" },
};

export default function PluginsPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "plugins");
  const [dirIdx, setDirIdx] = useState(0);
  const [plugins, setPlugins] = useState<GitStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("all");
  const [logs, setLogs] = useState<{ text: string; cls: string }[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [armDeletePath, setArmDeletePath] = useState("");
  const [deleting, setDeleting] = useState(false);

  const deleteOne = async (p: GitStatus) => {
    setDeleting(true);
    try {
      await api.deletePlugin(p.path);
      toast(`已删除插件 ${p.name}（进回收站）`, "ok");
      setPlugins((ps) => ps.filter((x) => x.path !== p.path));
      log(`✓ ${p.name} 已删除`, "ok");
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
      log(`✗ ${p.name} 删除失败: ${e}`, "err");
    } finally {
      setDeleting(false);
    }
  };

  const activeDir = dirs[dirIdx] ?? "";

  const log = useCallback((text: string, cls = "") => {
    setLogs((ls) => [...ls.slice(-200), { text, cls }]);
  }, []);

  const rescan = useCallback(async () => {
    if (!activeDir) return;
    setLoading(true);
    try {
      const base = await api.scanPlugins(activeDir);
      // 逐个取 git 状态
      const st: GitStatus[] = [];
      for (const p of base) {
        try {
          st.push(await api.pluginStatus(p.path));
        } catch {
          st.push({
            path: p.path, name: p.name, branch: "-", status: "error",
            behind: 0, ahead: 0, last_commit: "", last_commit_msg: "", has_remote: false,
          });
        }
      }
      setPlugins(st);
      log(`扫描完成：${st.length} 个插件`, "ok");
    } catch (e) {
      toast(`扫描失败: ${e}`, "err");
    } finally {
      setLoading(false);
    }
  }, [activeDir, log]);

  useEffect(() => {
    rescan();
  }, [rescan]);

  const filtered = useMemo(() => {
    if (filter === "all") return plugins;
    return plugins.filter((p) => p.status === filter);
  }, [plugins, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: plugins.length };
    for (const p of plugins) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [plugins]);

  const addDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    const group = config?.directories.find((d) => d.kind === "plugins");
    const paths = group ? group.paths : [];
    if (paths.includes(sel)) return;
    await updateConfig({
      directories: [
        ...(config?.directories.filter((d) => d.kind !== "plugins") ?? []),
        { kind: "plugins", paths: [...paths, sel] },
      ],
    });
  };

  const updateOne = async (p: GitStatus) => {
    setUpdating((u) => ({ ...u, [p.path]: true }));
    setShowLogs(true);
    log(`$ git -C ${p.name} pull --ff-only`, "cmd");
    try {
      const st = await api.pluginUpdate(p.path);
      setPlugins((ps) => ps.map((x) => (x.path === p.path ? st : x)));
      log(`✓ ${p.name} 更新完成 → ${st.status}`, "ok");
      toast(`${p.name} 更新完成`, "ok");
    } catch (e) {
      log(`✗ ${p.name} 更新失败: ${e}`, "err");
      toast(`${p.name} 更新失败`, "err");
    } finally {
      setUpdating((u) => ({ ...u, [p.path]: false }));
    }
  };

  const updateSelected = async () => {
    const targets = plugins.filter((p) => selected.has(p.path) && p.status === "behind");
    for (const t of targets) {
      await updateOne(t);
    }
  };

  const toggleSelect = (path: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  const selUpdatable = plugins.filter((p) => selected.has(p.path) && p.status === "behind").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 150px)" }}>
      <div className="page-h">
        <div>
          <h1>
            插件管理 <span className="tag cyan">{plugins.length} 个</span>
          </h1>
          <div className="desc">扫描 custom_nodes 中的 git 仓库；批量更新、状态追踪、操作日志。</div>
        </div>
        <div className="right">
          <button className="btn btn-line btn-sm" onClick={() => setShowLogs((s) => !s)}>
            🕘 日志
          </button>
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "⟳ 扫描"}
          </button>
          <button className="btn btn-soft btn-sm btn-primary" onClick={updateSelected} disabled={selUpdatable === 0}>
            ⤓ 更新选中 ({selUpdatable})
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="dir-chips">
          {dirs.length === 0 && <span className="hint">尚未配置插件目录（custom_nodes）</span>}
          {dirs.map((d, i) => (
            <span key={d} className={`dc ${i === dirIdx ? "active" : ""}`} onClick={() => setDirIdx(i)} title={d}>
              {d}
            </span>
          ))}
          <button className="dc add" onClick={addDir}>＋ 添加目录</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="tabs">
          {["all", "behind", "up-to-date", "ahead", "diverged", "error"].map((k) => (
            <div key={k} className={`t ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
              {k === "all" ? "全部" : STATUS_LABEL[k]?.label ?? k} <span className="n">{counts[k] ?? 0}</span>
            </div>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--tx-3)", fontFamily: "var(--f-mono)" }}>
            已选 {selected.size} / {plugins.length}
          </span>
          <button className="btn btn-line btn-sm" onClick={() => setSelected(new Set(plugins.map((p) => p.path)))}>
            全选
          </button>
          <button
            className="btn btn-line btn-sm"
            onClick={() => setSelected(new Set(plugins.filter((p) => p.status === "behind").map((p) => p.path)))}
          >
            仅选可更新
          </button>
          <button className="btn btn-line btn-sm" onClick={() => setSelected(new Set())}>清空</button>
        </div>
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">⚙</div>
          <div className="tip">请先点击「＋ 添加目录」选择 ComfyUI 的 custom_nodes 目录。</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto", flex: 1 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>项目</th>
                <th style={{ width: 100 }}>状态</th>
                <th style={{ width: 110 }}>分支</th>
                <th style={{ width: 120 }}>领先 / 落后</th>
                <th style={{ width: 150 }}>最后提交</th>
                <th style={{ width: 170 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const s = STATUS_LABEL[p.status] ?? STATUS_LABEL.unknown;
                return (
                  <tr key={p.path}>
                    <td>
                      <input type="checkbox" checked={selected.has(p.path)} onChange={() => toggleSelect(p.path)} />
                    </td>
                    <td>
                      <div className="name">{p.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--tx-4)" }}>{p.path}</div>
                    </td>
                    <td>
                      <span className={`pill ${s.cls}`}>
                        <i className="d" />
                        {s.label}
                      </span>
                    </td>
                    <td className="mono">{p.branch}</td>
                    <td className="mono">
                      <span style={{ color: p.ahead > 0 ? "var(--c-cyan)" : "inherit" }}>+{p.ahead}</span>
                      {" / "}
                      <span style={{ color: p.behind > 0 ? "var(--c-amber)" : "inherit" }}>-{p.behind}</span>
                    </td>
                    <td className="mono" title={p.last_commit_msg}>
                      {p.last_commit}
                    </td>
                    <td>
                      <div className="row-ops">
                        <button
                          className="btn btn-line btn-sm"
                          onClick={() => updateOne(p)}
                          disabled={p.status !== "behind" || updating[p.path]}
                        >
                          {updating[p.path] ? "更新中…" : "更新"}
                        </button>
                        <button
                          className={`btn btn-sm btn-danger ${armDeletePath === p.path ? "armed" : "btn-danger-soft"}`}
                          disabled={deleting}
                          onClick={() => {
                            if (armDeletePath !== p.path) {
                              setArmDeletePath(p.path);
                              setTimeout(() => {
                                setArmDeletePath((cur) => (cur === p.path ? "" : cur));
                              }, 3500);
                              return;
                            }
                            setArmDeletePath("");
                            void deleteOne(p);
                          }}
                          title="删除插件文件夹（进回收站）"
                        >
                          {armDeletePath === p.path ? "确认删除？" : "🗑"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showLogs && (
        <div className="log-drawer">
          {logs.map((l, i) => (
            <div key={i} className={`ln ${l.cls}`}>
              {l.text}
            </div>
          ))}
          {logs.length === 0 && <div className="ln" style={{ color: "var(--tx-4)" }}>暂无日志</div>}
        </div>
      )}
    </div>
  );
}
