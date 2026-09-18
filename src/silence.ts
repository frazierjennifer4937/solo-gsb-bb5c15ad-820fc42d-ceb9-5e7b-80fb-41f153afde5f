import type { Subtitle } from './types';
import type { WaveformData } from './waveform';

/**
 * 静音吸附：按波形桶峰值识别静音段，在「保持条目顺序、每条时长达标、
 * 互不重叠」的前提下，用动态规划把所选连续字幕的起止边界吸附到附近
 * 静音段的中点。方案优劣依次为：
 *   1. 吸附边界数最多；
 *   2. 总位移（所有边界绝对位移之和）最小；
 *   3. 仍同分时，新时间序列字典序较小者。
 */

/** 静音段（连续命中桶合并而成），时间单位毫秒 */
export interface SilenceSegment {
  /** 起始桶号 */
  bucketFrom: number;
  /** 结束桶号（含） */
  bucketTo: number;
  /** 段起点（毫秒） */
  start: number;
  /** 段终点（毫秒） */
  end: number;
  /** 段中点（毫秒），即吸附落点 */
  mid: number;
  /** 段时长（毫秒） */
  duration: number;
}

export interface SilenceParams {
  /** 峰值阈值 0–1：桶峰值 max(|min|,|max|) 低于此值判为静音桶 */
  threshold: number;
  /** 最短静音长度（毫秒）：合并后的静音段短于此值则丢弃 */
  minSilenceMs: number;
  /** 最大吸附距离（毫秒）：只取距原边界在此范围内的静音中点 */
  maxSnapMs: number;
  /** 字幕最小时长（毫秒）：吸附后每条字幕时长不得短于此值 */
  minDurationMs: number;
}

/** 单条字幕的吸附预览结果 */
export interface SilenceItemPlan {
  id: string;
  index: number;
  /** 原开始 / 结束（毫秒） */
  start: number;
  end: number;
  /** 新开始 / 结束（毫秒） */
  newStart: number;
  newEnd: number;
  /** 开始 / 结束边界吸附到的静音段；保持原位时为 null */
  startSegment: SilenceSegment | null;
  endSegment: SilenceSegment | null;
}

export interface SilencePlan {
  items: SilenceItemPlan[];
  /** 吸附到静音中点的边界数 */
  snapped: number;
  /** 全部边界的绝对位移之和（毫秒） */
  totalShift: number;
  /** 起止时间发生变化的字幕条数 */
  moved: number;
}

/** 表单原始文本解析结果 */
export type ParsedSilenceParams =
  | { ok: true; params: SilenceParams }
  | { ok: false; error: string };

/**
 * 解析侧栏参数文本；阈值取严格 0–1，其余为毫秒数
 * （最大吸附距离须为正，字幕最小时长至少 1ms）。
 */
export function parseSilenceParams(raw: {
  threshold: string;
  minSilenceMs: string;
  maxSnapMs: string;
  minDurationMs: string;
}): ParsedSilenceParams {
  const threshold = Number(raw.threshold);
  const minSilenceMs = Number(raw.minSilenceMs);
  const maxSnapMs = Number(raw.maxSnapMs);
  const minDurationMs = Number(raw.minDurationMs);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)
    return { ok: false, error: '峰值阈值须为 0 到 1 之间的数值（建议 0.01–0.05）' };
  if (!Number.isFinite(minSilenceMs) || minSilenceMs < 0)
    return { ok: false, error: '最短静音长度须为不小于 0 的毫秒数' };
  if (!Number.isFinite(maxSnapMs) || maxSnapMs <= 0)
    return { ok: false, error: '最大吸附距离须为大于 0 的毫秒数' };
  if (!Number.isFinite(minDurationMs) || minDurationMs < 1)
    return { ok: false, error: '字幕最小时长须为不小于 1 的毫秒数' };
  return { ok: true, params: { threshold, minSilenceMs, maxSnapMs, minDurationMs } };
}

