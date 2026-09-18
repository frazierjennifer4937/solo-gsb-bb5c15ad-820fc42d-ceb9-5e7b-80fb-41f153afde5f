import type { Subtitle } from './types';

/** 候选对保留阈值：综合得分低于此值不参与匹配 */
export const MATCH_THRESHOLD = 0.45;
/** 文本相似度权重 */
export const TEXT_WEIGHT = 0.6;
/** 时间区间 IoU 权重 */
export const TIME_WEIGHT = 0.4;
/**
 * 对齐 DP 的序号带状半宽：只在 |当前稿序号 − 修订稿序号| ≤ INDEX_BAND 的
 * 格子间寻找路径。正常修订的错位量远小于此；带外即使存在候选也不采用。
 * 候选对本身是稀疏枚举的（精确文本 / 区间相交 / 二元组近邻），
 * DP 格子的填充只做常数次取大，故整体复杂度约 O(n·INDEX_BAND)。
 */
const INDEX_BAND = 300;

/** 归一化：转小写、去首尾空白、折叠连续空白（按 Unicode 空白处理） */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 带状 Levenshtein 编辑距离（按 Unicode 码点计字符），只关心距离是否 ≤ limit。
 * 不可能或超过 limit 时返回 null：
 *  - 先剥除两侧公共前缀 / 后缀（不改变编辑距离），模板化文本只剩少量差异核心；
 *  - 带状半宽取 limit，任一行最小值已超限时提前结束；
 *  - 使用调用方提供的复用行缓冲，避免逐候选分配数组。
 */
