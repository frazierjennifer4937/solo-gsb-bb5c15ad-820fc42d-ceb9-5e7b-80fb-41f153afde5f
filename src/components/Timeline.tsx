import { useEffect, useMemo, useRef } from 'react';
import type { Subtitle } from '../types';
import type { IssueType } from '../issues';
import type { WaveformState } from '../useWaveform';
import type { SceneCut } from '../scenecut';
import { formatTimestamp } from '../srt';
import WaveformLane from './WaveformLane';

interface TimelineProps {
  subs: Subtitle[];
  issues: Map<string, Set<IssueType>>;
  /** 时间轴总时长（秒） */
  duration: number;
  /** 缩放：每秒像素数 */
  pxPerSec: number;
  /** 播放头位置（秒） */
  currentTime: number;
  chainMode: boolean;
  selectedId: string | null;
  follow: boolean;
  onSelect: (id: string | null) => void;
  onSeek: (sec: number) => void;
  /** 拖动过程中的实时更新（不进历史） */
  onLiveChange: (next: Subtitle[]) => void;
  /** 拖动结束时提交历史，参数为拖动前的快照 */
  onDragCommit: (before: Subtitle[]) => void;
  /** 音频波形状态（idle 时不渲染波形轨道） */
  waveform: WaveformState;
  /** 关闭波形错误提示 */
  onDismissWaveform: () => void;
  /** 镜头切点标记（毫秒），空数组时不渲染 */
  cuts: SceneCut[];
}

type DragMode = 'move' | 'resize-l' | 'resize-r';

interface DragState {
  mode: DragMode;
  id: string;
  startClientX: number;
  before: Subtitle[];
  moved: boolean;
}

const MIN_MS = 1;

/** 根据拖动模式与位移计算新的字幕数组（基于拖动前快照，幂等） */
function applyDrag(
  before: Subtitle[],
  id: string,
  mode: DragMode,
  deltaMs: number,
  chain: boolean
): Subtitle[] {
  const idx = before.findIndex((s) => s.id === id);
  if (idx === -1) return before;
  const target = before[idx];

  if (mode === 'move') {
    let shift = Math.round(deltaMs);
    if (target.start + shift < 0) shift = -target.start; // 不允许移出 0 点
    if (shift === 0) return before;
    return before.map((s, i) =>
      i === idx || (chain && i > idx)
        ? { ...s, start: s.start + shift, end: s.end + shift }
        : s
    );
  }
  if (mode === 'resize-l') {
    const newStart = Math.round(
      Math.min(Math.max(target.start + deltaMs, 0), target.end - MIN_MS)
    );
    if (newStart === target.start) return before;
    return before.map((s, i) => (i === idx ? { ...s, start: newStart } : s));
  }
  const newEnd = Math.round(Math.max(target.end + deltaMs, target.start + MIN_MS));
  if (newEnd === target.end) return before;
  return before.map((s, i) => (i === idx ? { ...s, end: newEnd } : s));
}

