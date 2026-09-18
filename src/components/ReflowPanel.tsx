import { useEffect, useMemo, useState } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp } from '../srt';
import {
  applyReflow,
  parseMaxWidth,
  planReflow,
  resolveReflowRange,
  type ReflowPlan,
} from '../reflow';

export interface ReflowForm {
  /** 连续区间起点字幕 id（与 to 顺序可互换） */
  fromId: string | null;
  toId: string | null;
  /** 每行最大字素数（原始输入文本） */
  maxWidth: string;
}

export const DEFAULT_REFLOW_FORM: ReflowForm = {
  fromId: null,
  toId: null,
  maxWidth: '20',
};

interface ReflowPanelProps {
  subs: Subtitle[];
  form: ReflowForm;
  onFormChange: (form: ReflowForm) => void;
  /** 应用：checkedIds 为当前勾选的可行条目 id */
  onApply: (checkedIds: Set<string>) => void;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
}

interface ReflowPreview {
  error: string | null;
  plan: ReflowPlan | null;
  targetCount: number;
  maxWidth: number | null;
}

/** 面板预览：解析区间 / 字素数并逐条计算重排方案 */
function useReflowPreview(subs: Subtitle[], form: ReflowForm): ReflowPreview {
  return useMemo(() => {
    if (subs.length === 0)
      return { error: '请先导入字幕', plan: null, targetCount: 0, maxWidth: null };
    const maxWidth = parseMaxWidth(form.maxWidth);
    if (maxWidth === null)
      return {
        error: '每行最大字素数须为不小于 1 的整数',
        plan: null,
        targetCount: 0,
        maxWidth: null,
      };
    const targets = resolveReflowRange(subs, form.fromId, form.toId);
    if (!targets)
      return {
        error: '请选择连续字幕区间（起点与终点，可同一条）',
        plan: null,
        targetCount: 0,
        maxWidth,
      };
    const plan = planReflow(targets, maxWidth);
    return { error: null, plan, targetCount: targets.length, maxWidth };
  }, [subs, form]);
}

