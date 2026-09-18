import type { Subtitle } from './types';

/**
 * 术语校对：按本地术语表（每行「错误写法 => 标准写法」）扫描所选连续
 * 字幕区间，给出逐条替换预览，勾选后一次写入。
 *
 * 规则：
 *  - 匹配按 Unicode 大小写折叠（case folding）比较：先做 NFC 归一化与
 *    Unicode 简单小写映射（String.prototype.toLowerCase，覆盖一对一
 *    大小写映射，如 K / Å / θ / С），再展开常见的一对多全折叠（如
 *    ß / ẞ → ss、ΐ / ΰ 的分解形式、亚美尼亚大写 → 小写+ւ）；中文等
 *    无大小写文字原样参与比较，重音符号不会被折叠；
 *  - HTML 标签（<i>、<font …>、<!-- --> 等）整体跳过，不参与匹配，
 *    命中也不得跨越标签或物理换行；
 *  - 同一位置多条规则命中时，取错误写法字素簇更长者；等长按术语表
 *    顺序取靠前者；已选命中区间互不重叠（左起最长匹配）；
 *  - 替换基于原文一次拼接生成，标准写法原样插入，替换结果不会再次
 *    触发任何规则。
 */

// ---- Unicode 字素簇切分（与 reflow.ts 同一做法） ----

const segmenter: IntlSegmenter | null = (() => {
  const Ctor = (Intl as unknown as { Segmenter?: IntlSegmenterConstructor }).Segmenter;
  if (!Ctor) return null;
  try {
    return new Ctor(undefined, { granularity: 'grapheme' });
  } catch {
    return null;
  }
})();

interface Grapheme {
  text: string;
  index: number;
}

function graphemesOf(s: string): Grapheme[] {
  if (segmenter) return Array.from(segmenter.segment(s), (g) => ({ text: g.segment, index: g.index }));
  const out: Grapheme[] = [];
  let i = 0;
  for (const ch of s) {
    out.push({ text: ch, index: i });
    i += ch.length;
  }
  return out;
}

/** 字素簇数量（用于同位置多规则命中时的长度优先比较） */
export function graphemeCount(s: string): number {
  return graphemesOf(s).length;
}

// ---- Unicode 大小写折叠 ----

/** 按码点拼接，避免源文件中直接书写罕见字符 */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/**
 * 小写映射「之前」的一对多展开：toUpperCase/.toLowerCase 会丢失来源
 * 信息，必须在小写化之前展开。目前只有亚美尼亚大写字母（全折叠为
 * 对应小写 + ՙ U+0582，中世纪 յ ու 合字的遗存）。
 * 表内容按运行时小写映射推导，自动跳过区块中的空缺码点。
 */
const FOLD_PRE_LOWER = new Map<number, string>();
const FOLD_POST_LOWER = new Map<number, string>();
for (let upper = 0x0531; upper <= 0x0556; upper++) {
  const lower = cp(upper).toLowerCase();
  if ([...lower].length === 1) {
    const lcp = lower.codePointAt(0) ?? 0;
    if (lcp >= 0x0561 && lcp <= 0x0586) {
      FOLD_PRE_LOWER.set(upper, cp(lcp, 0x0582));
    }
  }
}
// 希腊带下写 iota（ypogegrammeni / prosgegrammeni）。C 状态全折叠为
// 「对应不带 iota 的小写元音（保留气息 / 重音）+ ι」。大写小写化后
// 得到带 iota 的预组小写（1F60–1FA7），这些小写再折叠到无 iota 元音；
// 因此 PRE 表（小写化之前）与 POST 表（小写化之后）给同一最终形式。
// 无 iota 目标取自 1F00–1F2F 区块（与带 iota 区块低 3 位一致，仅第
// 0x08/0x80 位不同）。
for (let i = 0; i < 8; i++) {
  // 小写带 iota 1F60/1F80/1F90/1FA0 系 → 无 iota 元音 1F00/1F10/1F20/1F28 系。
  // 1F28–1F2F 区块是大写（1F20–1F27 才是 ω 系小写），统一再走一次
  // toLowerCase 得到全折叠要求的小写元音。
  for (const [lowerBase, plainBase] of [
    [0x1f60, 0x1f00],
    [0x1f80, 0x1f10],
    [0x1f90, 0x1f20],
    [0x1fa0, 0x1f28],
  ] as const) {
    const folded = (cp(plainBase + i).toLowerCase() || cp(plainBase + i)) + cp(0x03b9);
    FOLD_POST_LOWER.set(lowerBase + i, folded);
    // 对应大写（码点 +8）小写化后落到该带 iota 小写：PRE 直接给最终形式
    FOLD_PRE_LOWER.set(lowerBase + 0x8 + i, folded);
  }
}
// 无气息系列：大写 ᾈ ᾉ …（1FB8/1FB9、1FC8/1FC9、1FCA/1FCB、1FCC）
// 与小写 ᾲ ᾳ ᾷ、ῂ ῃ ῇ、ῲ ῳ ῷ 等
for (const [code, plain, inPre] of [
  [0x1fb2, 0x03b1, false], [0x1fb3, 0x03b1, false], [0x1fb7, 0x03ac, false],
  [0x1fc2, 0x03b7, false], [0x1fc3, 0x03b7, false], [0x1fe7, 0x03ae, false],
  [0x1ff2, 0x03c9, false], [0x1ff3, 0x03c9, false], [0x1ff7, 0x03ce, false],
  [0x1fb8, 0x03b1, true], [0x1fb9, 0x03ac, true],
  [0x1fc8, 0x03b7, true], [0x1fc9, 0x03ae, true],
  [0x1fca, 0x03c9, true], [0x1fcb, 0x03ce, true],
  [0x1fcc, 0x03b9, true],
] as const) {
  const folded = cp(plain, 0x03b9);
  if (inPre) FOLD_PRE_LOWER.set(code, folded);
  else FOLD_POST_LOWER.set(code, folded);
}

