import { useMemo } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp, parseTimeInput } from '../srt';
import { formatShift, planDrift, validateDrift } from '../drift';
import type { DriftAnchorInput } from '../drift';

/** 锚点表单：选中的字幕 id + 目标时间输入框原始文本 */
export interface AnchorForm {
  id: string | null;
  target: string;
}

export interface DriftForm {
  a: AnchorForm;
  b: AnchorForm;
}

export const EMPTY_DRIFT_FORM: DriftForm = {
  a: { id: null, target: '' },
  b: { id: null, target: '' },
};

interface DriftPanelProps {
  subs: Subtitle[];
  /** 当前播放头（秒），用于「取播放头」快捷填入目标时间 */
  currentTime: number;
  form: DriftForm;
  onFormChange: (form: DriftForm) => void;
  onApply: () => void;
}

export default function DriftPanel({
  subs,
  currentTime,
  form,
  onFormChange,
  onApply,
}: DriftPanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选锚点
  const sorted = useMemo(() => [...subs].sort((x, y) => x.start - y.start), [subs]);

  const inputA: DriftAnchorInput = { id: form.a.id, targetStart: parseTimeInput(form.a.target) };
  const inputB: DriftAnchorInput = { id: form.b.id, targetStart: parseTimeInput(form.b.target) };
  // 预览很轻（O(n)），渲染期直接计算；应用时 App 会基于最新状态重算
  const plan = planDrift(subs, inputA, inputB);
  const error = validateDrift(subs, inputA, inputB);

  const update = (key: 'a' | 'b', patch: Partial<AnchorForm>) =>
    onFormChange({ ...form, [key]: { ...form[key], ...patch } });

  const renderAnchor = (key: 'a' | 'b', label: string) => {
    const side = form[key];
    const input = key === 'a' ? inputA : inputB;
    const sub = subs.find((s) => s.id === side.id);
    const typed = side.target.trim() !== '';
    const offset = sub && input.targetStart !== null ? input.targetStart - sub.start : null;
    return (
      <div className="drift-anchor">
        <div className="drift-anchor-title">{label}</div>
        <select
          className="drift-select"
          value={side.id ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            const picked = subs.find((s) => s.id === id);
            // 目标时间留空时预填该字幕的当前开始时间，便于在其基础上微调
            const target =
              side.target.trim() === '' && picked ? formatTimestamp(picked.start) : side.target;
            update(key, { id, target });
          }}
        >
          <option value="" disabled>
            选择锚点字幕…
          </option>
          {sorted.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.index} · {formatTimestamp(s.start)} · {s.text.split('\n')[0] || '（空文本）'}
            </option>
          ))}
        </select>
        <div className="drift-target-row">
          <input
            className="drift-input"
            type="text"
            placeholder="目标开始时间，如 00:01:23,500"
            value={side.target}
            onChange={(e) => update(key, { target: e.target.value })}
          />
          <button
            className="btn btn-sm"
            title="把当前播放头时间填为目标开始时间"
            onClick={() => update(key, { target: formatTimestamp(currentTime * 1000) })}
          >
            ⏱ 播放头
          </button>
        </div>
        {typed && input.targetStart === null && (
          <div className="drift-error">无法解析时间，支持 83.5、02:05、00:01:23,500</div>
        )}
        {sub && offset !== null && (
          <div className="drift-offset">
            当前 {formatTimestamp(sub.start)} · 偏移 {formatShift(offset)}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="drift-panel">
      <div className="drift-header">
        <span className="drift-title">双锚点漂移校准</span>
      </div>

      <div className="drift-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再设置锚点</div>}

        {subs.length > 0 && (
          <>
            {renderAnchor('a', '⚓ 锚点 A（时间在前）')}
            {renderAnchor('b', '⚓ 锚点 B（时间在后）')}

            {plan && (
              <div className="drift-summary">
                <span>
                  受影响 <b>{plan.affected}</b> / {subs.length} 条 · 最大偏移{' '}
                  <b>{(plan.maxShift / 1000).toFixed(3)}s</b>
                </span>
                <span className="dim">
                  锚点 A 之前统一偏移，A→B 按原始开始时间线性插值，B 之后统一偏移；所有字幕时长不变
                </span>
              </div>
            )}

            {error && <div className="drift-error">{error}</div>}
          </>
        )}
      </div>

      <div className="drift-footer">
        <button
          className="btn success"
          disabled={error !== null}
          onClick={onApply}
          title={error ?? '按双锚点方案平移整批字幕，可一次撤销'}
        >
          ✅ 应用校准{plan && error === null ? `（平移 ${plan.affected} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}
