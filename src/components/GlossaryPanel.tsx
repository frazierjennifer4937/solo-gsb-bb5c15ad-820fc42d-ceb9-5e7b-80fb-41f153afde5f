import { useEffect, useMemo, useState } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp } from '../srt';
import {
  applyGlossary,
  parseGlossary,
  resolveGlossaryRange,
  scanGlossary,
  type GlossaryItem,
  type GlossaryPlan,
} from '../glossary';

export interface GlossaryForm {
  /** 连续区间起点字幕 id（与 to 顺序可互换） */
  fromId: string | null;
  toId: string | null;
  /** 术语表原文：每行「错误写法 => 标准写法」 */
  table: string;
}

export const DEFAULT_GLOSSARY_FORM: GlossaryForm = {
  fromId: null,
  toId: null,
  table: '',
};

interface GlossaryPanelProps {
  subs: Subtitle[];
  form: GlossaryForm;
  onFormChange: (form: GlossaryForm) => void;
  /** 应用：checkedIds 为当前勾选的命中字幕 id */
  onApply: (checkedIds: Set<string>) => void;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
}

interface GlossaryPreview {
  /** 术语表校验错误（重复错误写法 / 空写法 / 空标准写法 / 缺少分隔符） */
  glossaryErrors: string[];
  /** 区间错误（术语表有效但未选区间） */
  rangeError: string | null;
  plan: GlossaryPlan | null;
  entryCount: number;
}

/** 面板预览：解析术语表与区间并扫描命中 */
function useGlossaryPreview(subs: Subtitle[], form: GlossaryForm): GlossaryPreview {
  return useMemo(() => {
    if (subs.length === 0)
      return { glossaryErrors: [], rangeError: null, plan: null, entryCount: 0 };
    const parsed = parseGlossary(form.table);
    if (parsed.errors.length > 0)
      return {
        glossaryErrors: parsed.errors,
        rangeError: null,
        plan: null,
        entryCount: parsed.entries.length,
      };
    if (parsed.entries.length === 0)
      return { glossaryErrors: [], rangeError: null, plan: null, entryCount: 0 };
    const targets = resolveGlossaryRange(subs, form.fromId, form.toId);
    if (!targets)
      return {
        glossaryErrors: [],
        rangeError: '请选择连续字幕区间（起点与终点，可同一条）',
        plan: null,
        entryCount: parsed.entries.length,
      };
    const plan = scanGlossary(targets, parsed.entries);
    return { glossaryErrors: [], rangeError: null, plan, entryCount: parsed.entries.length };
  }, [subs, form]);
}

/** 把一条字幕的命中按词条聚合（保持首次出现顺序），用于展示命中规则 */
function aggregateHits(item: GlossaryItem) {
  const agg = new Map<number, { wrong: string; right: string; count: number }>();
  for (const h of item.hits) {
    const cur = agg.get(h.line);
    if (cur) cur.count++;
    else agg.set(h.line, { wrong: h.wrong, right: h.right, count: 1 });
  }
  return Array.from(agg.values());
}