/**
 * 小写映射「之后」的一对多展开。String.toLowerCase 已覆盖全部一对一
 * 简单小写映射（Kelvin K、Å、希腊 / 西里尔大写等），这里只补充折叠
 * 后码点数变多（或以不同码点表示）的常见情形。
 */
const FOLD_POST_LOWER_EXTRA: ReadonlyArray<readonly [number, string]> = [
  [0x00df, cp(0x73, 0x73)], // ß → ss
  [0x0149, cp(0x02bc, 0x6e)], // ŉ → ʼn（修饰符撇号 + n）
  [0x01f0, cp(0x6a, 0x030c)], // ǰ → j + 组合抑扬符
  [0x0390, cp(0x03b9, 0x0308, 0x0301)], // ΐ → ι + ¨ + ́（分解形式，不再合字）
  [0x03b0, cp(0x03c5, 0x0308, 0x0301)], // ΰ → υ + ¨ + ́
  [0x0587, cp(0x0565, 0x0582)], // և → ե ւ
  [0x1e9e, cp(0x73, 0x73)], // ẞ → ss（全折叠直接到位，与 ß 同形）
  [0x1fbe, cp(0x03b9)], // GREEK PROSGEGRAMMENI → ι
  [0x1fe5, cp(0x03c1)], // ῥ（带粗气息符的 ρ）→ ρ
];
for (const [code, folded] of FOLD_POST_LOWER_EXTRA) {
  FOLD_POST_LOWER.set(code, folded);
}

