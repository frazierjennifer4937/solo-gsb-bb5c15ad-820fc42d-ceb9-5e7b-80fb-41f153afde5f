import { useMemo } from 'react';
import type { Subtitle } from '../types';
import type { WaveformState } from '../useWaveform';
import { formatTimestamp } from '../srt';
import {
  parseSilenceParams,
  planSilenceSnap,
  resolveRange,
  detectSilences,
  type SilencePlan,
} from '../silence';

export interface SilenceForm {
  /** 连续区间起点字幕 id（与 to 顺序可互换） */
  fromId: string | null;
  toId: string | null;
  threshold: string;
  minSilenceMs: string;
  maxSnapMs: string;
  minDurationMs: string;
}

export const DEFAULT_SILENCE_FORM: SilenceForm = {
  fromId: null,
  toId: null,
  threshold: '0.02',
  minSilenceMs: '250',
  maxSnapMs: '1500',
  minDurationMs: '500',
};

interface SilencePanelProps {
  subs: Subtitle[];
  waveform: WaveformState;
  form: SilenceForm;
  onFormChange: (form: SilenceForm) => void;
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
  onApply: () => void;
}

export interface SilencePreview {
  error: string | null;
  plan: SilencePlan | null;
  segmentCount: number;
  targetCount: number;
}

/** 面板预览与应用共用同一套规则：解析区间/参数并跑 DP */
export function useSilencePreview(
  subs: Subtitle[],
  waveform: WaveformState,
  form: SilenceForm
): SilencePreview {
  return useMemo(() => {
    if (waveform.status !== 'ready' || !waveform.data)
      return { error: '音频波形尚未就绪，请先导入视频并等待解码完成', plan: null, segmentCount: 0, targetCount: 0 };
    if (subs.length === 0) return { error: '请先导入字幕', plan: null, segmentCount: 0, targetCount: 0 };
    const parsed = parseSilenceParams(form);
    if (!parsed.ok) return { error: parsed.error, plan: null, segmentCount: 0, targetCount: 0 };
    const targets = resolveRange(subs, form.fromId, form.toId);
    if (!targets)
      return { error: '请选择连续字幕区间（起点与终点，可同一条）', plan: null, segmentCount: 0, targetCount: 0 };
    const segments = detectSilences(
      waveform.data,
      parsed.params.threshold,
      parsed.params.minSilenceMs
    );
    const plan = planSilenceSnap(targets, waveform.data, parsed.params);
    if (!plan)
      return {
        error: '当前参数下无可行方案：放宽最大吸附距离、调小字幕最小时长或更换区间后重试',
        plan: null,
        segmentCount: segments.length,
        targetCount: targets.length,
      };
    return { error: null, plan, segmentCount: segments.length, targetCount: targets.length };
  }, [subs, waveform, form]);
}

function fmtSeg(ms: number): string {
  return formatTimestamp(ms);
}

export default function SilencePanel({
  subs,
  waveform,
  form,
  onFormChange,
  selectedId,
  onJump,
  onApply,
}: SilencePanelProps) {
  // 下拉选项按当前开始时间排序，便于按时间先后挑选区间两端
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start), [subs]);
  const preview = useSilencePreview(subs, waveform, form);
  const { plan } = preview;

  const update = (patch: Partial<SilenceForm>) => onFormChange({ ...form, ...patch });

  const optionLabel = (s: Subtitle) =>
    `#${s.index} · ${formatTimestamp(s.start)} · ${s.text.split('\n')[0] || '（空文本）'}`;

  return (
    <aside className="silence-panel">
      <div className="silence-header">
        <span className="silence-title">静音吸附</span>
      </div>

      <div className="silence-body">
        {waveform.status !== 'ready' && (
          <div className="merge-empty">音频波形尚未就绪：导入视频并等待波形解码完成后可用</div>
        )}

        {waveform.status === 'ready' && (
          <>
            <div className="silence-range">
              <div className="silence-field-title">连续字幕区间</div>
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

            <div className="silence-params">
              <label className="silence-param">
                <span>峰值阈值（0–1）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="0.005"
                  min="0"
                  max="1"
                  value={form.threshold}
                  onChange={(e) => update({ threshold: e.target.value })}
                />
              </label>
              <label className="silence-param">
                <span>最短静音长度（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="10"
                  min="0"
                  value={form.minSilenceMs}
                  onChange={(e) => update({ minSilenceMs: e.target.value })}
                />
              </label>
              <label className="silence-param">
                <span>最大吸附距离（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="50"
                  min="0"
                  value={form.maxSnapMs}
                  onChange={(e) => update({ maxSnapMs: e.target.value })}
                />
              </label>
              <label className="silence-param">
                <span>字幕最小时长（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="10"
                  min="1"
                  value={form.minDurationMs}
                  onChange={(e) => update({ minDurationMs: e.target.value })}
                />
              </label>
            </div>

            {plan && (
              <div className="drift-summary">
                <span>
                  区间 <b>{preview.targetCount}</b> 条 · 检测到静音段 <b>{preview.segmentCount}</b> 段
                </span>
                <span>
                  吸附边界 <b>{plan.snapped}</b> / {preview.targetCount * 2} · 总位移{' '}
                  <b>{(plan.totalShift / 1000).toFixed(3)}s</b> · 变动 {plan.moved} 条
                </span>
                <span className="dim">
                  依次最大化吸附边界数、最小化总位移；同分取新时间序列字典序较小者
                </span>
              </div>
            )}

            {preview.error && <div className="drift-error">{preview.error}</div>}

            {plan && (
              <div className="silence-list">
                {plan.items.map((it) => (
                  <div
                    key={it.id}
                    className={`silence-row ${it.id === selectedId ? 'active' : ''}`}
                    onClick={() => onJump(it.id, Math.max(0, it.newStart) / 1000)}
                  >
                    <div className="silence-row-head">
                      <span className="silence-row-idx">#{it.index}</span>
                      {it.newStart !== it.start || it.newEnd !== it.end ? (
                        <span className="silence-badge move">变动</span>
                      ) : (
                        <span className="silence-badge keep">原位</span>
                      )}
                    </div>
                    <div className="silence-time-row">
                      <span className="silence-time-old">
                        {fmtSeg(it.start)} → {fmtSeg(it.end)}
                      </span>
                    </div>
                    <div className="silence-time-row">
                      <span className="silence-time-new">
                        {fmtSeg(it.newStart)} → {fmtSeg(it.newEnd)}
                      </span>
                    </div>
                    <div className="silence-seg">
                      <i className={it.startSegment ? 'snapped' : ''}>
                        始 {it.startSegment ? `吸附 ${fmtSeg(it.startSegment.mid)}（静音 ${(it.startSegment.duration / 1000).toFixed(2)}s）` : '保持原位'}
                      </i>
                      <i className={it.endSegment ? 'snapped' : ''}>
                        止 {it.endSegment ? `吸附 ${fmtSeg(it.endSegment.mid)}（静音 ${(it.endSegment.duration / 1000).toFixed(2)}s）` : '保持原位'}
                      </i>
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
          disabled={plan === null || plan.moved === 0}
          onClick={onApply}
          title={
            plan === null
              ? preview.error ?? '参数无效'
              : plan.moved === 0
                ? '所有边界已处于最佳位置，无需应用'
                : '把吸附结果应用到所选字幕，可一次撤销'
          }
        >
          ✅ 应用吸附{plan && plan.moved > 0 ? `（变动 ${plan.moved} 条）` : ''}
        </button>
      </div>
    </aside>
  );
}
