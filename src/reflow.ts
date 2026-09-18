import type { Subtitle } from './types';

/**
 * 断行重排：在不改变可见文字顺序与标签内容的前提下，把所选连续区间内
 * 每条字幕重排为一行或两行。
 *
 * 规则：
 *  - 仅 i / b / u / font（含属性，大小写不敏感）标签识别为标签，标签
 *    不占行宽，其余可见内容按 Unicode 字素簇（grapheme cluster）计数；
 *  - 候选断点不得使行首出现闭合标点，或行尾出现起始标点（指断点两侧
 *    新产生的行首 / 行尾；标签与边缘空白不参与判定）；
 *  - 单行不超限时优先单行；两行方案均不超限时，依次比较
 *    最大行长最小 → 两行长度差最小 → 断点最靠前（左侧文字最短）；
 *  - 单行已超限且不存在可行两行断点时，不改该条并标出具体原因。
 */

/** 标签 token：保存原始标签字符串，不计入行宽 */
interface TagToken {
  kind: 'tag';
  text: string;
}

/** 文字 token：一个 Unicode 字素簇（空白也是一个字素簇） */
interface TextToken {
  kind: 'text';
  text: string;
  /** 字素簇是否为纯空白 */
  space: boolean;
}

type Token = TagToken | TextToken;

/**
 * 行内 SRT 常见排版标签：i / b / u（无属性或带属性）、font（必带
 * 属性，容忍属性中出现 > 以外的任意字符）；对大小写不敏感。
 * 非此集合的尖括号内容按可见文字处理。
 */
const TAG_RE = /<\/?(?:[ibu](?:\s[^<>]*)?|font(?:\s+[^<>]+)?\s*)>/gi;

/**
 * 起始标点（不得出现在行尾）：各类开括号 / 开引号，含 ASCII、CJK
 * 全角、角括号与补充标点区块中的成对起始符。逗号、冒号等在行末常见，
 * 不计入。全部用码点构造，避免源文件字符集问题。
 */
const OPEN_PUNCT_CODEPOINTS = new Set<number>([
  // ASCII 与拉丁补充
  0x28, 0x5b, 0x7b, // ( [ {
  0xab, 0x2039, // « ‹
  0x2018, 0x201c, 0x201e, 0x201f, // ‘ “ „ ‟
  // 一般标点 / 上标下标 / 货币周边的开括号
  0x2045, 0x207d, 0x208d, // ⁅ ⁽ ₍
  0x2768, 0x276a, 0x276c, 0x276e, 0x2770, 0x2772, 0x2774, // ❨❪❬❮❰❲❴
  0x27e6, 0x27e8, 0x27ea, 0x27ec, 0x27ee, // ⟦ ⟨ ⟪ ⟬ ⟮
  0x2983, 0x2985, 0x2987, 0x2989, 0x298b, 0x298d, 0x298f, 0x2991, 0x2993,
  0x2995, 0x2997, // 各种花括号
  0x29d8, 0x29da, 0x29fc, // ⧘ ⧚ ⧼
  0x2e02, 0x2e04, // ⸂ ⸄
  0x2e09, 0x2e0c, 0x2e1c, // ⸉ ⸌ ⸜
  0x2e20, 0x2e21, // ⸠ ⸡
  0x3008, 0x300a, 0x300c, 0x300e, 0x3010, 0x3014, 0x3016, 0x3018, 0x301a, 0x301d,
  // CJK：〈 《 「 『 【 〔 〖 〘 〚 〝
  0xfe41, 0xfe43, 0xfe47, // ﹁ ﹃ ﹇
  0xff3b, 0xff5b, 0xff5f, // ［ ｛ ｟
  0xff08, // （
]);

/**
 * 闭合标点（不得出现在行首）：闭括号 / 闭引号、句末与句读符号，
 * 含 ASCII、CJK 全角及常见补充标点；省略号视为行末符号。
 */
