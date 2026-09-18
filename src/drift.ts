import type { Subtitle } from './types';

/**
 * 双锚点漂移校准：用两条已知「与视频对齐后的开始时间」的锚点字幕，
 * 推算整稿字幕的时间偏移——
 *  - 第一锚点之前（含）：统一使用锚点 A 的偏移；
 *  - 两锚点之间：按原始开始时间在两个锚点偏移间线性插值；
 *  - 第二锚点之后（含）：统一使用锚点 B 的偏移。
 * 所有字幕时长保持不变（start / end 同步平移）。
 */

/** 锚点输入：选中的字幕 id 与解析后的目标开始时间（未选 / 未填为 null） */
export interface DriftAnchorInput {
  id: string | null;
  /** 目标开始时间，毫秒 */
  targetStart: number | null;
}

export interface DriftPlan {
  /** 与传入字幕同序的偏移量（毫秒，已取整） */
  offsets: number[];
  /** 偏移非零的字幕条数 */
  affected: number;
  /** 最大绝对偏移（毫秒） */
  maxShift: number;
}

/**
 * 计算每条字幕的偏移方案；锚点基本无效（未选择、已不存在、是同一条、
 * 当前开始时间未严格递增、目标时间缺失）时返回 null。
 */
export function planDrift(
  subs: Subtitle[],
  a: DriftAnchorInput,
  b: DriftAnchorInput
): DriftPlan | null {
  if (!a.id || !b.id || a.id === b.id) return null;
  if (a.targetStart === null || b.targetStart === null) return null;
  const subA = subs.find((s) => s.id === a.id);
  const subB = subs.find((s) => s.id === b.id);
  if (!subA || !subB) return null;
  if (subA.start >= subB.start) return null;

  const offA = a.targetStart - subA.start;
  const offB = b.targetStart - subB.start;
  const span = subB.start - subA.start;
  const offsets = subs.map((s) => {
    let off: number;
    if (s.start <= subA.start) off = offA;
    else if (s.start >= subB.start) off = offB;
    else off = offA + ((s.start - subA.start) / span) * (offB - offA);
    return Math.round(off);
  });

  let affected = 0;
  let maxShift = 0;
  for (const off of offsets) {
    if (off !== 0) affected++;
    const abs = Math.abs(off);
    if (abs > maxShift) maxShift = abs;
  }
  return { offsets, affected, maxShift };
}

/**
 * 校验双锚点设置，返回禁用「应用」的原因；全部合法时返回 null。
 * 规则：两条锚点均已选择且仍存在、不是同一条；锚点按当前开始时间严格递增；
 * 目标开始时间也严格递增；平移后任何字幕不越过 0 点；至少有一条字幕被移动。
 */
export function validateDrift(
  subs: Subtitle[],
  a: DriftAnchorInput,
  b: DriftAnchorInput
): string | null {
  if (subs.length === 0) return '请先导入字幕';
  if (!a.id || !b.id) return '请选择两条锚点字幕';
  if (a.id === b.id) return '两条锚点不能是同一条字幕';
  if (a.targetStart === null || b.targetStart === null)
    return '请为两条锚点填写有效的目标开始时间';
  const subA = subs.find((s) => s.id === a.id);
  const subB = subs.find((s) => s.id === b.id);
  if (!subA || !subB) return '锚点字幕已不存在，请重新选择';
  if (subA.start >= subB.start)
    return '锚点须按当前时间先后排列：锚点 A 的开始时间须早于锚点 B';
  if (a.targetStart >= b.targetStart)
    return '目标开始时间也须递增：锚点 A 的目标时间须早于锚点 B';
  const plan = planDrift(subs, a, b);
  if (!plan) return '锚点设置无效';
  if (subs.some((s, i) => s.start + plan.offsets[i] < 0))
    return '按此偏移，部分字幕将移到 0 点之前，请调整目标时间';
  if (plan.affected === 0) return '目标时间与当前一致，无需校准';
  return null;
}

/** 应用漂移：所有字幕按偏移同步平移，时长保持不变；返回新数组（不修改入参） */
export function applyDrift(subs: Subtitle[], offsets: number[]): Subtitle[] {
  return subs.map((s, i) => {
    const off = offsets[i] ?? 0;
    return off === 0 ? s : { ...s, start: s.start + off, end: s.end + off };
  });
}

/** 偏移量格式化："+1.500s" / "-0.250s" / "0.000s" */
export function formatShift(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}