/**
 * 识别静音段：逐桶计算 max(abs(min), abs(max))，低于阈值的桶连续合并，
 * 段长达到最短静音长度才保留，段时间取整到毫秒。
 */
export function detectSilences(
  data: WaveformData,
  threshold: number,
  minSilenceMs: number
): SilenceSegment[] {
  const { mins, maxs, bucketSec, duration } = data;
  const bucketMs = bucketSec * 1000;
  const durationMs = duration * 1000;
  const segments: SilenceSegment[] = [];

  let b = 0;
  while (b < mins.length) {
    const peak = Math.max(Math.abs(mins[b]), Math.abs(maxs[b]));
    if (peak >= threshold) {
      b++;
      continue;
    }
    const from = b;
    while (b + 1 < mins.length) {
      const next = Math.max(Math.abs(mins[b + 1]), Math.abs(maxs[b + 1]));
      if (next >= threshold) break;
      b++;
    }
    const to = b;
    const start = Math.round(from * bucketMs);
    const end = Math.round(Math.min(durationMs, (to + 1) * bucketMs));
    if (end - start >= minSilenceMs) {
      segments.push({
        bucketFrom: from,
        bucketTo: to,
        start,
        end,
        mid: Math.round((start + end) / 2),
        duration: end - start,
      });
    }
    b++;
  }
  return segments;
}

/**
 * 解析字幕区间：按字幕在数组中的位置取 from / to 之间的连续切片
 * （两端顺序可互换）；任一 id 不存在时返回 null。
 */
export function resolveRange(
  subs: Subtitle[],
  fromId: string | null,
  toId: string | null
): Subtitle[] | null {
  if (!fromId || !toId) return null;
  const i = subs.findIndex((s) => s.id === fromId);
  const j = subs.findIndex((s) => s.id === toId);
  if (i === -1 || j === -1) return null;
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return subs.slice(lo, hi + 1);
}

interface Candidate {
  /** 候选边界时间（毫秒） */
  time: number;
  /** 对应的静音段；原位置候选为 null */
  segment: SilenceSegment | null;
}

