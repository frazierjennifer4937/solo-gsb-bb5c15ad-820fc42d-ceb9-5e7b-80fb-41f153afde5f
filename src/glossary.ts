import type { Subtitle } from './types';

/**
 * 术语校对：按本地术语表（每行「错误写法 => 标准写法」）扫描所选连续
 * 字幕区间，把命中错误写法的字幕文本改写为标准写法。
 *
 * 规则：
 *  - 匹配按 Unicode 简单大小写折叠比较（逐字素 NFC 归一化 + toLowerCase），
 *    中文等无大小写文字原样参与比较；
 *  - i / b / u / font 标签（与断行重排同一套识别规则）不参与匹配，
 *    且作为匹配边界：一次命中不会跨越标签，标签本身也不会被改写；
 *  - 同一可见位置多条命中时，优先错误写法字素数更长的词条；已选命中
 *    互不重叠（从左到右贪心，选中后跳过整段命中长度）；
 *  - 替换基于原文一次生成：所有命中都针对原始文本计算并一次性拼接，
 *    替换结果不会再次触发任何词条。
 */

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

/** 比较键：NFC 归一化 + Unicode 简单大小写折叠（toLowerCase） */
function foldKey(g: string): string {
  return g.normalize('NFC').toLowerCase();
}

// ---- 术语表解析 ----

export interface GlossaryEntry {
  /** 术语表中的行号（从 1 开始，用于提示与展示） */
  line: number;
  /** 错误写法（trim 后的原始文本） */
  wrong: string;
  /** 标准写法（trim 后的原始文本） */
  right: string;
  /** 错误写法逐字素的比较键 */
  keys: string[];
  /** 错误写法的字素数（同位置命中取更长） */
  length: number;
}

export interface GlossaryParse {
  entries: GlossaryEntry[];
  /** 校验错误（重复错误写法 / 空写法 / 空标准写法 / 缺少分隔符），非空时禁用应用 */
  errors: string[];
}

/**
 * 解析术语表：每行「错误写法 => 标准写法」，空行忽略；
 * 错误写法 / 标准写法为空、缺少「=>」、错误写法重复（按比较键判定）
 * 都记为错误，有错误时整条术语表不可用。
 */
export function parseGlossary(raw: string): GlossaryParse {
  const errors: string[] = [];
  const entries: GlossaryEntry[] = [];
  const seen = new Map<string, number>();
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const text = lines[idx].trim();
    if (text === '') continue; // 空行忽略
    const sep = text.indexOf('=>');
    if (sep === -1) {
      errors.push(`第 ${lineNo} 行：缺少「=>」分隔符（格式：错误写法 => 标准写法）`);
      continue;
    }
    const wrong = text.slice(0, sep).trim();
    const right = text.slice(sep + 2).trim();
    if (wrong === '') {
      errors.push(`第 ${lineNo} 行：错误写法为空`);
      continue;
    }
    if (right === '') {
      errors.push(`第 ${lineNo} 行：标准写法为空`);
      continue;
    }
    const keys = graphemes(wrong).map(foldKey);
    // 控制字符作分隔，避免 ['ab','c'] 与 ['a','bc'] 拼接后相同
    const dupKey = keys.join('\u0001');
    const first = seen.get(dupKey);
    if (first !== undefined) {
      errors.push(
        `第 ${lineNo} 行：错误写法「${wrong}」与第 ${first} 行重复（大小写折叠后相同）`
      );
      continue;
    }
    seen.set(dupKey, lineNo);
    entries.push({ line: lineNo, wrong, right, keys, length: keys.length });
  }

  // 同一位置多条命中取字素数更长者：按字素数降序，等长保持术语表内先后顺序
  entries.sort((a, b) => b.length - a.length || a.line - b.line);
  return { entries, errors };
}

/**
 * 解析字幕区间：按字幕在数组中的位置取 from / to 之间的连续切片
 * （两端顺序可互换）；任一 id 不存在时返回 null。
 */