const CLOSE_PUNCT_CODEPOINTS = new Set<number>([
  // ASCII
  0x29, 0x5d, 0x7d, // ) ] }
  0x2e, 0x2c, 0x3b, 0x3a, 0x21, 0x3f, 0x25, // . , ; : ! ? %
  // 拉丁 / 一般标点
  0xbb, 0x203a, // » ›
  0x2019, 0x201d, // ’ ”
  0x2026, 0x2030, 0x2031, // … ‰ ‱
  0x2032, 0x2033, 0x2034, 0x2035, 0x2036, 0x2037, // ′″‴‵‶‷
  0x203c, 0x203d, 0x2047, 0x2048, 0x2049, // ‼ ‽ ⁇ ⁈ ⁉
  0x2769, 0x276b, 0x276d, 0x276f, 0x2771, 0x2773, 0x2775, // ❩❫❭❯❱❳❵
  0x27e7, 0x27e9, 0x27eb, 0x27ed, 0x27ef,
  0x2984, 0x2986, 0x2988, 0x298a, 0x298c, 0x298e, 0x2990, 0x2992, 0x2994,
  0x2996, 0x2998,
  0x29d9, 0x29db, 0x29fd,
  0x2e03, 0x2e05, 0x2e0a, 0x2e0d, 0x2e1d,
  0x2e22, 0x2e23, // ⸢ 等的闭合侧
  // CJK 标点
  0x3002, // 。
  0x3001, // 、
  0xff0c, // ，
  0xff0e, // ．
  0xff1a, // ：
  0xff1b, // ；
  0xff01, // ！
  0xff1f, // ？
  0xff09, // ）
  0xff3d, // ］
  0xff5d, // ｝
  0xff60, 0xff61, // ｠ ｡
  0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b, 0x301e, 0x301f,
  // 〉 》 」 』 】 〕 〗 〙 〛 〞 〟
  0xfe42, 0xfe44, 0xfe48, // ﹂ ﹄ ﹈
  0xff05, // ％
]);

/** 字素簇首码点 */
function firstCodePoint(g: string): number {
  return g.codePointAt(0) ?? 0;
}

function isOpenPunct(g: string): boolean {
  return OPEN_PUNCT_CODEPOINTS.has(firstCodePoint(g));
}

function isClosePunct(g: string): boolean {
  return CLOSE_PUNCT_CODEPOINTS.has(firstCodePoint(g));
}

/** 纯空白字素簇判定（覆盖常见水平 / 全角空白，不含换行——换行已在分词前去除） */
const SPACE_CODEPOINTS = new Set<number>([
  0x09, 0x0b, 0x0c, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

function isSpaceGrapheme(g: string): boolean {
  for (const ch of g) {
    if (!SPACE_CODEPOINTS.has(ch.codePointAt(0) ?? 0)) return false;
  }
  return g.length > 0;
}

// ---- Unicode 字素簇切分 ----

const segmenter: IntlSegmenter | null = (() => {
  const Ctor = (Intl as unknown as { Segmenter?: IntlSegmenterConstructor }).Segmenter;
  if (!Ctor) return null;
  try {
    return new Ctor(undefined, { granularity: 'grapheme' });
  } catch {
    return null;
  }
})();

/** 把字符串切成 Unicode 字素簇；Intl.Segmenter 不可用时回退到码点切分 */
function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (gr) => gr.segment);
  return Array.from(s);
}

// ---- 分词 ----

/**
 * 把一条字幕的文本切成 token：标签 + 字素簇。
 * 原有换行直接去除（各物理行按可见顺序首尾相接；行内空白原样保留，
 * 不折叠也不新增），重排时再按方案插入至多一个换行。
 */
function tokenize(text: string): Token[] {
  const flat = text.replace(/\r\n?/g, '\n').replace(/\n+/g, '');
  const tokens: Token[] = [];
  let last = 0;
  for (const m of flat.matchAll(TAG_RE)) {
    const start = m.index ?? 0;
    if (start > last) appendGraphemes(tokens, flat.slice(last, start));
    const tag = m[0];
    tokens.push({ kind: 'tag', text: tag });
    last = start + tag.length;
  }
  if (last < flat.length) appendGraphemes(tokens, flat.slice(last));
  return tokens;
}