export default function ReflowPanel({
  subs,
  form,
  onFormChange,
  onApply,
  selectedId,
  onJump,
}: ReflowPanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选区间两端
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start), [subs]);
  const preview = useReflowPreview(subs, form);
  const { plan } = preview;

  // 勾选状态：null 表示「跟随默认（全部可行项）」，Set 表示用户手动选择。
  // 区间 / 参数变化导致可行条目集合变化时，仅保留仍可行且文本有变化的勾选。
  const [override, setOverride] = useState<Set<string> | null>(null);
  const feasibleChanged = useMemo(
    () => (plan ? plan.items.filter((it) => it.ok && !it.unchanged) : []),
    [plan]
  );

  const feasibleIds = useMemo(
    () => new Set(feasibleChanged.map((it) => it.id)),
    [feasibleChanged]
  );

  const checked: Set<string> = useMemo(() => {
    if (!plan) return new Set();
    if (override === null) return feasibleIds;
    const next = new Set<string>();
    for (const id of override) if (feasibleIds.has(id)) next.add(id);
    return next;
  }, [plan, override, feasibleIds]);

  // 面板切换区间时重置手动勾选（切回默认全选可行项）
  useEffect(() => {
    setOverride(null);
  }, [form.fromId, form.toId, form.maxWidth]);

  const update = (patch: Partial<ReflowForm>) => onFormChange({ ...form, ...patch });

  const toggle = (id: string) => {
    const base = override === null ? feasibleIds : override;
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride(next);
  };

  const allChecked = feasibleChanged.length > 0 && checked.size === feasibleChanged.length;
  const toggleAll = () => setOverride(allChecked ? new Set() : null);

  const optionLabel = (s: Subtitle) =>
    `#${s.index} · ${formatTimestamp(s.start)} · ${s.text.split('\n')[0] || '（空文本）'}`;

  return (
    <aside className="reflow-panel">
      <div className="reflow-header">
        <span className="reflow-title">断行重排</span>
      </div>

      <div className="reflow-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再选择区间</div>}

        {subs.length > 0 && (
          <>
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
              <label className="reflow-width">
                <span>每行最大字素数</span>
                <input
                  type="number"
                  className="drift-input"
                  step="1"
                  min="1"
                  value={form.maxWidth}
                  onChange={(e) => update({ maxWidth: e.target.value })}
                />
              </label>
            </div>

            {plan && (
              <div className="drift-summary">
                <span>
                  区间 <b>{preview.targetCount}</b> 条 · 可行 <b>{plan.feasible}</b> 条 ·
                  不可行 <b className={plan.infeasible > 0 ? 'warn-text' : ''}>{plan.infeasible}</b>{' '}
                  条
                </span>
                <span>
                  待写入 <b>{checked.size}</b> / {plan.changed} 条（已是最优排版的条目不写入）
                </span>
                <span className="dim">
                  i / b / u / font 标签不计宽；依次取最大行长最小、长度差最小、断点最靠前
                </span>
              </div>
            )}

            {preview.error && <div className="drift-error">{preview.error}</div>}

            {plan && (
              <div className="reflow-list">
                {feasibleChanged.length > 0 && (
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
                      全选待写入项（{checked.size}/{feasibleChanged.length}）
                    </span>
                  </label>
                )}

                {plan.items.map((it) => {
                  const isChecked = checked.has(it.id);
                  return (
                    <div
                      key={it.id}
                      className={`reflow-row ${it.id === selectedId ? 'active' : ''} ${
                        it.ok ? '' : 'infeasible'
                      }`}
                      onClick={() => onJump(it.id, Math.max(0, it.start) / 1000)}
                    >
                      <div className="reflow-row-head">
                        <span className="reflow-row-idx">#{it.index}</span>
                        {it.ok ? (
                          it.unchanged ? (
                            <span className="reflow-badge keep">无需调整</span>
                          ) : (
                            <span className="reflow-badge move">
                              {it.lines} 行 · {it.lineLengths?.[0]}
                              {it.lines === 2 ? `/${it.lineLengths?.[1]}` : ''} 字素
                            </span>
                          )
                        ) : (
                          <span className="reflow-badge bad">无可行方案</span>
                        )}
                        {it.ok && !it.unchanged && (
                          <input
                            type="checkbox"
                            className="reflow-check"
                            checked={isChecked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggle(it.id)}
                          />
                        )}
                      </div>
                      <div className="reflow-text-block">
                        <div className="reflow-text-label">原文</div>
                        <pre className="reflow-text old">
                          {it.original === ''
                            ? '（空文本）'
                            : it.original.split('\n').map((line, i) => (
                                <div key={i} className="reflow-line">
                                  {line || ' '}
                                </div>
                              ))}
                        </pre>
                      </div>
                      {it.ok && it.result !== null ? (
                        <div className="reflow-text-block">
                          <div className="reflow-text-label">重排</div>
                          <pre className="reflow-text new">
                            {it.result.split('\n').map((line, i) => (
                              <div key={i} className="reflow-line">
                                {line || ' '}
                              </div>
                            ))}
                          </pre>
                        </div>
                      ) : (
                        <div className="reflow-reason">⚠ {it.reason}</div>
                      )}
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
                : '没有需要写入的可行条目（不可行或已是最优排版）'
              : '把勾选条目的重排结果写入，整批可一次撤销'
          }
        >
          ✅ 应用重排{checked.size > 0 ? `（写入 ${checked.size} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}

/** 供 App 应用时基于最新字幕重算方案（与面板预览同一套规则） */
export function computeReflowPlan(subs: Subtitle[], form: ReflowForm): ReflowPlan | null {
  const maxWidth = parseMaxWidth(form.maxWidth);
  if (maxWidth === null) return null;
  const targets = resolveReflowRange(subs, form.fromId, form.toId);
  if (!targets) return null;
  return planReflow(targets, maxWidth);
}

export { applyReflow };
