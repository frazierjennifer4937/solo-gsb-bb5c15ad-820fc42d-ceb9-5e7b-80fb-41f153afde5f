import type { Subtitle } from './types';

export type IssueType = 'overlap' | 'inverted' | 'short';

export const MIN_DURATION_MS = 500;

/**
 * 实时检测三类问题：
 * - overlap  时间重叠（与任意其他字幕区间相交）
 * - inverted 起止倒置（end <= start）
 * - short    时长短于 500ms
 */
export function detectIssues(subs: Subtitle[]): Map<string, Set<IssueType>> {
  const map = new Map<string, Set<IssueType>>();
  const add = (id: string, type: IssueType) => {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    set.add(type);
  };

  for (const s of subs) {
    if (s.end <= s.start) add(s.id, 'inverted');
    else if (s.end - s.start < MIN_DURATION_MS) add(s.id, 'short');
  }

  const sorted = [...subs].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start >= sorted[i].end) break; // 之后不可能再与 i 重叠
      add(sorted[i].id, 'overlap');
      add(sorted[j].id, 'overlap');
    }
  }
  return map;
}