function appendGraphemes(tokens: Token[], s: string) {
  for (const g of graphemes(s)) {
    tokens.push({ kind: 'text', text: g, space: isSpaceGrapheme(g) });
  }
}

/** token 子段的可见字素数（标签不计） */
function visibleCount(tokens: Token[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (tokens[i].kind === 'text') n++;
  return n;
}

/** token 子段中第一个非空白文字 token 的下标；没有则 -1 */
function firstContent(tokens: Token[], from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind === 'text' && !t.space) return i;
  }
  return -1;
}

/** token 子段中最后一个非空白文字 token 的下标；没有则 -1 */
function lastContent(tokens: Token[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) {
    const t = tokens[i];
    if (t.kind === 'text' && !t.space) return i;
  }
  return -1;
}

/**
 * 把 token 子段渲染成行：去掉两端的空白字素（标签保留在原位）。
 * 返回行文本与裁掉边缘空白后的 [lo, hi) 下标。
 */
function renderLine(
  tokens: Token[],
  from: number,
  to: number
): { text: string; lo: number; hi: number } {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const t = tokens[lo];
    if (t.kind === 'tag' || !t.space) break;
    lo++;
  }
  while (hi > lo) {
    const t = tokens[hi - 1];
    if (t.kind === 'tag' || !t.space) break;
    hi--;
  }
  let text = '';
  for (let i = lo; i < hi; i++) {
    const t = tokens[i];
    text += t.kind === 'tag' ? t.text : t.text;
  }
  return { text, lo, hi };
}

/** 单条字幕的重排结果 */
export interface ReflowItem {
  id: string;
  index: number;
  start: number;
  end: number;
  /** 原文（含原换行） */
  original: string;
  /** 是否存在可行方案 */
  ok: boolean;
  /** 不可行原因（ok 为 false 时给出） */
  reason: string | null;
  /** 重排后的行数（1 或 2；不可行时为 null） */
  lines: number | null;
  /** 重排文本（不可行时为 null） */
  result: string | null;
  /** 两行各自的可见字素数（单行时第二项为 0；不可行时为 null） */
  lineLengths: [number, number] | null;
  /** 重排后文本是否与原文完全一致（已是最佳排版时无需写入） */
  unchanged: boolean;
}

/** 整批重排方案 */
export interface ReflowPlan {
  items: ReflowItem[];
  /** 可行条数 */
  feasible: number;
  /** 不可行条数 */
  infeasible: number;
  /** 可行且文本确有变化的条数 */
  changed: number;
}

/**
 * 解析「每行最大字素数」输入：须为不小于 1 的整数。
 */
