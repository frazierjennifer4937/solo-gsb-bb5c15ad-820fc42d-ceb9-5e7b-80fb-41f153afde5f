import { useEffect, useMemo, useState } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp } from '../srt';
import {
  applyTermProof,
  parseGlossary,
  planTermProof,
  resolveTermRange,
  type ParsedGlossary,
  type TermHit,
  type TermPlan,
} from '../termproof';

export interface TermProofForm {
  /** 连续区间起点字幕 id（与 to 顺序可互换） */
  fromId: string | null;
  toId: string | null;
  /** 本地术语表原文：每行「错误写法 => 标准写法」 */
  glossary: string;
}

export const DEFAULT_TERM_FORM: TermProofForm = {
  fromId: null,
  toId: null,
  glossary: '',
};

interface TermProofPanelProps {
  subs: Subtitle[];
  form: TermProofForm;
  onFormChange: (form: TermProofForm) => void;
  onApply: (checkedIds: Set<string>) => void;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
}

interface TermPreview {
  error: string | null;
  glossary: ParsedGlossary | null;
  plan: TermPlan | null;
  targetCount: number;
}

/** 面板预览：解析术语表 / 区间并逐条扫描，应用时 App 用同一套规则重算 */
function useTermPreview(subs: Subtitle[], form: TermProofForm): TermPreview {
  return useMemo(() => {
    if (subs.length === 0)
      return { error: '请先导入字幕', glossary: null, plan: null, targetCount: 0 };
    const glossary = parseGlossary(form.glossary);
    if (glossary.totalLines === 0)
      return { error: '请粘贴术语表（每行：错误写法 => 标准写法）', glossary, plan: null, targetCount: 0 };
    // 术语表存在格式 / 空写法 / 重复问题时不进行扫描，修复后自动恢复
    if (!glossary.ok)
      return {
        error: `术语表存在 ${glossary.issues.length} 处问题，请修正后才能扫描与应用`,
        glossary,
        plan: null,
        targetCount: 0,
      };
    const targets = resolveTermRange(subs, form.fromId, form.toId);
    if (!targets)
      return { error: '请选择连续字幕区间（起点与终点，可同一条）', glossary, plan: null, targetCount: 0 };
    const plan = planTermProof(targets, glossary.rules);
    return { error: null, glossary, plan, targetCount: targets.length };
  }, [subs, form]);
}

/** 高亮区间 */
interface Mark {
  start: number;
  end: number;
}

/** 带高亮的文本：ranges 为绝对 UTF-16 偏移、不得交叉；换行逐行显示 */
function MarkedText({ text, marks, cls }: { text: string; marks: Mark[]; cls: string }) {
  if (text === '') return '（空文本）';
  const segments: { text: string; marked: boolean }[] = [];
  let cur = 0;
  for (const m of marks) {
    if (m.start < cur) continue;
    if (m.start > cur) segments.push({ text: text.slice(cur, m.start), marked: false });
    segments.push({ text: text.slice(m.start, m.end), marked: true });
    cur = m.end;
  }
  if (cur < text.length) segments.push({ text: text.slice(cur), marked: false });
  return (
    <>
      {segments.map((seg, i) =>
        seg.text.split('\n').map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            {seg.marked ? <mark className={cls}>{line || ' '}</mark> : line || ' '}
            {j < arr.length - 1 ? <br /> : null}
          </span>
        ))
      )}
    </>
  );
}

/** 原文中的命中区间 */
function hitMarks(hits: TermHit[]): Mark[] {
  return hits.map((h) => ({ start: h.start, end: h.end }));
}

/** 改后文本中被替换区间：命中不重叠，按顺序累计长度差 */
function resultMarks(hits: TermHit[], standardAt: (i: number) => string): Mark[] {
  let delta = 0;
  return hits.map((h) => {
    const start = h.start + delta;
    const std = standardAt(h.ruleIndex);
    delta += std.length - (h.end - h.start);
    return { start, end: start + std.length };
  });
}

