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
  const [checkingAll, setCheckingAll] = useState(false);

  const deleteOne = async (p: GitStatus) => {
    try {
      await api.deletePlugin(p.path);
      toast(`已删除插件 ${p.name}（进回收站）`, "ok");
      setPlugins((ps) => ps.filter((x) => x.path !== p.path));
      log(`✓ ${p.name} 已删除`, "ok");
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
      log(`✗ ${p.name} 删除失败: ${e}`, "err");
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
      // 逐个取 git 状态（携带 scan 得到的 requirements 标记）
      const st: GitStatus[] = [];
      for (const p of base) {
        try {
          const s = await api.pluginStatus(p.path);
          st.push({ ...s, has_requirements: p.has_requirements });
        } catch {
          st.push({
            path: p.path, name: p.name, branch: "-", status: "error",
            behind: 0, ahead: 0, last_commit: "", last_commit_msg: "", has_remote: false,
            has_requirements: p.has_requirements,
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

  /** 仅联网检查（fetch 不更新），刷新真实 behind 状态 */
  const checkOne = async (p: GitStatus) => {
    setUpdating((u) => ({ ...u, [p.path]: true }));
    setShowLogs(true);
    log(`$ git -C ${p.name} fetch`, "cmd");
    try {
      const st = await api.pluginCheck(p.path);
      setPlugins((ps) => ps.map((x) => (x.path === p.path ? st : x)));
      if (st.behind > 0) {
        log(`⚠ ${p.name} 可更新：落后 ${st.behind} 个提交`, "warn");
        toast(`${p.name} 可更新（落后 ${st.behind} 个提交）`, "info");
      } else {
        log(`✓ ${p.name} 已是最新`, "ok");
      }
    } catch (e) {
      log(`✗ ${p.name} 检查失败: ${e}`, "err");
      toast(`${p.name} 检查失败`, "err");
    } finally {
      setUpdating((u) => ({ ...u, [p.path]: false }));
    }
  };

  const updateOne = async (p: GitStatus) => {
    setUpdating((u) => ({ ...u, [p.path]: true }));
    setShowLogs(true);
    log(`$ git -C ${p.name} pull --ff-only`, "cmd");
    try {
      const st = await api.pluginUpdate(p.path);
      setPlugins((ps) => ps.map((x) => (x.path === p.path ? st : x)));
      if (st.status === "up-to-date") {
        log(`✓ ${p.name} 已是最新`, "ok");
        toast(`${p.name} 已是最新`, "ok");
      } else {
        log(`✓ ${p.name} 更新完成 → ${st.status}`, "ok");
        toast(`${p.name} 更新完成`, "ok");
      }
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

  // 一键检查更新：逐个联网 fetch（不动本地代码），刷新真实状态，是否更新由用户决定
  const checkAll = async () => {
    const targets = plugins.filter((p) => p.has_remote);
    if (!targets.length) return;
    setCheckingAll(true);
    setShowLogs(true);
    log(`$ 一键检查更新：${targets.length} 个插件（仅 fetch，不更新本地）`, "cmd");
    for (const t of targets) {
      await checkOne(t);
    }
    log(`✓ 一键检查更新完成`, "ok");
    setCheckingAll(false);
  };

  // ── 添加插件 ──
  const [showAdd, setShowAdd] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);

  // git URL 克隆到当前目录
  const clonePlugin = async () => {
    if (!activeDir || !cloneUrl.trim()) return;
    setCloning(true);
    setShowLogs(true);
    log(`$ git clone ${cloneUrl.trim()}`, "cmd");
    try {
      const dest = await api.pluginClone(cloneUrl.trim(), activeDir);
      log(`✓ 已克隆到 ${dest}`, "ok");
      toast(`插件已克隆：${dest.split(/[\\/]/).pop()}`, "ok");
      setShowAdd(false);
      setCloneUrl("");
      await rescan();
    } catch (e) {
      log(`✗ 克隆失败: ${e}`, "err");
      toast(`克隆失败: ${e}`, "err");
    } finally {
      setCloning(false);
    }
  };

  // 已有文件夹移入 custom_nodes
  const addExistingFolder = async () => {
    if (!activeDir) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    try {
      const dest = await api.moveDirInto(sel, activeDir);
      log(`✓ 已移入 ${dest}`, "ok");
      toast("插件文件夹已移入", "ok");
      await rescan();
    } catch (e) {
      toast(`移入失败: ${e}`, "err");
    }
  };

  // 安装插件依赖（pip install -r requirements.txt，用设置里的 ComfyUI python）
  const installDeps = async (p: GitStatus) => {
    const py = config?.general?.comfyui_python ?? "";
    setShowLogs(true);
    setUpdating((u) => ({ ...u, [p.path]: true }));
    log(`$ pip install -r ${p.name}/requirements.txt`, "cmd");
    try {
      const out = await api.pluginInstallDeps(p.path, py);
      log(`✓ ${p.name} 依赖安装完成`, "ok");
      for (const line of out.trim().split("\n").slice(-8)) log(line);
      toast(`${p.name} 依赖安装完成`, "ok");
    } catch (e) {
      log(`✗ ${p.name} 依赖安装失败: ${e}`, "err");
      toast(`${p.name} 依赖安装失败（详见日志）`, "err");
    } finally {
      setUpdating((u) => ({ ...u, [p.path]: false }));
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
          <div className="desc">扫描 custom_nodes 中的 git 仓库；勾选批量更新、单插件检查 / 更新 / 装依赖 / 删除；所有操作进日志。</div>
        </div>
        <div className="right">
          <button className="btn btn-line btn-sm" onClick={() => setShowLogs((s) => !s)}>
            🕘 日志
          </button>
          <button className="btn btn-line btn-sm" onClick={() => setShowAdd(true)} disabled={!activeDir} title="git 克隆或移入已有插件文件夹">
            ＋ 添加插件
          </button>
          <button
            className="btn btn-soft btn-sm btn-primary"
            onClick={checkAll}
            disabled={checkingAll || loading || plugins.every((p) => !p.has_remote)}
            title="逐个联网检查全部插件（仅 fetch，不动本地代码），是否更新由用户决定"
          >
            {checkingAll ? "检查中…" : "⤓ 一键检查更新"}
          </button>
          <button className="btn btn-line btn-sm" onClick={updateSelected} disabled={selUpdatable === 0}>
            ⤓ 更新选中 ({selUpdatable})
          </button>
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "⟳ 扫描"}
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
          <button className="btn btn-line btn-sm" onClick={() => setSelected(new Set(plugins.map((p) => p.path)))}>全选</button>
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
        <div className="flow-stack" style={{ overflow: "auto", flex: 1, minHeight: 0, paddingBottom: 4 }}>
          {filtered.map((p) => {
            const s = STATUS_LABEL[p.status] ?? STATUS_LABEL.unknown;
            const armed = armDeletePath === p.path;
            return (
              <div key={p.path} className={`fc ${selected.has(p.path) ? "open" : ""}`}>
                <div className="fc-h" style={{ cursor: "default" }}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.path)}
                    onChange={() => toggleSelect(p.path)}
                    style={{ accentColor: "var(--c-cyan)", flex: "none" }}
                  />
                  <span className="fico">⚙</span>
                  <span className="fname">{p.name}</span>
                  <span className="fpath">{p.branch} · {p.last_commit}</span>
                  <div className="meta">
                    <span className={`pill ${s.cls}`}>
                      <i className="d" />
                      {s.label}
                    </span>
                    {(p.ahead > 0 || p.behind > 0) && (
                      <span className="badge">
                        +{p.ahead} / -{p.behind}
                      </span>
                    )}
                  </div>
                  <div className="h-ops">
                    <span
                      className="op"
                      onClick={() => void checkOne(p)}
                      style={{ opacity: !p.has_remote || updating[p.path] ? 0.4 : 1 }}
                      title="联网检查远程是否有新版本（不改动本地代码）"
                    >
                      {updating[p.path] ? "…" : "检查"}
                    </span>
                    <span
                      className="op"
                      onClick={() => void updateOne(p)}
                      style={{ opacity: p.status !== "behind" || updating[p.path] ? 0.4 : 1 }}
                      title={p.status === "behind" ? `拉取并更新（落后 ${p.behind} 个提交）` : "检查后若有新版本可更新"}
                    >
                      {updating[p.path] ? "更新中…" : "更新"}
                    </span>
                    {p.has_requirements && (
                      <span
                        className="op"
                        onClick={() => void installDeps(p)}
                        style={{ opacity: updating[p.path] ? 0.4 : 1 }}
                        title="用 ComfyUI Python 执行 pip install -r requirements.txt（Python 路径在 设置 → 通用 配置）"
                      >
                        {updating[p.path] ? "…" : "装依赖"}
                      </span>
                    )}
                    <span
                      className={`op del ${armed ? "armed" : ""}`}
                      onClick={() => {
                        if (!armed) {
                          setArmDeletePath(p.path);
                          setTimeout(() => setArmDeletePath((cur) => (cur === p.path ? "" : cur)), 3500);
                          return;
                        }
                        setArmDeletePath("");
                        void deleteOne(p);
                      }}
                      title="删除插件文件夹（进回收站）"
                    >
                      {armed ? "确认删除？" : "🗑 删除"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="empty card">
              <div className="big">⚙</div>
              <div className="tip">没有符合条件的插件。</div>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div className="modal-mask" onClick={() => !cloning && setShowAdd(false)}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3>添加插件</h3>
            <div className="desc" style={{ marginBottom: 12 }}>
              目标目录：{activeDir}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <div className="input" style={{ flex: 1 }}>
                <input
                  placeholder="https://github.com/xxx/ComfyUI-Plugin.git"
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void clonePlugin()}
                  autoFocus
                />
              </div>
              <button className="btn btn-soft btn-sm btn-primary" onClick={clonePlugin} disabled={cloning || !cloneUrl.trim()}>
                {cloning ? "克隆中…" : "克隆安装"}
              </button>
            </div>
            <div className="hint" style={{ marginBottom: 14 }}>
              公开仓库匿名克隆到 custom_nodes 下；克隆后可点「装依赖」安装 requirements.txt。
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-line btn-sm" onClick={addExistingFolder} disabled={cloning}>
                📁 移入已有文件夹
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)} disabled={cloning}>
                取消
              </button>
            </div>
          </div>
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
