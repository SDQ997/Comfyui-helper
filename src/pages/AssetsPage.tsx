import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, dirsOf } from "../store";
import { api, AssetEntry, assetUrl, fmtSize, fmtTime } from "../api";

const KIND_TABS = [
  { key: "all", label: "全部" },
  { key: "video", label: "视频" },
  { key: "image", label: "图片" },
  { key: "text", label: "文本" },
  { key: "audio", label: "音频" },
];

const KIND_ICO: Record<string, string> = { video: "▶", image: "▣", audio: "♪", text: "≡" };

export default function AssetsPage() {
  const { config, updateConfig, toast } = useStore();
  const dirs = dirsOf(config, "assets");
  const [dirIdx, setDirIdx] = useState(0);
  const [tab, setTab] = useState("all");
  const [viewHidden, setViewHidden] = useState(false); // true=已隐藏列表
  const [entries, setEntries] = useState<AssetEntry[]>([]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<AssetEntry | null>(null);
  const [armDelete, setArmDelete] = useState(false);

  const activeDir = dirs[dirIdx] ?? "";

  const rescan = useCallback(async () => {
    if (!activeDir) return;
    setLoading(true);
    try {
      const list = await api.scanAssets([activeDir]);
      setEntries(list);

      // ffmpeg 是否可用：不可用则全部视频跳过抽帧（用原生 video 首帧兜底），避免刷屏
      let ffAvailable = false;
      try {
        const st = await api.ffmpegStatus();
        ffAvailable = !!st.installed;
      } catch {
        ffAvailable = false;
      }

      // 所有资产的原地址（预览/播放用）+ 图片直接用原图做缩略图
      const mUrls: Record<string, string> = {};
      const tUrls: Record<string, string> = {};
      const jobs: Promise<void>[] = [];
      for (const e of list) {
        jobs.push(
          assetUrl(e.path)
            .then((u) => { mUrls[e.path] = u; })
            .catch(() => {})
        );
        if (e.kind === "image") {
          jobs.push(
            assetUrl(e.path)
              .then((u) => { tUrls[e.path] = u; })
              .catch(() => {})
          );
        } else if (e.kind === "video" && ffAvailable) {
          // 视频首帧缩略图（需 ffmpeg；失败则退回原生 video 首帧）
          jobs.push(
            api
              .videoThumbnail(e.path)
              .then(assetUrl)
              .then((u) => { tUrls[e.path] = u; })
              .catch(() => {})
          );
        }
      }
      await Promise.all(jobs);
      setThumbUrls(tUrls);
      setMediaUrls(mUrls);
    } catch (e) {
      toast(`扫描失败: ${e}`, "err");
    } finally {
      setLoading(false);
    }
  }, [activeDir]);

  useEffect(() => {
    rescan();
  }, [rescan]);

  // 计数（按标签）
  const totalCounts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);

  const hiddenCounts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const e of entries)
      if (e.hidden) {
        c.all += 1;
        c[e.kind] = (c[e.kind] ?? 0) + 1;
      }
    return c;
  }, [entries]);

  // 未隐藏数（供「全部隐藏」按钮计数）
  const unhiddenCount = (k: string) =>
    (totalCounts[k] ?? 0) - (hiddenCounts[k] ?? 0);

  const badge = (k: string) => (viewHidden ? hiddenCounts[k] ?? 0 : totalCounts[k] ?? 0);

  // 列表逻辑：
  // - 常规视图：显示全部资产；其中 hidden 的缩略图模糊 + 角标「已隐藏」
  // - 已隐藏视图：只列 hidden 项（便于批量恢复）
  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (tab !== "all" && e.kind !== tab) return false;
        if (viewHidden) return e.hidden;
        return true;
      }),
    [entries, tab, viewHidden]
  );

  // ---- 隐藏 / 恢复 ----
  const mutateHidden = async (paths: string[], hide: boolean) => {
    try {
      if (hide) await api.hiddenAddMany(paths);
      else await api.hiddenRemoveMany(paths);
      await rescan();
    } catch (e) {
      toast(`操作失败: ${e}`, "err");
    }
  };

  const hideOne = (p: string) => mutateHidden([p], true);
  const restoreOne = (p: string) => mutateHidden([p], false);

  // 全部隐藏：当前标签下的所有可见资产
  const hideAllVisible = async () => {
    const targets = entries.filter((e) => !e.hidden && (tab === "all" || e.kind === tab));
    if (!targets.length) return;
    await mutateHidden(targets.map((e) => e.path), true);
    toast(`已隐藏 ${targets.length} 项`, "ok");
  };

  const restoreAllHidden = async () => {
    const targets = entries.filter((e) => e.hidden && (tab === "all" || e.kind === tab));
    if (!targets.length) return;
    await mutateHidden(targets.map((e) => e.path), false);
    toast(`已恢复 ${targets.length} 项`, "ok");
  };

  // 删除：移入回收站，随后重扫并清理缓存 URL
  const deleteAsset = async (path: string) => {
    try {
      await api.deleteAsset(path);
      toast("已删除（移入系统回收站）", "ok");
      setThumbUrls((m) => {
        const n = { ...m };
        delete n[path];
        return n;
      });
      setMediaUrls((m) => {
        const n = { ...m };
        delete n[path];
        return n;
      });
      await rescan();
    } catch (e) {
      toast(`删除失败: ${e}`, "err");
    }
  };

  const addDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    const group = config?.directories.find((d) => d.kind === "assets");
    const paths = group ? group.paths : [];
    if (paths.includes(sel)) return;
    await updateConfig({
      directories: [
        ...(config?.directories.filter((d) => d.kind !== "assets") ?? []),
        { kind: "assets", paths: [...paths, sel] },
      ],
    });
  };

  const renderThumb = (e: AssetEntry) => {
    const u = thumbUrls[e.path];
    if (u) return <img src={u} alt={e.name} loading="lazy" className="asset-thumb-img" />;
    // 视频无 ffmpeg 首帧时：用原生 video 元素取首帧。仅当视频总数少时启用，
    // 避免一次渲染上千个 video 元素卡 UI；数量大时安装 ffmpeg 后自动有缩略图。
    if (
      e.kind === "video" &&
      mediaUrls[e.path] &&
      entries.filter((x) => x.kind === "video").length <= 200
    ) {
      return (
        <video
          src={mediaUrls[e.path]}
          muted
          playsInline
          preload="metadata"
          className="video-thumb"
        />
      );
    }
    // 未就绪占位（避免闪烁）：图标 + 缩略图生成中提示
    return (
      <span className="thumb-ph">
        <span className="kind-ico">{KIND_ICO[e.kind] ?? "·"}</span>
        {e.kind === "video" && <span className="ph-tip">生成缩略图中…</span>}
      </span>
    );
  };

  const videoUrl = (p: string) => mediaUrls[p];

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>资产管理</h1>
          <div className="desc">
            多目录聚合展示视频 / 图片 / 文本 / 音频资产。「隐藏」将资产内容模糊展示（保留在列表中，可随时恢复）；
            右上角 ✕ 隐藏单项，工具栏可一键全部隐藏 / 恢复。
          </div>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={rescan} disabled={loading || !activeDir}>
            {loading ? "扫描中…" : "⟳ 重新扫描"}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="dir-chips">
          {dirs.length === 0 && <span className="hint">尚未配置资产目录</span>}
          {dirs.map((d, i) => (
            <span
              key={d}
              className={`dc ${i === dirIdx ? "active" : ""}`}
              onClick={() => setDirIdx(i)}
              title={d}
            >
              {d}
            </span>
          ))}
          <button className="dc add" onClick={addDir} title="添加目录">
            ＋ 添加目录
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="tabs">
          {KIND_TABS.map((t) => (
            <div key={t.key} className={`t ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label} <span className="n">{badge(t.key)}</span>
            </div>
          ))}
        </div>
        <div className="seg">
          <div className={`b ${!viewHidden ? "active" : ""}`} onClick={() => setViewHidden(false)}>
            资产
          </div>
          <div className={`b ${viewHidden ? "active" : ""}`} onClick={() => setViewHidden(true)}>
            已隐藏 <span className="n">{hiddenCounts.all}</span>
          </div>
        </div>
        <div className="spacer" />
        {!viewHidden ? (
          // 状态化切换：当前标签下存在已隐藏项 → 显示「全部显示」；否则显示「全部隐藏」
          hiddenCounts[tab] > 0 ? (
            <button
              className="btn btn-line btn-sm"
              onClick={restoreAllHidden}
              disabled={hiddenCounts[tab] === 0}
              title="恢复当前标签下所有已隐藏资产"
            >
              ⇪ 全部显示{hiddenCounts[tab] ? ` (${hiddenCounts[tab]})` : ""}
            </button>
          ) : (
            <button
              className="btn btn-line btn-sm"
              onClick={hideAllVisible}
              disabled={unhiddenCount(tab) === 0}
              title="将当前标签下所有资产设为模糊展示"
            >
              ⤓ 全部隐藏{unhiddenCount(tab) > 0 ? ` (${unhiddenCount(tab)})` : ""}
            </button>
          )
        ) : (
          <button
            className="btn btn-line btn-sm"
            onClick={restoreAllHidden}
            disabled={hiddenCounts[tab] === 0}
            title="恢复当前标签下所有模糊资产"
          >
            ⇪ 全部恢复{hiddenCounts[tab] ? ` (${hiddenCounts[tab]})` : ""}
          </button>
        )}
      </div>

      {dirs.length === 0 ? (
        <div className="empty card">
          <div className="big">▦</div>
          <div className="tip">
            请先点击「＋ 添加目录」选择资产根目录，应用将递归扫描视频 / 图片 / 文本 / 音频文件。
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty card">
          <div className="big">◌</div>
          <div className="tip">
            {viewHidden
              ? "当前标签下没有已隐藏的资产"
              : tab === "all"
              ? "当前目录没有资产文件"
              : `当前目录没有${KIND_TABS.find((t) => t.key === tab)?.label}资产`}
          </div>
        </div>
      ) : (
        <div className="asset-grid">
          {filtered.map((e) => (
            <div
              key={e.path}
              className={`asset-card ${e.hidden ? "hidden-asset" : ""}`}
              onClick={() => setPreview(e)}
            >
              <div className="asset-thumb">
                {renderThumb(e)}
                {e.hidden && <span className="hide-mark">已隐藏 · 模糊</span>}
              </div>
              <div className="a-ops">
                {e.hidden ? (
                  <div
                    className="a-op ok"
                    title="恢复显示"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void restoreOne(e.path);
                    }}
                  >
                    👁
                  </div>
                ) : (
                  <div
                    className="a-op danger"
                    title="隐藏（模糊展示）"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void hideOne(e.path);
                    }}
                  >
                    ✕
                  </div>
                )}
                <div
                  className="a-op danger"
                  title="删除（移入回收站）"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setArmDelete(true);
                    setPreview(e);
                    setTimeout(() => setArmDelete(false), 3500);
                  }}
                >
                  🗑
                </div>
              </div>
              <div className="a-name" title={e.name}>
                {e.name}
              </div>
              <div className="a-meta">
                <span>{fmtSize(e.size)}</span>
                <span>{fmtTime(e.modified)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <div className="modal" style={{ width: 720 }} onClick={(ev) => ev.stopPropagation()}>
            <h2>
              {preview.name}
              {preview.hidden && <span className="pill warn" style={{ marginLeft: 8 }}>已隐藏</span>}
            </h2>
            {preview.kind === "image" && thumbUrls[preview.path] && (
              <img src={thumbUrls[preview.path]} style={{ width: "100%", borderRadius: 8 }} alt="" />
            )}
            {preview.kind === "video" && (
              <video src={videoUrl(preview.path)} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />
            )}
            {preview.kind === "audio" && mediaUrls[preview.path] && (
              <audio src={mediaUrls[preview.path]} controls style={{ width: "100%" }} />
            )}
            {preview.kind === "text" && <TextView path={preview.path} />}
            <div className="meta-kv" style={{ marginTop: 12 }}>
              <span className="k">路径</span>
              <span className="v">{preview.path}</span>
              <span className="k">类型</span>
              <span className="v">{preview.kind}</span>
              <span className="k">大小</span>
              <span className="v">{fmtSize(preview.size)}</span>
              <span className="k">修改时间</span>
              <span className="v">{fmtTime(preview.modified)}</span>
            </div>
            <div className="m-ops">
              {preview.hidden ? (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    void restoreOne(preview.path);
                    setPreview(null);
                  }}
                >
                  👁 恢复显示
                </button>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void hideOne(preview.path);
                    setPreview(null);
                  }}
                >
                  ✕ 隐藏（模糊）
                </button>
              )}
              <button
                className={`btn btn-sm ${armDelete ? "btn-danger" : "btn-ghost"}`}
                onClick={() => {
                  if (!armDelete) {
                    setArmDelete(true);
                    setTimeout(() => setArmDelete(false), 3500);
                    return;
                  }
                  setArmDelete(false);
                  void deleteAsset(preview.path);
                  setPreview(null);
                }}
              >
                {armDelete ? "⚠ 再次点击确认删除" : "🗑 删除（到回收站）"}
              </button>
              <button className="btn btn-line" onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 文本预览：后端读取前 N KB */
function TextView({ path }: { path: string }) {
  const [text, setText] = useState("加载中…");
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .readTextFile(path)
      .then((t) => setText(t.length > 20000 ? t.slice(0, 20000) + "\n…（内容过长，仅显示前 20000 字）" : t))
      .catch((e) => {
        setErr(String(e));
        setText("");
      });
  }, [path]);
  if (err) return <div className="txt-preview warn">预览失败：{err}</div>;
  return (
    <pre
      className="txt-preview"
      style={{
        background: "var(--bg-3)", borderRadius: 8, padding: 12, maxHeight: 320,
        overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
        fontSize: 11.5, fontFamily: "var(--f-mono)", color: "var(--tx-2)",
      }}
    >
      {text}
    </pre>
  );
}