function eachCodePoint(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

/**
 * 折叠单个字素簇：NFC → 小写前展开 → 小写 → 小写后展开。
 * 展开结果直接作为最终折叠形式（展开即终止，不再二次扫描），因此
 * 替换结果不会二次触发；ẞ 直接展开为 ss，与 ß 同形。缓存避免重复
 * 计算同一字素。
 */
const foldMemo = new Map<string, string>();
function foldGrapheme(g: string): string {
  const nfc = g.normalize('NFC');
  const cached = foldMemo.get(nfc);
  if (cached !== undefined) return cached;

  let pre = '';
  for (const c of eachCodePoint(nfc)) {
    const e = FOLD_PRE_LOWER.get(c);
    pre += e !== undefined ? e : cp(c);
  }
  const lower = pre.toLowerCase();
  let out = '';
  for (const c of eachCodePoint(lower)) {
    const e = FOLD_POST_LOWER.get(c);
    out += e !== undefined ? e : cp(c);
  }
  foldMemo.set(nfc, out);
  return out;
}

/** 折叠任意字符串（按字素簇折叠后拼接） */
export function foldCase(s: string): string {
  let out = '';
  for (const g of graphemesOf(s)) out += foldGrapheme(g.text);
  return out;
}

// ---- 术语表解析 ----

export interface TermRule {
  /** 在术语表中的物理行号（从 1 开始，空行不计） */
  lineNo: number;
  /** 错误写法（去首尾空白，内部空白原样保留） */
  wrong: string;
  /** 标准写法 */
  standard: string;
  /** 错误写法的字素簇数：同位置多命中时更长者优先 */
  wrongGraphemes: number;
  /** 折叠后的错误写法，用于扫描 */
  foldedWrong: string;
}

export interface GlossaryIssue {
  lineNo: number;
  /** 该行原文（去首尾空白），用于面板提示 */
  raw: string;
  reason: string;
}

export interface ParsedGlossary {
  /** 是否存在禁用应用的问题（格式错误 / 空写法 / 重复错误写法） */
  ok: boolean;
  /** 可用规则（去重后，保持术语表顺序） */
  rules: TermRule[];
  issues: GlossaryIssue[];
  /** 非空物理行总数 */
  totalLines: number;
}

/**
 * 解析术语表：每行形如「错误写法 => 标准写法」。
 *  - 空行忽略；必须包含 ASCII 箭头 =>（多个箭头按第一个切分）；
 *  - 错误写法 / 标准写法去首尾空白后均不得为空；
 *  - 错误写法按折叠结果判重：不同写法折叠后相同（如 SS 与 ß）也算重复，
 *    保留先出现的一行，后续行报错。
 */
export function parseGlossary(raw: string): ParsedGlossary {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const rules: TermRule[] = [];
  const issues: GlossaryIssue[] = [];
  const seen = new Map<string, number>(); // folded wrong -> 首次出现行号
  let totalLines = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const lineNo = idx + 1;
    totalLines++;

    const arrow = trimmed.indexOf('=>');
    if (arrow === -1) {
      issues.push({ lineNo, raw: trimmed, reason: '缺少分隔符「=>」（每行格式：错误写法 => 标准写法）' });
      return;
    }
    const wrong = trimmed.slice(0, arrow).trim();
    const standard = trimmed.slice(arrow + 2).trim();
    if (!wrong) {
      issues.push({ lineNo, raw: trimmed, reason: '错误写法为空（=> 左侧不得为空）' });
      return;
    }
    if (!standard) {
      issues.push({ lineNo, raw: trimmed, reason: '标准写法为空（=> 右侧不得为空）' });
      return;
    }
    const foldedWrong = foldCase(wrong);
    const firstLine = seen.get(foldedWrong);
    if (firstLine !== undefined) {
      issues.push({
        lineNo,
        raw: trimmed,
        reason: `错误写法「${wrong}」与第 ${firstLine} 行重复（按 Unicode 大小写折叠判定）`,
      });
      return;
    }
    seen.set(foldedWrong, lineNo);
    rules.push({
      lineNo,
      wrong,
      standard,
      wrongGraphemes: graphemeCount(wrong),
      foldedWrong,
    });
  });

  return { ok: issues.length === 0, rules, issues, totalLines };
}

// ---- 区间 ----

/**
 * 解析连续字幕区间：按数组位置取 from / to 之间的切片（两端顺序可
 * 互换）；任一 id 不存在时返回 null。
 */
export function resolveTermRange(
  subs: Subtitle[],
  fromId: string | null,
  toId: string | null
): Subtitle[] | null {
  if (!fromId || !toId) return null;
  const i = subs.findIndex((s) => s.id === fromId);
  const j = subs.findIndex((s) => s.id === toId);
  if (i === -1 || j === -1) return null;
  return subs.slice(Math.min(i, j), Math.max(i, j) + 1);
}

// ---- 扫描 ----

/**
 * 识别 HTML 标签：注释、开闭标签（可带属性、自收尾），标签名须以
 * 字母开头（<3、a < b 之类仍按可见文字处理）。
 */
const HTML_TAG_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\s*\/?>/g;

interface Segment {
  /** 在整条字幕文本中的绝对起始下标（UTF-16） */
  start: number;
  text: string;
  tag: boolean;
}

/** 把文本切成标签段 / 文字段 */
function splitSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(HTML_TAG_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      segs.push({ start: last, text: text.slice(last, start), tag: false });
    }
    segs.push({ start, text: m[0], tag: true });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ start: last, text: text.slice(last), tag: false });
  return segs;
}

export interface TermHit {
  /** 命中的规则下标（ParsedGlossary.rules） */
  ruleIndex: number;
  /** 命中区间（绝对 UTF-16 偏移，绝不会落在标签上或跨越换行） */
  start: number;
  end: number;
  /** 命中文本（保留原文大小写） */
  matched: string;
}

export interface TermItem {
  id: string;
  index: number;
  start: number;
  end: number;
  original: string;
  /** 一次生成的改后文本 */
  result: string;
  hits: TermHit[];
  /** 改后与原文完全一致（如规则 WIFI => Wi-Fi 命中的原文恰为 Wi-Fi） */
  unchanged: boolean;
}

export interface TermPlan {
  items: TermItem[];
  targetCount: number;
  /** 命中总次数（含同一条内多次命中） */
  hitCount: number;
}

interface Candidate extends TermHit {
  /** 错误写法字素数：同起点时更长者优先 */
  len: number;
}

