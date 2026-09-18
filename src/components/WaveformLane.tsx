import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { WaveformData } from '../waveform';
import type { WaveformStatus } from '../useWaveform';

/** 轨道高度（px），与 styles.css 中 .wave-lane 的 height 保持一致 */
const LANE_HEIGHT = 48;

interface WaveformLaneProps {
  status: WaveformStatus;
  data: WaveformData | null;
  error: string | null;
  /** 缩放：每秒像素数，与标尺 / 字幕块 / 播放头共用同一时间坐标 */
  pxPerSec: number;
  /** 时间轴滚动容器，用于监听滚动并只渲染可视区 */
  scrollRef: RefObject<HTMLDivElement>;
  onDismiss: () => void;
}

/**
 * 波形轨道：位于标尺与字幕块之间。
 * Canvas 通过 position: sticky 固定在可视区，宽度仅为视口宽；
 * 横向滚动 / 缩放时按 scrollLeft 重绘可视窗口，
 * 时间 t 的像素位置 = t * pxPerSec - scrollLeft，与刻度、播放头严格对齐。
 */
export default function WaveformLane({
  status,
  data,
  error,
  pxPerSec,
  scrollRef,
  onDismiss,
}: WaveformLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 可视区：滚动容器的左缘与宽度（px）
  const [view, setView] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setView((v) =>
        v.left === el.scrollLeft && v.width === el.clientWidth
          ? v
          : { left: el.scrollLeft, width: el.clientWidth }
      );
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  // 只绘制可视区内的波形
  useEffect(() => {
    if (status !== 'ready' || !data) return;
    const canvas = canvasRef.current;
    if (!canvas || view.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = view.width;
    const cssH = LANE_HEIGHT;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mid = cssH / 2;
    const amp = mid - 3;
    ctx.clearRect(0, 0, cssW, cssH);

    // 中轴线
    ctx.strokeStyle = 'rgba(139, 150, 173, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(cssW, mid + 0.5);
    ctx.stroke();

    // 逐像素列聚合可视时间窗内的时间桶，绘制正负峰值
    const { mins, maxs, bucketSec } = data;
    ctx.fillStyle = 'rgba(79, 140, 255, 0.65)';
    for (let x = 0; x < cssW; x++) {
      const t0 = (view.left + x) / pxPerSec;
      const t1 = (view.left + x + 1) / pxPerSec;
      let b0 = Math.floor(t0 / bucketSec);
      let b1 = Math.floor(t1 / bucketSec);
      if (b1 < b0) b1 = b0;
      if (b1 < 0 || b0 >= mins.length) continue;
      b0 = Math.max(0, b0);
      b1 = Math.min(mins.length - 1, b1);
      let mn = Infinity;
      let mx = -Infinity;
      for (let b = b0; b <= b1; b++) {
        if (mins[b] < mn) mn = mins[b];
        if (maxs[b] > mx) mx = maxs[b];
      }
      if (mn === Infinity) continue;
      const top = mid - Math.min(1, mx) * amp;
      const bottom = mid - Math.max(-1, mn) * amp;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [status, data, pxPerSec, view]);

  return (
    <div className="wave-lane" style={{ height: LANE_HEIGHT }}>
      <div className="wave-sticky" style={{ width: view.width }}>
        {status === 'ready' && <canvas ref={canvasRef} className="wave-canvas" />}
        {status === 'decoding' && (
          <div className="wave-status">
            <span className="spinner" />
            正在解码音频波形…
          </div>
        )}
        {status === 'error' && (
          <div className="wave-status wave-error" role="alert">
            <span className="wave-error-text">
              ⚠️ {error}
              <span className="wave-error-hint">不影响字幕编辑；重新导入视频可重试</span>
            </span>
            <button className="wave-dismiss" onClick={onDismiss} title="关闭提示">
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