export default function GlossaryPanel({
  subs,
  form,
  onFormChange,
  onApply,
  selectedId,
  onJump,
}: GlossaryPanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选区间两端
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start), [subs]);
  const preview = useGlossaryPreview(subs, form);
  const { plan } = preview;

  // 勾选状态：null 表示「跟随默认（全部命中项）」，Set 表示用户手动选择。
  // 术语表 / 区间变化导致命中集合变化时，仅保留仍命中的勾选。
  const [override, setOverride] = useState<Set<string> | null>(null);
  const hitIds = useMemo(
    () => new Set((plan ? plan.items : []).map((it) => it.id)),
    [plan]
  );

  const checked: Set<string> = useMemo(() => {
    if (!plan) return new Set();
    if (override === null) return hitIds;
    const next = new Set<string>();
    for (const id of override) if (hitIds.has(id)) next.add(id);
    return next;
  }, [plan, override, hitIds]);

  // 术语表或区间变化时重置手动勾选（切回默认全选命中项）
  useEffect(() => {
    setOverride(null);
  }, [form.fromId, form.toId, form.table]);

  const update = (patch: Partial<GlossaryForm>) => onFormChange({ ...form, ...patch });

  const toggle = (id: string) => {
    const base = override === null ? hitIds : override;
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride(next);
  };

  const allChecked = plan !== null && plan.items.length > 0 && checked.size === plan.items.length;
  const toggleAll = () => setOverride(allChecked ? new Set() : null);

  const optionLabel = (s: Subtitle) =>
    `#${s.index} · ${formatTimestamp(s.start)} · ${s.text.split('\n')[0] || '（空文本）'}`;

  const applyTitle =
    checked.size > 0
      ? '把勾选字幕的校对结果写入，整批可一次撤销'
      : preview.glossaryErrors.length > 0
        ? '术语表存在错误，修正后才能应用'
        : plan === null
          ? (preview.rangeError ?? '请先粘贴术语表')
          : '区间内没有命中任何词条';

  return (
    <aside className="glossary-panel">
      <div className="reflow-header">
        <span className="reflow-title">术语校对</span>
      </div>

      <div className="reflow-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再粘贴术语表</div>}

        {subs.length > 0 && (
          <>
            <div className="glossary-table-block">
              <div className="reflow-field-title">本地术语表（每行：错误写法 =&gt; 标准写法）</div>
              <textarea
                className="glossary-table"
                rows={5}
                placeholder={'例如：\n帐号 => 账号\nTeh => The'}
                value={form.table}
                onChange={(e) => update({ table: e.target.value })}
              />
              <div className="dim">
                按 Unicode 大小写折叠匹配（中文原样处理）；i / b / u / font
                标签不参与匹配且作为边界；同一位置取最长命中，替换结果不会再次触发词条
              </div>
            </div>

            {preview.glossaryErrors.length > 0 && (
              <div className="glossary-errors">
                {preview.glossaryErrors.map((err, i) => (
                  <div key={i} className="drift-error">
                    ⚠ {err}
                  </div>
                ))}
              </div>
            )}

            {preview.entryCount > 0 && preview.glossaryErrors.length === 0 && (
              <div className="reflow-range">
                <div className="reflow-field-title">连续字幕区间</div>
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
            )}

            {preview.rangeError && <div className="drift-error">{preview.rangeError}</div>}

            {plan && (
              <div className="drift-summary">
                <span>
                  术语 <b>{preview.entryCount}</b> 条 · 区间 <b>{plan.targetCount}</b> 条 ·
                  命中字幕 <b>{plan.items.length}</b> 条 · 命中 <b>{plan.hitCount}</b> 处
                </span>
                <span>
                  待写入 <b>{checked.size}</b> / {plan.items.length} 条
                </span>
                <span className="dim">替换基于原文一次生成，整批写入作为一次撤销/重做</span>
              </div>
            )}

            {plan && plan.items.length === 0 && (
              <div className="issues-empty ok">✅ 区间内没有命中任何词条</div>
            )}

            {plan && plan.items.length > 0 && (
              <div className="reflow-list">
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
                    全选命中项（{checked.size}/{plan.items.length}）
                  </span>
                </label>

                {plan.items.map((it) => (
                  <div
                    key={it.id}
                    className={`reflow-row ${it.id === selectedId ? 'active' : ''}`}
                    onClick={() => onJump(it.id, Math.max(0, it.start) / 1000)}
                  >
                    <div className="reflow-row-head">
                      <span className="reflow-row-idx">#{it.index}</span>
                      <span className="reflow-badge move">{it.hits.length} 处命中</span>
                      <input
                        type="checkbox"
                        className="reflow-check"
                        checked={checked.has(it.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(it.id)}
                      />
                    </div>
                    <div className="glossary-rules">
                      {aggregateHits(it).map((r, i) => (
                        <span key={i} className="glossary-rule">
                          {r.wrong} → {r.right}
                          {r.count > 1 ? ` ×${r.count}` : ''}
                        </span>
                      ))}
                    </div>
                    <div className="reflow-text-block">
                      <div className="reflow-text-label">原文</div>
                      <pre className="reflow-text old">{it.original}</pre>
                    </div>
                    <div className="reflow-text-block">
                      <div className="reflow-text-label">改后</div>
                      <pre className="reflow-text new">{it.result}</pre>
                    </div>
                  </div>
                ))}
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
          title={applyTitle}
        >
          ✅ 应用校对{checked.size > 0 ? `（写入 ${checked.size} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}

/** 供 App 应用时基于最新字幕重算方案（与面板预览同一套规则） */
export function computeGlossaryPlan(subs: Subtitle[], form: GlossaryForm): GlossaryPlan | null {
  const parsed = parseGlossary(form.table);
  if (parsed.errors.length > 0 || parsed.entries.length === 0) return null;
  const targets = resolveGlossaryRange(subs, form.fromId, form.toId);
  if (!targets) return null;
  return scanGlossary(targets, parsed.entries);
}

export { applyGlossary };