function editDistanceWithin(
  a: string[],
  b: string[],
  limit: number,
  prev: Float64Array,
  curr: Float64Array
): number | null {
  let aLo = 0;
  let bLo = 0;
  let aHi = a.length;
  let bHi = b.length;
  const minLen = Math.min(aHi, bHi);
  while (aLo < minLen && a[aLo] === b[aLo]) aLo++, bLo++;
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) aHi--, bHi--;
  const lenA = aHi - aLo;
  const lenB = bHi - bLo;
  if (lenA === 0) return lenB <= limit ? lenB : null;
  if (lenB === 0) return lenA <= limit ? lenA : null;
  if (Math.abs(lenA - lenB) > limit) return null;

  const band = Math.max(1, Math.floor(limit));
  const INF = Number.POSITIVE_INFINITY;
  prev.fill(INF, 0, lenB + 1);
  curr.fill(INF, 0, lenB + 1);
  for (let j = 0; j <= Math.min(lenB, band); j++) prev[j] = j;

  for (let i = 1; i <= lenA; i++) {
    // 只重置本行会触达的带状窗口
    curr.fill(INF, Math.max(0, i - band - 1), Math.min(lenB, i + band) + 1);
    if (i <= band) curr[0] = i;
    const lo = Math.max(1, i - band);
    const hi = Math.min(lenB, i + band);
    let rowMin = INF;
    for (let j = lo; j <= hi; j++) {
      const cost = a[aLo + i - 1] === b[bLo + j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // 后续各行的最小距离单调不减，超限即可终止
    if (rowMin > limit) return null;
    [prev, curr] = [curr, prev];
  }
  const d = prev[lenB];
  return Number.isFinite(d) && d <= limit ? d : null;
}

/**
 * 给定 IoU 时候选达到阈值所允许的最大编辑距离 d：
 * 0.6·(1−d/maxLen) + 0.4·IoU ≥ 0.45
 */
function maxAllowedDistance(maxLen: number, iou: number): number {
  return (1 - (MATCH_THRESHOLD - TIME_WEIGHT * iou) / TEXT_WEIGHT) * maxLen;
}

/** 毫秒时间区间的 IoU（交并比）；无有效交集或并集长度为 0 时返回 0 */
export function intervalIoU(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const inter = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (!(inter > 0)) return 0;
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  if (!(union > 0)) return 0;
  return inter / union;
}

/** 一对匹配的预览信息 */
export interface MergePair {
  currentIndex: number;
  revisionIndex: number;
  /** 综合得分（0–1） */
  score: number;
  /** 文本相似度分量 */
  text: number;
  /** 时间 IoU 分量 */
  time: number;
}

export interface MergeResult {
  pairs: MergePair[];
  /** 未参与匹配的当前稿序号（原始 index） */
  unmatchedCurrent: number[];
  /** 未参与匹配的修订稿序号（原始 index） */
  unmatchedRevision: number[];
}

interface Prepared {
  sub: Subtitle;
  chars: string[];
  norm: string;
}

function prepare(subs: Subtitle[]): Prepared[] {
  return subs.map((sub) => {
    const norm = normalizeText(sub.text);
    return { sub, norm, chars: [...norm] };
  });
}

/** 字符二元组（长度 < 2 时用整串作为唯一键） */
function bigrams(chars: string[]): string[] {
  if (chars.length < 2) return chars.slice();
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

interface CandidateEdge {
  score: number;
  text: number;
  time: number;
}

// DP 回溯标记：1=匹配(i,j)，2=跳过修订稿，3=跳过当前稿
const CHOICE_MATCH = 1;
const CHOICE_SKIP_REV = 2;
const CHOICE_SKIP_CUR = 3;

/**
 * 当前稿与修订稿的顺序保持一对一最大总分对齐。
 *
 * 只有综合得分 ≥ 0.45 的候选对才可匹配；动态规划在
 * 「匹配 / 跳过修订稿 / 跳过当前稿」三种转移中取最大值，
 * 同分时依次优先：匹配 → 跳过修订稿 → 跳过当前稿。
 */
export function alignSubtitles(current: Subtitle[], revision: Subtitle[]): MergeResult {
  const cur = prepare(current);
  const rev = prepare(revision);
  const n = cur.length;
  const m = rev.length;
  if (n === 0 || m === 0) {
    return {
      pairs: [],
      unmatchedCurrent: cur.map((c) => c.sub.index),
      unmatchedRevision: rev.map((r) => r.sub.index),
    };
  }

  const edgeKey = (i: number, j: number) => i * m + j;
  const edges = new Map<number, CandidateEdge>();

  // 带状半宽：带外格子 DP 不可达，候选无需枚举
  const band = Math.min(Math.max(n, m), Math.max(INDEX_BAND, Math.abs(n - m)));

  // 编辑距离复用行缓冲（宽度按最长的修订稿行 +1）
  const maxRow = rev.reduce((mx, r) => Math.max(mx, r.chars.length), 0) + 1;
  const edPrev = new Float64Array(maxRow);
  const edCurr = new Float64Array(maxRow);

  const consider = (i: number, j: number) => {
    if (Math.abs(i - j) > band) return;
    const key = edgeKey(i, j);
    if (edges.has(key)) return;
    const a = cur[i].chars;
    const b = rev[j].chars;
    const maxLen = Math.max(a.length, b.length, 1);
    const iou = intervalIoU(cur[i].sub.start, cur[i].sub.end, rev[j].sub.start, rev[j].sub.end);
    const dMax = maxAllowedDistance(maxLen, iou);
    if (Math.abs(a.length - b.length) > dMax) return;
    // 归一化后完全相同：编辑距离为 0，无需跑 DP
    const d =
      a.length === b.length && cur[i].norm === rev[j].norm
        ? 0
        : editDistanceWithin(a, b, dMax, edPrev, edCurr);
    if (d === null) return;
    const text = 1 - d / maxLen;
    const score = TEXT_WEIGHT * text + TIME_WEIGHT * iou;
    if (score < MATCH_THRESHOLD) return;
    edges.set(key, { score, text, time: iou });
  };

  // —— 候选对稀疏枚举 ——

  // ① 归一化文本完全一致（任意时间、任意序号距离；含两侧均为空文本）
  const exactMap = new Map<string, number[]>();
  rev.forEach((r, j) => {
    const list = exactMap.get(r.norm);
    if (list) list.push(j);
    else exactMap.set(r.norm, [j]);
  });
  cur.forEach((c, i) => {
    const list = exactMap.get(c.norm);
    if (!list) return;
    // list 按 j 升序插入，只枚举带状窗口内的修订稿
    for (const j of list) {
      if (j < i - band) continue;
      if (j > i + band) break;
      consider(i, j);
    }
  });

  // ② 时间区间有有效交集的对（按开始时间排序后双指针窗口枚举）
  const curOrder = [...cur.keys()].sort((p, q) => cur[p].sub.start - cur[q].sub.start);
  const revOrder = [...rev.keys()].sort((p, q) => rev[p].sub.start - rev[q].sub.start);
  let q0 = 0;
  for (const i of curOrder) {
    const aEnd = cur[i].sub.end;
    while (q0 < m && rev[revOrder[q0]].sub.end <= cur[i].sub.start) q0++;
    for (let q = q0; q < m; q++) {
      const j = revOrder[q];
      if (rev[j].sub.start >= aEnd) break;
      consider(i, j);
    }
  }

  // ③ 无时间交集的文本近邻：用字符二元组倒排索引做粗筛。
  // 编辑距离 ≤ d 时，b 中至多 2d 个二元组不在 a 中（每个编辑至多破坏 2 个二元组）。
  const postings = new Map<string, number[]>();
  const revBigrams: string[][] = rev.map((r) => [...new Set(bigrams(r.chars))]);
  revBigrams.forEach((bg, j) => {
    for (const g of bg) {
      const list = postings.get(g);
      if (list) list.push(j);
      else postings.set(g, [j]);
    }
  });
  cur.forEach((c, i) => {
    if (c.chars.length === 0) return;
    const own = new Set(bigrams(c.chars));
    // 命中计数：修订稿二元组中与当前稿共享的个数
    const hits = new Map<number, number>();
    for (const g of own) {
      const list = postings.get(g);
      if (!list) continue;
      // postings 按 j 升序插入；只统计带状窗口内的修订稿
      const lo = i - band;
      const hi = i + band;
      for (const j of list) {
        if (j < lo) continue;
        if (j > hi) break;
        hits.set(j, (hits.get(j) ?? 0) + 1);
      }
    }
    hits.forEach((shared, j) => {
      const bLen = rev[j].chars.length;
      const maxLen = Math.max(c.chars.length, bLen, 1);
      const limit = maxAllowedDistance(maxLen, 0); // 无 IoU 时的最宽松上限
      // rev[j] 不共享的二元组数 ≤ 2·d；二元组数 ≤ 字符数
      if (revBigrams[j].length - shared > 2 * limit) return;
      consider(i, j);
    });
  });

  // —— 带状顺序 DP ——
  const W = 2 * band + 1;
  const idx = (i: number, j: number): number => i * W + (j - i + band);
  const colLo = (i: number): number => Math.max(0, i - band);
  const colHi = (i: number): number => Math.min(m, i + band);

  // dp 用 NaN 表示带外不可达
  const dp = new Float64Array((n + 1) * W).fill(NaN);
  const choice = new Uint8Array((n + 1) * W);
  dp[idx(0, 0)] = 0;
  for (let j = 1; j <= colHi(0); j++) {
    dp[idx(0, j)] = 0;
    choice[idx(0, j)] = CHOICE_SKIP_REV;
  }
  for (let i = 1; i <= Math.min(n, band); i++) {
    dp[idx(i, 0)] = 0;
    choice[idx(i, 0)] = CHOICE_SKIP_CUR;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = colLo(i); j <= colHi(i); j++) {
      if (j === 0) continue; // 边界已初始化
      let best = -1;
      let pick = 0;

      // 优先级 1：匹配 (i-1, j-1)
      const edge = edges.get(edgeKey(i - 1, j - 1));
      if (edge) {
        best = dp[idx(i - 1, j - 1)] + edge.score;
        pick = CHOICE_MATCH;
      }
      // 优先级 2：跳过修订稿，来自 (i, j-1)
      if (j - 1 >= colLo(i)) {
        const left = dp[idx(i, j - 1)];
        if (left > best) {
          best = left;
          pick = CHOICE_SKIP_REV;
        }
      }
      // 优先级 3：跳过当前稿，来自 (i-1, j)
      if (j <= colHi(i - 1)) {
        const up = dp[idx(i - 1, j)];
        if (up > best) {
          best = up;
          pick = CHOICE_SKIP_CUR;
        }
      }

      dp[idx(i, j)] = best < 0 ? 0 : best;
      choice[idx(i, j)] = pick;
    }
  }

  // 回溯
  const pairs: MergePair[] = [];
  const matchedCur = new Uint8Array(n);
  const matchedRev = new Uint8Array(m);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i === 0) {
      j -= 1;
      continue;
    }
    if (j === 0) {
      i -= 1;
      continue;
    }
    switch (choice[idx(i, j)]) {
      case CHOICE_MATCH: {
        const edge = edges.get(edgeKey(i - 1, j - 1));
        i -= 1;
        j -= 1;
        if (edge) {
          pairs.push({
            currentIndex: cur[i].sub.index,
            revisionIndex: rev[j].sub.index,
            ...edge,
          });
          matchedCur[i] = 1;
          matchedRev[j] = 1;
        }
        break;
      }
      case CHOICE_SKIP_REV:
        j -= 1;
        break;
      default:
        i -= 1;
        break;
    }
  }
  pairs.reverse();

  const unmatchedCurrent: number[] = [];
  for (let x = 0; x < n; x++) {
    if (!matchedCur[x]) unmatchedCurrent.push(cur[x].sub.index);
  }
  const unmatchedRevision: number[] = [];
  for (let y = 0; y < m; y++) {
    if (!matchedRev[y]) unmatchedRevision.push(rev[y].sub.index);
  }

  return { pairs, unmatchedCurrent, unmatchedRevision };
}

/**
 * 应用合并：仅把已匹配的修订稿文本写回当前字幕，
 * id、序号、起止时间保持不变；返回新数组（不修改入参）。
 */
export function applyMerge(current: Subtitle[], revision: Subtitle[], result: MergeResult): Subtitle[] {
  const byIndex = new Map<number, string>();
  for (const sub of revision) byIndex.set(sub.index, sub.text);
  return current.map((sub) => {
    const pair = result.pairs.find((p) => p.currentIndex === sub.index);
    if (!pair) return sub;
    const text = byIndex.get(pair.revisionIndex);
    return text === undefined || text === sub.text ? sub : { ...sub, text };
  });
}