/** 首个使 pred(array[i]) 为 true 的下标；pred 随 i 由假变真 */
function lowerBound<T>(array: T[], pred: (v: T) => boolean): number {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(array[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 为一个边界生成候选：原位置 + 距原位置不超过 maxSnapMs 的静音中点，
 * 按时间去重排序。静音中点恰等于原时间时保留静音候选（该边界本就落在
 * 静音中点，计入吸附数），故同时间下静音候选覆盖原位置候选。
 */
function candidatesFor(
  origMs: number,
  segments: SilenceSegment[],
  maxSnapMs: number
): Candidate[] {
  const byTime = new Map<number, Candidate>();
  byTime.set(origMs, { time: origMs, segment: null });
  const start = lowerBound(segments, (s) => s.mid >= origMs - maxSnapMs);
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.mid - origMs > maxSnapMs) break;
    byTime.set(seg.mid, { time: seg.mid, segment: seg });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** 比较两个数值序列的字典序 */
function lexLess(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** DP 行内保留的状态：选定本条的某对起 / 止候选 */
interface RowState {
  /** 本行起 / 止候选数组下标 */
  sIdx: number;
  eIdx: number;
  snapped: number;
  totalShift: number;
  /** 本行全部状态按新时间序列字典序排序后得到的名次（从 1 起） */
  rank: number;
  /** 前驱状态在上一行状态数组中的下标；首行为 -1 */
  parentIndex: number;
}

/** 上一行参与转移的视图，按 end 升序；首行为 end=0、名次 0 的虚拟前驱 */
interface ParentView {
  end: number;
  snapped: number;
  totalShift: number;
  rank: number;
  /** 上一行状态数组下标；首行虚拟前驱为 -1 */
  stateIndex: number;
}

interface RowTrace {
  /** 按 end 升序的状态（下标与下一行 ParentView.stateIndex 对应） */
  states: RowState[];
  startCands: Candidate[];
  endCands: Candidate[];
}

interface Objective {
  snapped: number;
  totalShift: number;
  /** 用于同分判字典序的比较键（前驱名次或最终名次） */
  seqKey: number[];
}

/** 同一目标下比较两个状态：吸附数多者优，其次总位移小，再其次时间序列字典序小 */
function better(a: Objective, b: Objective): boolean {
  if (a.snapped !== b.snapped) return a.snapped > b.snapped;
  if (a.totalShift !== b.totalShift) return a.totalShift < b.totalShift;
  return lexLess(a.seqKey, b.seqKey);
}

/**
 * 计算静音吸附方案；无可行方案时返回 null。
 *
 * 动态规划按字幕逐条推进：每条字幕有起、止两组候选（原位置 + 距离内
 * 静音中点）。转移要求 start ≥ 上一条 end（互不重叠且保持顺序）、
 * end − start ≥ 最小时长。对每个开始候选只需考虑「end ≤ start 的
 * 前驱中全局最优」的一个（本条自身贡献与具体前驱无关），前驱按 end
 * 升序后前缀最优可线性维护。同一 end 仅保留最优状态。
 *
 * 同分的时间序列字典序用「前驱名次 → 本条 start → 本条 end」排序
 * 得到的行内名次编码：子行比较名次即等价于比较完整时间序列，
 * 无需保存整条序列。任一行无可达状态即无可行方案。
 */
export function planSilenceSnap(
  targets: Subtitle[],
  data: WaveformData,
  params: SilenceParams
): SilencePlan | null {
  if (targets.length === 0) return null;
  const segments = detectSilences(data, params.threshold, params.minSilenceMs);

  const startCands: Candidate[][] = targets.map((s) =>
    candidatesFor(s.start, segments, params.maxSnapMs)
  );
  const endCands: Candidate[][] = targets.map((s) =>
    candidatesFor(s.end, segments, params.maxSnapMs)
  );

  // rows[k] 记录第 k 行，供回溯；parents 为第 k 行转移时看到的前驱视图
  const rows: RowTrace[] = [];
  let parents: ParentView[] = [
    { end: 0, snapped: 0, totalShift: 0, rank: 0, stateIndex: -1 },
  ];

  for (let k = 0; k < targets.length; k++) {
    const orig = targets[k];
    const sc = startCands[k];
    const ec = endCands[k];

    // parents 按 end 升序；边推进指针边维护 end ≤ start 前缀中的最优前驱
    const bestParent: ParentView[] = new Array(sc.length);
    let running: ParentView | null = null;
    let pi = 0;
    for (let si = 0; si < sc.length; si++) {
      while (pi < parents.length && parents[pi].end <= sc[si].time) {
        const p = parents[pi];
        if (
          !running ||
          better(
            { snapped: p.snapped, totalShift: p.totalShift, seqKey: [p.rank] },
            {
              snapped: running.snapped,
              totalShift: running.totalShift,
              seqKey: [running.rank],
            }
          )
        ) {
          running = p;
        }
        pi++;
      }
      if (running) bestParent[si] = running;
    }

    // 枚举 (start, end) 可行对，同一 end 仅保留最优状态
    const bestPerEnd = new Map<number, RowState>();
    for (let si = 0; si < sc.length; si++) {
      const parent = bestParent[si];
      if (!parent) continue;
      const s = sc[si];
      for (let ei = 0; ei < ec.length; ei++) {
        const e = ec[ei];
        if (e.time - s.time < params.minDurationMs) continue;
        const snapped =
          parent.snapped + (s.segment ? 1 : 0) + (e.segment ? 1 : 0);
        const totalShift =
          parent.totalShift +
          Math.abs(s.time - orig.start) +
          Math.abs(e.time - orig.end);
        const candidate: RowState = {
          sIdx: si,
          eIdx: ei,
          snapped,
          totalShift,
          rank: 0,
          parentIndex: parent.stateIndex,
        };
        const existing = bestPerEnd.get(e.time);
        if (
          !existing ||
          better(
            { snapped, totalShift, seqKey: [parent.rank, s.time, e.time] },
            {
              snapped: existing.snapped,
              totalShift: existing.totalShift,
              seqKey: [
                parentRank(existing, parents),
                sc[existing.sIdx].time,
                e.time,
              ],
            }
          )
        ) {
          bestPerEnd.set(e.time, candidate);
        }
      }
    }

    let row = [...bestPerEnd.values()];
    if (row.length === 0) return null;

    // 按 end 升序，作为下一行前驱视图（下标即 stateIndex）
    row.sort((a, b) => ec[a.eIdx].time - ec[b.eIdx].time);

    // 按完整时间序列字典序（前驱名次 → start → end）赋予行内名次
    const seq = (st: RowState): number[] => [
      parentRank(st, parents),
      sc[st.sIdx].time,
      ec[st.eIdx].time,
    ];
    [...row]
      .sort((a, b) => {
        const ka = seq(a);
        const kb = seq(b);
        return lexLess(ka, kb) ? -1 : lexLess(kb, ka) ? 1 : 0;
      })
      .forEach((st, i) => {
        st.rank = i + 1;
      });

    rows.push({ states: row, startCands: sc, endCands: ec });
    parents = row.map((st, i) => ({
      end: ec[st.eIdx].time,
      snapped: st.snapped,
      totalShift: st.totalShift,
      rank: st.rank,
      stateIndex: i,
    }));
  }

  // 末行取全局最优：吸附数 → 总位移 → 时间序列字典序（rank）
  const lastRow = rows[rows.length - 1];
  let best = lastRow.states[0];
  for (const st of lastRow.states) {
    if (
      better(
        { snapped: st.snapped, totalShift: st.totalShift, seqKey: [st.rank] },
        { snapped: best.snapped, totalShift: best.totalShift, seqKey: [best.rank] }
      )
    ) {
      best = st;
    }
  }

  // 回溯：每行记录的 parentIndex 是上一行 states 的下标
  const items: SilenceItemPlan[] = new Array(targets.length);
  let st: RowState | null = best;
  let parentIdx = best.parentIndex;
  for (let k = targets.length - 1; k >= 0 && st; k--) {
    const trace = rows[k];
    const s = trace.startCands[st.sIdx];
    const e = trace.endCands[st.eIdx];
    const origSub = targets[k];
    items[k] = {
      id: origSub.id,
      index: origSub.index,
      start: origSub.start,
      end: origSub.end,
      newStart: s.time,
      newEnd: e.time,
      startSegment: s.segment,
      endSegment: e.segment,
    };
    const prevTrace = rows[k - 1];
    st = parentIdx === -1 || !prevTrace ? null : prevTrace.states[parentIdx];
    parentIdx = st ? st.parentIndex : -1;
  }

  const snapped = items.reduce(
    (n, it) => n + (it.startSegment ? 1 : 0) + (it.endSegment ? 1 : 0),
    0
  );
  const totalShift = items.reduce(
    (sum, it) =>
      sum + Math.abs(it.newStart - it.start) + Math.abs(it.newEnd - it.end),
    0
  );
  const moved = items.filter(
    (it) => it.newStart !== it.start || it.newEnd !== it.end
  ).length;
  return { items, snapped, totalShift, moved };
}

/** 状态前驱的行内名次（首行虚拟前驱名次为 0） */
function parentRank(st: RowState, parents: ParentView[]): number {
  return st.parentIndex === -1 ? 0 : parents[st.parentIndex]?.rank ?? 0;
}

/**
 * 应用方案：把所选字幕替换为新起止时间，其余字幕原样保留；
 * 返回新数组（不修改入参）。
 */
export function applySilenceSnap(subs: Subtitle[], plan: SilencePlan): Subtitle[] {
  const byId = new Map(plan.items.map((it) => [it.id, it]));
  return subs.map((s) => {
    const it = byId.get(s.id);
    if (!it) return s;
    if (it.newStart === s.start && it.newEnd === s.end) return s;
    return { ...s, start: it.newStart, end: it.newEnd };
  });
}