/**
 * 在单个物理行（不含标签、不含换行）内查找全部候选命中。
 * 通过「折叠文本 + 折叠码元→原始字素偏移」映射完成比较，命中区间
 * 映射回原始码元；只接受起止落在字素簇边界上的匹配（避免 ZWJ 表情
 * 等组合序列被折叠后的公共子串截断）。
 */
function scanTextLine(line: string, lineStart: number, rules: TermRule[]): Candidate[] {
  const graphemes = graphemesOf(line);
  let folded = '';
  // 折叠后每个 UTF-16 码元对应原始字素的起止偏移
  const unitStart: number[] = [];
  const unitEnd: number[] = [];
  // 折叠字符串中的字素簇边界（码元偏移）
  const boundaries = new Set<number>([0]);
  for (const g of graphemes) {
    const f = foldGrapheme(g.text);
    for (let k = 0; k < f.length; k++) {
      unitStart.push(g.index);
      unitEnd.push(g.index + g.text.length);
    }
    folded += f;
    boundaries.add(folded.length);
  }
  if (!folded) return [];

  const cands: Candidate[] = [];
  rules.forEach((rule, ruleIndex) => {
    const needle = rule.foldedWrong;
    if (!needle || needle.length > folded.length) return;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at === -1) break;
      const fe = at + needle.length;
      // 折叠串内部也可能存在字素边界（错误写法本身含多个字素），
      // 只需匹配两端对齐即可：中间边界不影响映射正确性
      if (boundaries.has(at) && boundaries.has(fe)) {
        const start = lineStart + unitStart[at];
        const end = lineStart + unitEnd[fe - 1];
        cands.push({
          ruleIndex,
          start,
          end,
          matched: line.slice(unitStart[at], unitEnd[fe - 1]),
          len: rule.wrongGraphemes,
        });
      }
      // 至少前进一个折叠码元，允许重叠候选（再由左起最长规则去重）
      from = at + 1;
    }
  });
  return cands;
}

/** 扫描单条字幕：跳过标签与换行，左起最长匹配选取互不重叠命中 */
export function scanSubtitle(sub: Subtitle, rules: TermRule[]): TermItem | null {
  const candidates: Candidate[] = [];
  for (const seg of splitSegments(sub.text)) {
    if (seg.tag) continue;
    // 命中不得跨越物理换行：按 \n 切分后逐行扫描，偏移加回行首
    let lineStart = seg.start;
    for (const line of seg.text.split('\n')) {
      if (line) candidates.push(...scanTextLine(line, lineStart, rules));
      lineStart += line.length + 1;
    }
  }
  if (candidates.length === 0) return null;

  // 左起最长：起点靠前优先；同起点错误写法字素数更长优先；
  // 等长（等字素）时术语表中更靠前的规则优先
  candidates.sort((a, b) => a.start - b.start || b.len - a.len || a.ruleIndex - b.ruleIndex);

  const hits: TermHit[] = [];
  let occupiedEnd = -1;
  for (const c of candidates) {
    if (c.start < occupiedEnd) continue; // 与已选命中重叠，丢弃
    hits.push({ ruleIndex: c.ruleIndex, start: c.start, end: c.end, matched: c.matched });
    occupiedEnd = c.end;
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.start - b.start);

  // 基于原文一次拼接：标准写法原样插入，之后不再扫描（替换结果不会再次触发规则）
  let result = '';
  let cur = 0;
  for (const h of hits) {
    result += sub.text.slice(cur, h.start);
    result += rules[h.ruleIndex].standard;
    cur = h.end;
  }
  result += sub.text.slice(cur);

  return {
    id: sub.id,
    index: sub.index,
    start: sub.start,
    end: sub.end,
    original: sub.text,
    result,
    hits,
    unchanged: result === sub.text,
  };
}

/** 扫描整个连续区间 */
export function planTermProof(targets: Subtitle[], rules: TermRule[]): TermPlan {
  const items: TermItem[] = [];
  let hitCount = 0;
  for (const sub of targets) {
    const item = scanSubtitle(sub, rules);
    if (item) {
      items.push(item);
      hitCount += item.hits.length;
    }
  }
  return { items, targetCount: targets.length, hitCount };
}

/**
 * 应用方案：仅写入被勾选且文本确有变化的条目，其余字幕原样保留；
 * 返回新数组（不修改入参）。
 */
export function applyTermProof(
  subs: Subtitle[],
  plan: TermPlan,
  checkedIds: Set<string>
): Subtitle[] {
  const byId = new Map(
    plan.items.filter((it) => !it.unchanged && checkedIds.has(it.id)).map((it) => [it.id, it])
  );
  return subs.map((s) => {
    const it = byId.get(s.id);
    return it ? { ...s, text: it.result } : s;
  });
}