function formatTick(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const sStr = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`;
}

export default function Timeline(props: TimelineProps) {
  const { subs, issues, duration, pxPerSec, currentTime, chainMode, selectedId, follow } = props;
  const waveVisible = props.waveform.status !== 'idle';

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubRef = useRef(false);

  // 通过 ref 让全局监听器始终读到最新值，避免重复绑定
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const chainRef = useRef(chainMode);
  chainRef.current = chainMode;
  const liveRef = useRef(props.onLiveChange);
  liveRef.current = props.onLiveChange;
  const commitRef = useRef(props.onDragCommit);
  commitRef.current = props.onDragCommit;
  const seekRef = useRef(props.onSeek);
  seekRef.current = props.onSeek;

  // 全局 pointer 监听：拖动字幕块 / 在标尺上拖拽 scrub
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (d) {
        const deltaMs = ((e.clientX - d.startClientX) / pxPerSecRef.current) * 1000;
        if (!d.moved && Math.abs(deltaMs) < 2) return; // 2ms 死区，避免误触
        d.moved = true;
        liveRef.current(applyDrag(d.before, d.id, d.mode, deltaMs, chainRef.current));
        return;
      }
      if (scrubRef.current && innerRef.current) {
        const rect = innerRef.current.getBoundingClientRect();
        seekRef.current(Math.max(0, (e.clientX - rect.left) / pxPerSecRef.current));
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d && d.moved) commitRef.current(d.before);
      dragRef.current = null;
      scrubRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // 跟随播放：播放头滚出可视区时自动滚动
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = currentTime * pxPerSec;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [currentTime, follow, pxPerSec]);

  // 根据缩放选择合适刻度间隔，保证刻度间距 >= 80px
  const ticks = useMemo(() => {
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = candidates.find((c) => c * pxPerSec >= 80) ?? 600;
    const arr: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) arr.push(Number(t.toFixed(3)));
    return arr;
  }, [duration, pxPerSec]);

  const beginDrag = (e: React.PointerEvent, sub: Subtitle, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    props.onSelect(sub.id);
    dragRef.current = { mode, id: sub.id, startClientX: e.clientX, before: subs, moved: false };
  };

  const seekFromEvent = (e: React.PointerEvent) => {
    if (!innerRef.current) return;
    const rect = innerRef.current.getBoundingClientRect();
    props.onSeek(Math.max(0, (e.clientX - rect.left) / pxPerSec));
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    scrubRef.current = true;
    seekFromEvent(e);
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    props.onSelect(null);
    scrubRef.current = true;
    seekFromEvent(e);
  };

  return (
    <div className="timeline-wrap">
      <div className="timeline-header">
        <span className="timeline-title">时间轴</span>
        <span className="legend">
          <span className="legend-item">
            <i className="dot dot-overlap" /> 重叠
          </span>
          <span className="legend-item">
            <i className="dot dot-inverted" /> 起止倒置
          </span>
          <span className="legend-item">
            <i className="dot dot-short" /> 短于 500ms
          </span>
          {props.cuts.length > 0 && (
            <span className="legend-item">
              <i className="dot dot-cut" /> 镜头切点 {props.cuts.length}
            </span>
          )}
        </span>
        <span className="playhead-time">播放头 {formatTimestamp(currentTime * 1000)}</span>
      </div>

      <div className={`timeline${waveVisible ? ' has-wave' : ''}`} ref={scrollRef}>
        <div
          className="timeline-inner"
          ref={innerRef}
          style={{ width: Math.max(duration * pxPerSec, 200) }}
        >
          <div className="ruler" onPointerDown={onRulerPointerDown}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * pxPerSec }}>
                <span>{formatTick(t)}</span>
              </div>
            ))}
          </div>

          {waveVisible && (
            <WaveformLane
              status={props.waveform.status}
              data={props.waveform.data}
              error={props.waveform.error}
              pxPerSec={pxPerSec}
              scrollRef={scrollRef}
              onDismiss={props.onDismissWaveform}
            />
          )}

          <div className="track" onPointerDown={onTrackPointerDown}>
            {subs.length === 0 && (
              <div className="track-empty">导入 SRT 或点击「加载示例」后，字幕块将显示在这里</div>
            )}
            {props.cuts.map((c) => (
              <div
                key={c.time}
                className="cut-marker"
                style={{ left: (c.time / 1000) * pxPerSec }}
                title={`镜头切点 ${formatTimestamp(c.time)} · 差值 ${c.diff.toFixed(3)}`}
              />
            ))}
            {subs.map((s) => {
              const iss = issues.get(s.id);
              const cls = ['sub-block'];
              if (iss?.has('inverted')) cls.push('issue-inverted');
              else if (iss?.has('overlap')) cls.push('issue-overlap');
              else if (iss?.has('short')) cls.push('issue-short');
              if (s.id === selectedId) cls.push('selected');
              const left = (s.start / 1000) * pxPerSec;
              const width = Math.max(6, ((s.end - s.start) / 1000) * pxPerSec);
              return (
                <div
                  key={s.id}
                  className={cls.join(' ')}
                  style={{ left, width }}
                  title={`#${s.index}  ${formatTimestamp(s.start)} → ${formatTimestamp(s.end)}\n${s.text}`}
                  onPointerDown={(e) => beginDrag(e, s, 'move')}
                  onDoubleClick={() => props.onSeek(s.start / 1000)}
                >
                  <div className="handle handle-l" onPointerDown={(e) => beginDrag(e, s, 'resize-l')} />
                  <span className="sub-label">
                    #{s.index} {s.text.split('\n')[0]}
                  </span>
                  <div className="handle handle-r" onPointerDown={(e) => beginDrag(e, s, 'resize-r')} />
                </div>
              );
            })}
            <div className="playhead" style={{ left: currentTime * pxPerSec }} />
          </div>
        </div>
      </div>
    </div>
  );
}
