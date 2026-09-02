import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api, VideoMeta, assetUrl, fmtSize, fmtDuration } from "../api";

export default function VideoPage() {
  const { toast } = useStore();
  const [fileA, setFileA] = useState<string>("");
  const [fileB, setFileB] = useState<string>("");
  const [metaA, setMetaA] = useState<VideoMeta | null>(null);
  const [metaB, setMetaB] = useState<VideoMeta | null>(null);
  const [urlA, setUrlA] = useState("");
  const [urlB, setUrlB] = useState("");
  const [slider, setSlider] = useState(50);
  const [ffStatus, setFfStatus] = useState<{ installed: boolean; version: string } | null>(null);
  const [time, setTime] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    api.ffmpegStatus().then(setFfStatus).catch(() => setFfStatus({ installed: false, version: "" }));
  }, []);

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

  return (
    <div>
      <div className="page-h">
        <div>
          <h1>视频分析</h1>
          <div className="desc">
            左右滑块对比两段视频（逻辑参考 pixop/video-compare），显示完整元数据。需要
            ffmpeg（首次使用会引导下载）。
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
            <button className="btn btn-line btn-sm" onClick={() => pick("a")}>
              📹 {fileA ? "替换" : "选择"}视频 A
            </button>
            <button className="btn btn-line btn-sm" onClick={() => pick("b")}>
              📹 {fileB ? "替换" : "选择"}视频 B
            </button>
            <span className="hint" style={{ flex: 1, textAlign: "right" }}>
              {fileB ? "拖动滑块对比 A | B" : fileA ? "选择视频 B 开始对比" : "选择视频开始"}
            </span>
          </div>

          <div
            className="compare-wrap"
            ref={wrapRef}
            onPointerDown={(e) => {
              dragging.current = true;
              onPointer(e.clientX);
            }}
            onPointerMove={(e) => dragging.current && onPointer(e.clientX)}
            onPointerUp={() => (dragging.current = false)}
            onPointerLeave={() => (dragging.current = false)}
          >
            {urlA && <video className="frame" src={urlA} controls={false} muted loop autoPlay playsInline />}
            {urlB && (
              <div className="clip-right" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>
                <video className="frame" src={urlB} controls={false} muted loop autoPlay playsInline />
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

          <div className="toolbar">
            <span className="hint">播放同步时间：</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, (metaA?.duration_secs ?? 1) * 100)}
              value={time * 100}
              onChange={(e) => setTime(parseFloat(e.target.value) / 100)}
              style={{ flex: 1, accentColor: "var(--c-cyan)" }}
            />
            <span className="mono" style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--tx-2)" }}>
              {fmtDuration(time)}
            </span>
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