export default function TermProofPanel({
  subs,
  form,
  onFormChange,
  onApply,
  selectedId,
  onJump,
}: TermProofPanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选区间两端
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start), [subs]);
  const preview = useTermPreview(subs, form);
  const { glossary, plan } = preview;
  const rules = glossary?.rules ?? [];

  // 勾选状态：null 表示「跟随默认（全部待写入项）」，Set 表示手动选择。
  // 术语表 / 区间变化导致待写入条目集合变化时，仅保留仍待写入的勾选。
  const [override, setOverride] = useState<Set<string> | null>(null);
  const changedItems = useMemo(
    () => (plan ? plan.items.filter((it) => !it.unchanged) : []),
    [plan]
  );
  const changedIds = useMemo(() => new Set(changedItems.map((it) => it.id)), [changedItems]);

  const checked: Set<string> = useMemo(() => {
    if (!plan) return new Set();
    if (override === null) return changedIds;
    const next = new Set<string>();
    for (const id of override) if (changedIds.has(id)) next.add(id);
    return next;
  }, [plan, override, changedIds]);

  // 面板切换术语表 / 区间时重置手动勾选（切回默认全选待写入项）
  useEffect(() => {
    setOverride(null);
  }, [form.fromId, form.toId, form.glossary]);

  const update = (patch: Partial<TermProofForm>) => onFormChange({ ...form, ...patch });

  const toggle = (id: string) => {
    const base = override === null ? changedIds : override;
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride(next);
  };

  const allChecked = changedItems.length > 0 && checked.size === changedItems.length;
  const toggleAll = () => setOverride(allChecked ? new Set() : null);

  const optionLabel = (s: Subtitle) =>
    `#${s.index} · ${formatTimestamp(s.start)} · ${s.text.split('\n')[0] || '（空文本）'}`;

  const standardAt = (i: number) => rules[i]?.standard ?? '';

  /** 一条字幕内按规则聚合命中次数 */
  const ruleStats = (hits: TermHit[]) => {
    const counts = new Map<number, number>();
    for (const h of hits) counts.set(h.ruleIndex, (counts.get(h.ruleIndex) ?? 0) + 1);
    return [...counts].sort(
      (a, b) => b[1] - a[1] || rules[a[0]].lineNo - rules[b[0]].lineNo
    );
  };

  return (
    <aside className="term-panel">
      <div className="term-header">
        <span className="term-title">术语校对</span>
      </div>

      <div className="term-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再粘贴术语表并选择区间</div>}

        {subs.length > 0 && (
          <>
            <div className="term-glossary">
              <div className="term-field-title">
                本地术语表（每行：错误写法 =&gt; 标准写法）
              </div>
              <textarea
                className="term-textarea"
                spellCheck={false}
                rows={7}
                placeholder={'WIFI => Wi‑Fi\nnaive => naïve\n斯特拉迪瓦里 => 斯特拉迪瓦里琴'}
                value={form.glossary}
                onChange={(e) => update({ glossary: e.target.value })}
              />
              {glossary && glossary.totalLines > 0 && (
                <div className="term-glossary-meta">
                  {glossary.ok ? (
                    <span className="dim">
                      已解析 <b>{glossary.rules.length}</b> 条规则
                    </span>
                  ) : (
                    <span className="term-issue-count warn-text">
                      {glossary.issues.length} 处问题 · 有效规则 {glossary.rules.length} 条
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="term-range">
              <div className="term-field-title">连续字幕区间</div>
              <select
                className="drift-select"
                value={form.fromId ?? ''}
                onChange={(e) => update({ fromId: e.target.value || null })}
              >
                <option value="" disabled>
                  起点字幕…
                </option>
                {sorted.map((s) => (
                  <option key={s.id} value={s.id}>
                    {optionLabel(s)}
                  </option>
                ))}
              </select>
              <select
                className="drift-select"
                value={form.toId ?? ''}
                onChange={(e) => update({ toId: e.target.value || null })}
              >
                <option value="" disabled>
                  终点字幕…
                </option>
                {sorted.map((s) => (
                  <option key={s.id} value={s.id}>
                    {optionLabel(s)}
                  </option>
                ))}
              </select>
            </div>

            {glossary && !glossary.ok && (
              <div className="term-issues">
                {glossary.issues.map((iss, i) => (
                  <div key={i} className="term-issue-row" title={iss.raw}>
                    <span className="term-issue-line">第 {iss.lineNo} 行</span>
                    <span className="term-issue-reason">{iss.reason}</span>
                  </div>
                ))}
              </div>
            )}

            {plan && (
              <div className="drift-summary">
                <span>
                  区间 <b>{preview.targetCount}</b> 条 · 命中字幕 <b>{plan.items.length}</b> 条 ·
                  命中 <b>{plan.hitCount}</b> 处
                </span>
                <span>
                  待写入 <b>{checked.size}</b> / {changedItems.length} 条（改写后无变化的条目不写入）
                </span>
                <span className="dim">
                  Unicode 大小写折叠匹配，中文原样比较；HTML 标签与换行不参与匹配；同位置取错误写法更长者，命中互不重叠
                </span>
              </div>
            )}

            {preview.error && <div className="drift-error">{preview.error}</div>}

            {plan && plan.items.length === 0 && (
              <div className="merge-empty">所选区间内没有术语命中</div>
            )}

            {plan && plan.items.length > 0 && (
              <div className="term-list">
                {changedItems.length > 0 && (
                  <label className="reflow-checkall" onClick={(e) => e.preventDefault()}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = !allChecked && checked.size > 0;
                      }}
                      onChange={toggleAll}
                    />
                    <span>
                      全选待写入项（{checked.size}/{changedItems.length}）
                    </span>
                  </label>
                )}

                {plan.items.map((it) => {
                  const isChecked = checked.has(it.id);
                  return (
                    <div
                      key={it.id}
                      className={`term-row ${it.id === selectedId ? 'active' : ''} ${
                        it.unchanged ? 'no-change' : ''
                      }`}
                      onClick={() => onJump(it.id, Math.max(0, it.start) / 1000)}
                    >
                      <div className="term-row-head">
                        <span className="term-row-idx">#{it.index}</span>
                        <span className="term-badge hit">{it.hits.length} 处命中</span>
                        {it.unchanged && <span className="term-badge keep">改写后无变化</span>}
                        {!it.unchanged && (
                          <input
                            type="checkbox"
                            className="reflow-check"
                            checked={isChecked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggle(it.id)}
                          />
                        )}
                      </div>
                      <div className="term-rules">
                        {ruleStats(it.hits).map(([ri, n]) => (
                          <span key={ri} className="term-rule-chip" title={`术语表第 ${rules[ri].lineNo} 行`}>
                            {rules[ri].wrong} ⇒ {rules[ri].standard}
                            {n > 1 ? ` ×${n}` : ''}
                          </span>
                        ))}
                      </div>
                      <div className="reflow-text-block">
                        <div className="reflow-text-label">原文</div>
                        <pre className="reflow-text old">
                          <MarkedText text={it.original} marks={hitMarks(it.hits)} cls="term-mark-old" />
                        </pre>
                      </div>
                      <div className="reflow-text-block">
                        <div className="reflow-text-label">改后</div>
                        <pre className="reflow-text new">
                          <MarkedText
                            text={it.result}
                            marks={resultMarks(it.hits, standardAt)}
                            cls="term-mark-new"
                          />
                        </pre>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="drift-footer">
        <button
          className="btn success"
          disabled={checked.size === 0}
          onClick={() => onApply(checked)}
          title={
            checked.size === 0
              ? plan === null
                ? preview.error ?? '参数无效'
                : '没有需要写入的条目（无命中或改写后均无变化）'
              : '把勾选条目的改后文本写入，整批可一次撤销'
          }
        >
          ✅ 应用校对{checked.size > 0 ? `（写入 ${checked.size} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}

/** 供 App 应用时基于最新字幕重算方案（与面板预览同一套规则） */
export function computeTermPlan(subs: Subtitle[], form: TermProofForm): TermPlan | null {
  const glossary = parseGlossary(form.glossary);
  if (!glossary.ok) return null;
  const targets = resolveTermRange(subs, form.fromId, form.toId);
  if (!targets) return null;
  return planTermProof(targets, glossary.rules);
}

export { applyTermProof };