export function parseMaxWidth(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * 解析字幕区间：按字幕在数组中的位置取 from / to 之间的连续切片
 * （两端顺序可互换）；任一 id 不存在时返回 null。
 */
export function resolveReflowRange(
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

interface BestCut {
  left: { text: string; lo: number; hi: number };
  right: { text: string; lo: number; hi: number };
  l1: number;
  l2: number;
}

/**
 * 计算一条字幕的重排方案。
 *
 * 枚举 token 序列的所有切点（1..T-1），每个切点渲染为两行并裁掉各自
 * 边缘空白；要求两行均有可见文字、行长均不超限，且断入行首（跳过
 * 标签 / 边缘空白）不是闭合标点、断出行尾不是起始标点。可行切点
 * 之间依次比较最大行长、行长度差；两者都相同的切点渲染结果一致，
 * 保留最先枚举到的，即断点最靠前。单行本身不超限时直接采用单行。
 */
export function planReflowOne(sub: Subtitle, maxWidth: number): ReflowItem {
  const base = {
    id: sub.id,
    index: sub.index,
    start: sub.start,
    end: sub.end,
    original: sub.text,
  };

  const makeFail = (reason: string): ReflowItem => ({
    ...base,
    ok: false,
    reason,
    lines: null,
    result: null,
    lineLengths: null,
    unchanged: false,
  });

  const tokens = tokenize(sub.text);
  const total = visibleCount(tokens, 0, tokens.length);
  const contentTokens = tokens.filter((t) => t.kind === 'text' && !t.space).length;

  if (total === 0 || contentTokens === 0) {
    return makeFail('没有可见文字（空文本或仅含标签 / 空白），无需重排');
  }

  // 单行方案：所有 token 拼接后裁掉两端边缘空白
  const one = renderLine(tokens, 0, tokens.length);
  const oneLen = visibleCount(tokens, one.lo, one.hi);
  if (oneLen <= maxWidth) {
    return {
      ...base,
      ok: true,
      reason: null,
      lines: 1,
      result: one.text,
      lineLengths: [oneLen, 0],
      unchanged: one.text === sub.text,
    };
  }

  // 单行超限：枚举两行切点
  let best: BestCut | null = null;
  let lengthFail = 0;
  let punctFail = 0;

  for (let cut = 1; cut < tokens.length; cut++) {
    const left = renderLine(tokens, 0, cut);
    const right = renderLine(tokens, cut, tokens.length);
    const l1 = visibleCount(tokens, left.lo, left.hi);
    const l2 = visibleCount(tokens, right.lo, right.hi);
    if (l1 === 0 || l2 === 0) continue;
    if (l1 > maxWidth || l2 > maxWidth) {
      lengthFail++;
      continue;
    }
    // 断点两侧的行尾 / 行首（标签与边缘空白不参与判定）
    const leftLast = lastContent(tokens, left.lo, left.hi);
    const rightFirst = firstContent(tokens, right.lo, right.hi);
    if (leftLast === -1 || rightFirst === -1) continue;
    const leftTail = tokens[leftLast] as TextToken;
    const rightHead = tokens[rightFirst] as TextToken;
    if (isOpenPunct(leftTail.text)) {
      punctFail++;
      continue;
    }
    if (isClosePunct(rightHead.text)) {
      punctFail++;
      continue;
    }
    if (
      !best ||
      Math.max(l1, l2) < Math.max(best.l1, best.l2) ||
      (Math.max(l1, l2) === Math.max(best.l1, best.l2) &&
        Math.abs(l1 - l2) < Math.abs(best.l1 - best.l2))
    ) {
      best = { left, right, l1, l2 };
    }
  }

  if (!best) {
    if (lengthFail > 0) {
      return makeFail(
        `单行已有 ${oneLen} 个字素（上限 ${maxWidth}），且不存在两行均不超限的断点`
      );
    }
    if (punctFail > 0) {
      return makeFail('所有等长断点都会使行首出现闭合标点或行尾出现起始标点，无合规断点');
    }
    return makeFail('找不到可断行的位置（文字间没有可插入换行的间隙）');
  }

  const result = `${best.left.text}\n${best.right.text}`;
  return {
    ...base,
    ok: true,
    reason: null,
    lines: 2,
    result,
    lineLengths: [best.l1, best.l2],
    unchanged: result === sub.text,
  };
}

/** 计算整个区间的重排方案 */
export function planReflow(targets: Subtitle[], maxWidth: number): ReflowPlan {
  const items = targets.map((s) => planReflowOne(s, maxWidth));
  return {
    items,
    feasible: items.filter((it) => it.ok).length,
    infeasible: items.filter((it) => !it.ok).length,
    changed: items.filter((it) => it.ok && !it.unchanged).length,
  };
}

/**
 * 应用方案：仅写入被勾选且文本确有变化的条目，其余字幕原样保留；
 * 返回新数组（不修改入参）。selectedIds 未指定时写入全部可行条目。
 */
export function applyReflow(
  subs: Subtitle[],
  plan: ReflowPlan,
  selectedIds?: Set<string>
): Subtitle[] {
  const byId = new Map(
    plan.items
      .filter((it) => it.ok && !it.unchanged && (!selectedIds || selectedIds.has(it.id)))
      .map((it) => [it.id, it])
  );
  return subs.map((s) => {
    const it = byId.get(s.id);
    if (!it || it.result === null) return s;
    return { ...s, text: it.result };
  });
}
