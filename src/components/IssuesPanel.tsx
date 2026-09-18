import type { Subtitle } from '../types';
import type { IssueType } from '../issues';
import { formatTimestamp } from '../srt';

const LABELS: Record<IssueType, string> = {
  overlap: '重叠',
  inverted: '倒置',
  short: '过短',
};

interface IssuesPanelProps {
  subs: Subtitle[];
  issues: Map<string, Set<IssueType>>;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
}

export default function IssuesPanel({ subs, issues, selectedId, onJump }: IssuesPanelProps) {
  const entries = subs.filter((s) => issues.has(s.id));
  const counts: Record<IssueType, number> = { overlap: 0, inverted: 0, short: 0 };
  issues.forEach((set) => set.forEach((t) => counts[t]++));

  return (
    <aside className="issues-panel">
      <div className="issues-header">
        <span className="issues-title">问题检测</span>
        <span className="issue-counts">
          <b className="c-overlap">{counts.overlap} 重叠</b>
          <b className="c-inverted">{counts.inverted} 倒置</b>
          <b className="c-short">{counts.short} 过短</b>
        </span>
      </div>
      <div className="issues-list">
        {subs.length === 0 && <div className="issues-empty">尚未导入字幕</div>}
        {subs.length > 0 && entries.length === 0 && (
          <div className="issues-empty ok">✅ 未发现问题</div>
        )}
        {entries.map((s) => (
          <button
            key={s.id}
            className={`issue-row ${s.id === selectedId ? 'active' : ''}`}
            onClick={() => onJump(s.id, Math.max(0, s.start) / 1000)}
            title={s.text}
          >
            <span className="issue-title">
              #{s.index} · {formatTimestamp(s.start)}
            </span>
            <span className="issue-badges">
              {[...(issues.get(s.id) ?? [])].map((t) => (
                <i key={t} className={`badge badge-${t}`}>
                  {LABELS[t]}
                </i>
              ))}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
