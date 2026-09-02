import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api, VideoMeta, assetUrl, fmtSize, fmtDuration } from "../api";

type Mode = "compare" | "stack"; // 对比（左右滑块） | 堆叠（上下）
type Fit = "contain" | "cover"; // 适应（等比留黑边） | 填充（裁切对齐）

export default function VideoPage() {
  const { toast } = useStore();
  const [fileA, setFileA] = useState("");
  const [fileB, setFileB] = useState("");
  const [metaA, setMetaA] = useState<VideoMeta | null>(null);
  const [metaB, setMetaB] = useState<VideoMeta | null>(null);
  const [urlA, setUrlA] = useState("");
  const [urlB, setUrlB] = useState("");
  const [mode, setMode] = useState<Mode>("compare");
  const [fit, setFit] = useState<Fit>("contain");
  const [slider, setSlider] = useState(50);
  const [ffStatus, setFfStatus] = useState<{ installed: boolean; version: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    api.ffmpegStatus().then(setFfStatus).catch(() => setFfStatus({ installed: false, version: "" }));
  }, []);

  // 元数据就绪后设定时间轴范围
  useEffect(() => {
    const d = Math.max(metaA?.duration_secs ?? 0, metaB?.duration_secs ?? 0);
    setDuration(d);
    setTime(0);
    setPlaying(false);
    if (videoARef.current) videoARef.current.pause();
    if (videoBRef.current) videoBRef.current.pause();
  }, [metaA, metaB]);

  const pick = useCallback(
    async (which: "a" | "b") => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({
        multiple: false,
        filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov", "avi"] }],
      });
      if (typeof sel !== "string") return;
      try {
        const meta = await api.videoMetadata(sel);
        const url = await assetUrl(sel);
        // 重选视频：先暂停并复位时间轴，避免旧播放状态残留
        if (videoARef.current) videoARef.current.pause();
        if (videoBRef.current) videoBRef.current.pause();
        setPlaying(false);
        setTime(0);
        if (which === "a") {
          setFileA(sel);
          setMetaA(meta);
          setUrlA(url);
        } else {
          setFileB(sel);
          setMetaB(meta);
          setUrlB(url);
        }
      } catch (e) {
        toast(`读取视频信息失败: ${e}`, "err");
      }
    },
    [toast]
  );

  // ---- 统一控制（联动两路）----
  const togglePlay = () => {
    const vs = [videoARef.current, videoBRef.current].filter(Boolean) as HTMLVideoElement[];
    if (!vs.length) return;
    if (playing) {
      vs.forEach((v) => v.pause());
      setPlaying(false);
    } else {
      // 已到结尾则从头开始
      vs.forEach((v) => {
        if (v.ended || v.currentTime >= (v.duration || 0) - 0.05) v.currentTime = 0;
      });
      const p = vs.map((v) => v.play()).filter((x) => x && typeof (x as Promise<void>).catch === "function");
      Promise.all(p).catch(() => {});
      setPlaying(true);
    }
  };
  const toggleMute = () => {
    const next = !muted;
    if (videoARef.current) videoARef.current.muted = next;
    if (videoBRef.current) videoBRef.current.muted = next;
    setMuted(next);
  };

  const syncTime = (t: number) => {
    setTime(t);
    if (videoARef.current) videoARef.current.currentTime = t;
    if (videoBRef.current) videoBRef.current.currentTime = t;
    // 拖动时间轴视为手动定位，暂停联动播放
    if (playing) {
      setPlaying(false);
      if (videoARef.current) videoARef.current.pause();
      if (videoBRef.current) videoBRef.current.pause();
    }
  };

  // 视频结束时更新 playing 状态（两端都结束后）
  const onEnded = () => setPlaying(false);

  const onPointer = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSlider(Math.min(100, Math.max(0, pct)));
  };

  const Meta = ({ m, label }: { m: VideoMeta | null; label: string }) =>
    m ? (
      <div className="card">
        <h3>
          <span className="num">{label}</span> {m.path.split(/[\\/]/).pop()}
        </h3>
        <div className="meta-kv">
          <span className="k">分辨率</span>
          <span className="v">{m.width} × {m.height}</span>
          <span className="k">帧率</span>
          <span className="v">{m.fps.toFixed(2)} fps</span>
          <span className="k">时长</span>
          <span className="v">{fmtDuration(m.duration_secs)}</span>
          <span className="k">帧数</span>
          <span className="v">{m.frame_count ?? "-"}</span>
          <span className="k">编码</span>
          <span className="v">{m.codec} / {m.pix_fmt}</span>
          <span className="k">码率</span>
          <span className="v">{(m.bitrate / 1000).toFixed(0)} kbps</span>
          <span className="k">容器</span>
          <span className="v">{m.container}</span>
          <span className="k">大小</span>
          <span className="v">{fmtSize(m.size)}</span>
          {m.audio_codec && (
            <>
              <span className="k">音频</span>
              <span className="v">
                {m.audio_codec} · {m.audio_sample_rate ?? "-"} Hz · {m.audio_channels ?? "-"}ch
              </span>
            </>
          )}
        </div>
      </div>
    ) : null;

  const bothLoaded = !!urlA && !!urlB;

  // 对比框宽高比：跟随视频 A（未选时 16:9）；比例不一致时提示用填充模式对齐
  const arA = metaA && metaA.width > 0 ? metaA.width / metaA.height : 16 / 9;
  const ratioMismatch =
    metaA && metaB && Math.abs(metaA.width / metaA.height - metaB.width / metaB.height) > 0.01;
  const objectFit = fit;

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>视频分析</h1>
          <div className="desc">
            双视频对比 / 堆叠分析，输出完整元数据。选好视频后点「播放」两路同步开始（需
            ffmpeg，首次使用会引导下载）。
          </div>
        </div>
      </div>

      {ffStatus && !ffStatus.installed && (
        <div className="empty card" style={{ marginBottom: 14 }}>
          <div className="big">⚠</div>
          <div className="tip">
            未检测到 ffmpeg。请前往 <b>设置 → FFmpeg</b> 一键下载安装后使用视频分析功能。
          </div>
        </div>
      )}

      <div className="va-layout">
        <div className="va-main">
          <div className="toolbar">
            <div className="seg" style={{ marginRight: 4 }}>
              <div className={`b ${mode === "compare" ? "active" : ""}`} onClick={() => setMode("compare")}>
                ◐ 对比
              </div>
              <div className={`b ${mode === "stack" ? "active" : ""}`} onClick={() => setMode("stack")}>
                ☰ 堆叠
              </div>
            </div>
            {mode === "compare" && (
              <div className="seg" style={{ marginRight: 4 }} title="比例不一致时的对齐方式：填充=裁切对齐无黑边，适应=等比完整显示">
                <div className={`b ${fit === "cover" ? "active" : ""}`} onClick={() => setFit("cover")}>
                  填充
                </div>
                <div className={`b ${fit === "contain" ? "active" : ""}`} onClick={() => setFit("contain")}>
                  适应
                </div>
              </div>
            )}
            <button className="btn btn-line btn-sm" onClick={() => pick("a")} title="重新选择会替换当前视频 A 并暂停播放">
              📹 {fileA ? "A: " + fileA.split(/[\\/]/).pop()?.slice(0, 18) : "选择视频 A"}
            </button>
            <button className="btn btn-line btn-sm" onClick={() => pick("b")} title="重新选择会替换当前视频 B 并暂停播放">
              📹 {fileB ? "B: " + fileB.split(/[\\/]/).pop()?.slice(0, 18) : "选择视频 B"}
            </button>
            <div className="spacer" />
            {/* 统一控制 */}
            <button
              className={`btn ${playing ? "btn-line" : "btn-primary"} btn-sm`}
              onClick={togglePlay}
              disabled={!urlA && !urlB}
              title="两路视频同时播放 / 暂停"
            >
              {playing ? "⏸ 暂停" : "▶ 播放"}
            </button>
            <button
              className={`btn btn-sm ${muted ? "btn-ghost" : "btn-line"}`}
              onClick={toggleMute}
              disabled={!urlA && !urlB}
              title="两路同时静音 / 出声"
            >
              {muted ? "🔇 静音" : "🔊 有声"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => syncTime(0)} disabled={!bothLoaded}>
              ↺ 重置
            </button>
          </div>

          {/* 对比模式：左右滑块重叠（宽高比跟随 A，objectFit 可切换填充/适应） */}
          {mode === "compare" && (
            <div
              className="compare-wrap"
              ref={wrapRef}
              style={{ aspectRatio: String(arA) }}
              onPointerDown={(e) => {
                dragging.current = true;
                onPointer(e.clientX);
              }}
              onPointerMove={(e) => dragging.current && onPointer(e.clientX)}
              onPointerUp={() => (dragging.current = false)}
              onPointerLeave={() => (dragging.current = false)}
            >
              {urlA && (
                <video
                  ref={videoARef}
                  className="frame"
                  style={{ objectFit }}
                  src={urlA}
                  muted={muted}
                  preload="metadata"
                  playsInline
                  onEnded={onEnded}
                />
              )}
              {urlB && (
                <div className="clip-right" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>
                  <video
                    ref={videoBRef}
                    className="frame"
                    style={{ objectFit }}
                    src={urlB}
                    muted={muted}
                    preload="metadata"
                    playsInline
                    onEnded={onEnded}
                  />
                </div>
              )}
              {urlB && (
                <div className="divider" style={{ left: `${slider}%` }}>
                  <span />
                </div>
              )}
              {urlA && <span className="label" style={{ left: 10 }}>A</span>}
              {urlB && <span className="label" style={{ right: 10 }}>B</span>}
              {!urlA && !urlB && (
                <div className="empty" style={{ position: "absolute", inset: 0 }}>
                  <div className="big">◐</div>
                  <div className="tip">选择视频文件开始对比分析</div>
                </div>
              )}
            </div>
          )}

          {/* 堆叠模式：上下排列，不重叠 */}
          {mode === "stack" && (
            <div className="stack-wrap">
              <div className="stack-item">
                <span className="label" style={{ top: 8, left: 8 }}>A</span>
                {urlA ? (
                  <video
                    ref={videoARef}
                    className="stack-video"
                    src={urlA}
                    muted={muted}
                    preload="metadata"
                    playsInline
                    onEnded={onEnded}
                  />
                ) : (
                  <div className="empty" style={{ height: "100%" }}>
                    <div className="big">◐</div>
                    <div className="tip">选择视频 A</div>
                  </div>
                )}
              </div>
              <div className="stack-divider" />
              <div className="stack-item">
                <span className="label" style={{ top: 8, left: 8 }}>B</span>
                {urlB ? (
                  <video
                    ref={videoBRef}
                    className="stack-video"
                    src={urlB}
                    muted={muted}
                    preload="metadata"
                    playsInline
                    onEnded={onEnded}
                  />
                ) : (
                  <div className="empty" style={{ height: "100%" }}>
                    <div className="big">◐</div>
                    <div className="tip">选择视频 B</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 比例不一致提示 */}
          {ratioMismatch && (
            <div className="hint" style={{ marginTop: -6 }}>
              ⚠ A 与 B 宽高比不同（{metaA!.width}×{metaA!.height} vs {metaB!.width}×{metaB!.height}）：
              「填充」会裁切 B 对齐 A 的画面；「适应」完整显示但可能有黑边。
            </div>
          )}

          {/* 时间轴（同步 seek） */}
          <div className="toolbar">
            <span className="hint">时间轴：</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, duration * 100)}
              value={Math.min(time, duration || 0) * 100}
              onChange={(e) => syncTime(parseFloat(e.target.value) / 100)}
              style={{ flex: 1, accentColor: "var(--c-cyan)" }}
            />
            <span className="mono" style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--tx-2)" }}>
              {fmtDuration(Math.min(time, duration || 0))} / {fmtDuration(duration)}
            </span>
          </div>
          <div className="hint" style={{ marginTop: -6 }}>
            ▶ 播放 / ⏸ 暂停 / 🔊 声音按钮同时作用于两路视频；拖动时间轴会暂停并跳转到指定位置。
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Meta m={metaA} label="A" />
          <Meta m={metaB} label="B" />
          {metaA && metaB && (
            <div className="card">
              <h3>
                <span className="num">Δ</span> 差异
              </h3>
              <div className="meta-kv">
                <span className="k">分辨率</span>
                <span className="v">
                  {metaA.width === metaB.width && metaA.height === metaB.height ? "一致" : `${metaA.width}×${metaA.height} → ${metaB.width}×${metaB.height}`}
                </span>
                <span className="k">帧率</span>
                <span className="v">
                  {metaA.fps === metaB.fps ? "一致" : `${metaA.fps.toFixed(2)} → ${metaB.fps.toFixed(2)}`}
                </span>
                <span className="k">编码</span>
                <span className="v">{metaA.codec === metaB.codec ? "一致" : `${metaA.codec} → ${metaB.codec}`}</span>
                <span className="k">大小</span>
                <span className="v">
                  {metaA.size === metaB.size ? "一致" : `${fmtSize(metaA.size)} → ${fmtSize(metaB.size)}`}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
