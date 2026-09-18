import { useRef } from 'react';
import type { Subtitle } from '../types';
import type { MergeResult } from '../merge';
import { MATCH_THRESHOLD } from '../merge';
import { formatTimestamp } from '../srt';

interface RevisionMergePanelProps {
  subs: Subtitle[];
  revision: Subtitle[];
  revisionName: string;
  result: MergeResult | null;
  selectedId: string | null;
  onImportRevision: (file: File) => void;
  onApply: () => void;
  onClear: () => void;
  onJump: (id: string, sec: number) => void;
}

function scoreClass(score: number): string {
  if (score >= 0.75) return 'score-high';
  if (score >= 0.6) return 'score-mid';
  return 'score-low';
}

export default function RevisionMergePanel({
  subs,
  revision,
  revisionName,
  result,
  selectedId,
  onImportRevision,
  onApply,
  onClear,
  onJump,
}: RevisionMergePanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const currentByIndex = new Map(subs.map((s) => [s.index, s]));
  const revisionByIndex = new Map(revision.map((s) => [s.index, s]));

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImportRevision(file);
    e.target.value = '';
  };

  const renderUnmatchedRow = (
    s: Subtitle,
    side: 'current' | 'revision',
    keyPrefix: string
  ) => (
    <div
      key={`${keyPrefix}-${s.index}`}
      className={`merge-unmatched-row ${side} ${s.id === selectedId ? 'active' : ''}`}
      title={s.text}
      onClick={side === 'current' ? () => onJump(s.id, Math.max(0, s.start) / 1000) : undefined}
    >
      <span className="merge-idx">
        #{s.index} · {formatTimestamp(s.start)}
      </span>
      <span className="merge-text">{s.text || '（空文本）'}</span>
    </div>
  );

  return (
    <aside className="merge-panel">
      <div className="merge-header">
        <span className="merge-title">修订稿合并</span>
        <button
          className="btn primary btn-sm"
          disabled={subs.length === 0}
          onClick={() => fileRef.current?.click()}
          title={subs.length === 0 ? '请先导入当前字幕' : '再导入一份 SRT 作为修订稿，不会替换当前时间轴'}
        >
          📥 导入修订稿
        </button>
        <input ref={fileRef} type="file" accept=".srt,text/plain" hidden onChange={pickFile} />
      </div>

      {revisionName && (
        <div className="merge-file">
          <span className="file-chip">📝 {revisionName}</span>
          <button className="merge-clear" onClick={onClear} title="移除修订稿">
            ✕
          </button>
        </div>
      )}

      <div className="merge-list">
        {subs.length === 0 && <div className="merge-empty">先导入当前字幕，再导入修订稿</div>}

        {subs.length > 0 && revision.length === 0 && (
          <div className="merge-empty">
            尚未导入修订稿
            <span className="dim">
              修订稿用于提供更新后的文本；匹配后仅文本写回，当前时间轴保持不变。
            </span>
          </div>
        )}

        {revision.length > 0 && result && (
          <>
            <div className="merge-summary">
              匹配 <b>{result.pairs.length}</b> 对 · 当前稿未匹配{' '}
              <b>{result.unmatchedCurrent.length}</b> · 修订稿未匹配{' '}
              <b>{result.unmatchedRevision.length}</b>
              <span className="dim">阈值 {MATCH_THRESHOLD}（文本 0.6 + 时间 0.4）</span>
            </div>

            {result.pairs.length === 0 && (
              <div className="merge-empty">没有得分达到阈值的候选匹配</div>
            )}

            {result.pairs.map((p) => {
              const cur = currentByIndex.get(p.currentIndex);
              const rev = revisionByIndex.get(p.revisionIndex);
              if (!cur || !rev) return null;
              return (
                <div
                  key={`${p.currentIndex}-${p.revisionIndex}`}
                  className={`merge-pair ${cur.id === selectedId ? 'active' : ''}`}
                  onClick={() => onJump(cur.id, Math.max(0, cur.start) / 1000)}
                  title={`文本相似度 ${(p.text * 100).toFixed(0)}% · 时间 IoU ${(
                    p.time * 100
                  ).toFixed(0)}%`}
                >
                  <div className="merge-pair-head">
                    <span className="merge-pair-idx">
                      #{cur.index} ⇄ #{rev.index}
                    </span>
                    <span className={`merge-score ${scoreClass(p.score)}`}>
                      {p.score.toFixed(2)}
                    </span>
                  </div>
                  <div className="merge-side merge-side-current">
                    <span className="merge-side-tag">当前</span>
                    <span className="merge-text">{cur.text || '（空文本）'}</span>
                  </div>
                  <div className="merge-side merge-side-revision">
                    <span className="merge-side-tag">修订</span>
                    <span className="merge-text">{rev.text || '（空文本）'}</span>
                  </div>
                </div>
              );
            })}

            {result.unmatchedCurrent.length > 0 && (
              <div className="merge-unmatched">
                <div className="merge-unmatched-title current">
                  当前稿未匹配（{result.unmatchedCurrent.length}）
                </div>
                {result.unmatchedCurrent.map((idx) =>
                  currentByIndex.has(idx)
                    ? renderUnmatchedRow(currentByIndex.get(idx)!, 'current', 'cur')
                    : null
                )}
              </div>
            )}

            {result.unmatchedRevision.length > 0 && (
              <div className="merge-unmatched">
                <div className="merge-unmatched-title revision">
                  修订稿未匹配（{result.unmatchedRevision.length}）
                </div>
                {result.unmatchedRevision.map((idx) =>
                  revisionByIndex.has(idx)
                    ? renderUnmatchedRow(revisionByIndex.get(idx)!, 'revision', 'rev')
                    : null
                )}
              </div>
            )}
          </>
        )}
      </div>

      {revision.length > 0 && result && (
        <div className="merge-footer">
          <button
            className="btn success"
            disabled={result.pairs.length === 0}
            onClick={onApply}
            title="仅把已匹配修订稿的文本写入当前字幕，保留 id、序号与时间；可一次撤销"
          >
            ✅ 应用合并（写入 {result.pairs.length} 条）
          </button>
        </div>
      )}
    </aside>
  );
}