export function resolveGlossaryRange(
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

// ---- 分词 ----

/** 标签 token：保存原始标签字符串，不参与匹配，且作为匹配边界 */
interface TagToken {
  kind: 'tag';
  text: string;
}

/** 文字 token：一个 Unicode 字素簇（含换行），key 为比较键 */
interface TextToken {
  kind: 'text';
  text: string;
  key: string;
}

type Token = TagToken | TextToken;

/**
 * 行内 SRT 常见排版标签：i / b / u / font（与断行重排同一套规则，
 * 大小写不敏感）；非此集合的尖括号内容按可见文字处理。
 */
const TAG_RE = /<\/?(?:[ibu](?:\s[^<>]*)?|font(?:\s+[^<>]+)?\s*)>/gi;

/** 把字幕文本切成 token：标签 + 字素簇；原有换行作为字素簇原样保留 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index ?? 0;
    if (start > last) appendText(tokens, text.slice(last, start));
    tokens.push({ kind: 'tag', text: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) appendText(tokens, text.slice(last));
  return tokens;
}

function appendText(tokens: Token[], s: string) {
  for (const g of graphemes(s)) {
    tokens.push({ kind: 'text', text: g, key: foldKey(g) });
  }
}

// ---- 扫描 ----

export interface GlossaryHit {
  /** 命中词条在术语表中的行号 */
  line: number;
  /** 命中词条的错误写法 / 标准写法 */
  wrong: string;
  right: string;
  /** 命中区间（token 下标 [from, to)，均为文字 token） */
  from: number;
  to: number;
  /** 命中的原文片段 */
  matched: string;
}

/** 词条是否在 token 序列 pos 处命中（标签是边界：命中不得跨越标签） */
function matchAt(tokens: Token[], pos: number, e: GlossaryEntry): boolean {
  if (pos + e.length > tokens.length) return false;
  for (let k = 0; k < e.length; k++) {
    const t = tokens[pos + k];
    if (t.kind !== 'text') return false;
    if (t.key !== e.keys[k]) return false;
  }
  return true;
}

/**
 * 在 token 序列中从左到右贪心选取命中：每个位置取字素数最长的命中词条
 * （entries 已按字素数降序），选中后跳过整段命中长度，保证已选命中
 * 互不重叠。所有命中都针对原始文本计算。
 */
function findHits(tokens: Token[], entries: GlossaryEntry[]): GlossaryHit[] {
  const hits: GlossaryHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].kind !== 'text') {
      i++;
      continue;
    }
    let matched: GlossaryEntry | null = null;
    for (const e of entries) {
      if (matchAt(tokens, i, e)) {
        matched = e;
        break;
      }
    }
    if (matched) {
      hits.push({
        line: matched.line,
        wrong: matched.wrong,
        right: matched.right,
        from: i,
        to: i + matched.length,
        matched: tokens
          .slice(i, i + matched.length)
          .map((t) => t.text)
          .join(''),
      });
      i += matched.length;
    } else {
      i++;
    }
  }
  return hits;
}

/** 基于原文一次生成替换结果：命中段替换为标准写法，其余 token 原样拼接 */
function rebuild(tokens: Token[], hits: GlossaryHit[]): string {
  const byFrom = new Map(hits.map((h) => [h.from, h]));
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const hit = byFrom.get(i);
    if (hit) {
      out += hit.right; // 替换结果不再参与匹配
      i = hit.to;
    } else {
      out += tokens[i].text;
      i++;
    }
  }
  return out;
}

/** 单条字幕的校对结果（仅收录有命中且文本确有变化的字幕） */
export interface GlossaryItem {
  id: string;
  index: number;
  start: number;
  /** 原文（含原换行与标签） */
  original: string;
  /** 校对后的文本 */
  result: string;
  /** 命中规则（按出现位置排序） */
  hits: GlossaryHit[];
}

/** 整批校对方案 */
export interface GlossaryPlan {
  items: GlossaryItem[];
  /** 区间总条数 */
  targetCount: number;
  /** 命中总处数 */
  hitCount: number;
}

/** 扫描整个区间：仅收录有命中且替换后文本确有变化的字幕 */
export function scanGlossary(targets: Subtitle[], entries: GlossaryEntry[]): GlossaryPlan {
  const items: GlossaryItem[] = [];
  let hitCount = 0;
  for (const s of targets) {
    const tokens = tokenize(s.text);
    const hits = findHits(tokens, entries);
    if (hits.length === 0) continue;
    const result = rebuild(tokens, hits);
    if (result === s.text) continue; // 替换后无实际变化（如错误写法与标准写法相同）
    items.push({ id: s.id, index: s.index, start: s.start, original: s.text, result, hits });
    hitCount += hits.length;
  }
  return { items, targetCount: targets.length, hitCount };
}

/**
 * 应用方案：仅写入被勾选的条目，其余字幕原样保留；
 * 返回新数组（不修改入参）。
 */
export function applyGlossary(
  subs: Subtitle[],
  plan: GlossaryPlan,
  checkedIds: Set<string>
): Subtitle[] {
  const byId = new Map(
    plan.items.filter((it) => checkedIds.has(it.id)).map((it) => [it.id, it])
  );
  return subs.map((s) => {
    const it = byId.get(s.id);
    return it ? { ...s, text: it.result } : s;
  });
}
