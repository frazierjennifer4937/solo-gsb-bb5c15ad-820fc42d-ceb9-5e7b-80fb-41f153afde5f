import type { Subtitle } from './types';

/**
 * 镜头切点检查：把采样帧统一缩放到固定尺寸，计算相邻帧的 RGB 直方图差，
 * 差值超过阈值的候选在最小间隔内只保留差值最大者，得到切点；
 * 再核对每条字幕是否跨越切点、或起止边界距切点小于容差。
 * 全部分析在浏览器本地完成，只读字幕数据，不做任何修改。
 */

/** 采样帧统一缩放到的固定尺寸（与 useSceneCuts 中的画布一致） */
export const FRAME_WIDTH = 80;
export const FRAME_HEIGHT = 45;

/** 每通道直方图桶数，三通道共 48 桶 */
export const HIST_BINS = 16;

export interface SceneCutParams {
  /** 采样间隔（毫秒）：每隔多久取一帧 */
  intervalMs: number;
  /** 直方图差阈值（0–1）：相邻帧差值超过此值才成为候选 */
  threshold: number;
  /** 最小切点间隔（毫秒）：间隔内的候选只保留差值最大者 */
  minGapMs: number;
  /** 边界容差（毫秒）：字幕起止边界距切点小于此值视为冲突 */
  toleranceMs: number;
}

export interface SceneCut {
  /** 切点时间（毫秒） */
  time: number;
  /** 该切点处的直方图差（0–1） */
  diff: number;
}

/** 冲突类型：cross 字幕跨越切点 / start 起点贴近切点 / end 终点贴近切点 */
export type CutConflictType = 'cross' | 'start' | 'end';

export interface CutConflict {
  /** 字幕 id / 序号 / 首行文本 */
  id: string;
  index: number;
  text: string;
  /** 字幕起止（毫秒） */
  subStart: number;
  subEnd: number;
  /** 切点时间（毫秒）与直方图差 */
  cutTime: number;
  cutDiff: number;
  types: CutConflictType[];
}

/** 表单原始文本解析结果 */
export type ParsedSceneCutParams =
  | { ok: true; params: SceneCutParams }
  | { ok: false; error: string };

/**
 * 解析侧栏参数文本；阈值取严格 0–1，采样间隔至少 50ms，
 * 最小切点间隔与边界容差为不小于 0 的毫秒数。
 */
export function parseSceneCutParams(raw: {
  intervalMs: string;
  threshold: string;
  minGapMs: string;
  toleranceMs: string;
}): ParsedSceneCutParams {
  const intervalMs = Number(raw.intervalMs);
  const threshold = Number(raw.threshold);
  const minGapMs = Number(raw.minGapMs);
  const toleranceMs = Number(raw.toleranceMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 50)
    return { ok: false, error: '采样间隔须为不小于 50 的毫秒数（建议 200–1000）' };
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)
    return { ok: false, error: '差值阈值须为 0 到 1 之间的数值（建议 0.2–0.6）' };
  if (!Number.isFinite(minGapMs) || minGapMs < 0)
    return { ok: false, error: '最小切点间隔须为不小于 0 的毫秒数' };
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0)
    return { ok: false, error: '边界容差须为不小于 0 的毫秒数' };
  return { ok: true, params: { intervalMs, threshold, minGapMs, toleranceMs } };
}

/** 从 RGBA 像素数据计算 RGB 直方图（每通道 16 桶，共 48 桶） */
export function computeHistogram(pixels: Uint8ClampedArray): Uint32Array {
  const hist = new Uint32Array(HIST_BINS * 3);
  for (let i = 0; i < pixels.length; i += 4) {
    hist[(pixels[i] * HIST_BINS) >> 8]++;
    hist[HIST_BINS + ((pixels[i + 1] * HIST_BINS) >> 8)]++;
    hist[2 * HIST_BINS + ((pixels[i + 2] * HIST_BINS) >> 8)]++;
  }
  return hist;
}

/**
 * 两个直方图的归一化差（0 完全相同，1 完全不同）：
 * 各通道逐桶差的绝对值之和，除以 2 × 通道数 × 像素数。
 */
export function histogramDiff(a: Uint32Array, b: Uint32Array, pixelCount: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (2 * 3 * pixelCount);
}

/**
 * 最小间隔过滤：候选按时间升序，与当前簇代表（簇内差值最大者）相距
 * 小于 minGapMs 的归入同簇竞争（差值更大者取代代表），否则结算当前簇、
 * 以该候选开新簇。保证输出的切点两两间隔不小于 minGapMs。
 */
export function selectCuts(candidates: SceneCut[], minGapMs: number): SceneCut[] {
  const cuts: SceneCut[] = [];
  let best: SceneCut | null = null;
  for (const c of candidates) {
    if (best !== null && c.time - best.time < minGapMs) {
      if (c.diff > best.diff) best = c;
    } else {
      if (best !== null) cuts.push(best);
      best = c;
    }
  }
  if (best !== null) cuts.push(best);
  return cuts;
}

/**
 * 核对字幕与切点的冲突：切点落在字幕起止之间（跨越），或起 / 止边界
 * 距切点小于容差（贴近）；倒置字幕按规范化区间判定跨越。一条字幕可与
 * 多个切点冲突，每个（字幕, 切点）对产生一条记录，按切点时间升序返回。
 */
export function findCutConflicts(
  subs: Subtitle[],
  cuts: SceneCut[],
  toleranceMs: number
): CutConflict[] {
  const conflicts: CutConflict[] = [];
  for (const cut of cuts) {
    for (const s of subs) {
      const lo = Math.min(s.start, s.end);
      const hi = Math.max(s.start, s.end);
      const types: CutConflictType[] = [];
      if (lo < cut.time && cut.time < hi) types.push('cross');
      if (Math.abs(s.start - cut.time) < toleranceMs) types.push('start');
      if (Math.abs(s.end - cut.time) < toleranceMs) types.push('end');
      if (types.length === 0) continue;
      conflicts.push({
        id: s.id,
        index: s.index,
        text: s.text.split('\n')[0],
        subStart: s.start,
        subEnd: s.end,
        cutTime: cut.time,
        cutDiff: cut.diff,
        types,
      });
    }
  }
  return conflicts;
}
