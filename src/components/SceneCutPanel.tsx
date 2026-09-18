import type { SceneCutState } from '../useSceneCuts';
import type { CutConflict, CutConflictType } from '../scenecut';
import { formatTimestamp } from '../srt';

/** 镜头切点表单：采样间隔 / 差值阈值 / 最小切点间隔 / 边界容差（原始文本） */
export interface SceneCutForm {
  intervalMs: string;
  threshold: string;
  minGapMs: string;
  toleranceMs: string;
}

export const DEFAULT_CUT_FORM: SceneCutForm = {
  intervalMs: '500',
  threshold: '0.4',
  minGapMs: '1000',
  toleranceMs: '150',
};

const TYPE_LABELS: Record<CutConflictType, string> = {
  cross: '跨越切点',
  start: '起点贴近',
  end: '终点贴近',
};

interface SceneCutPanelProps {
  hasVideo: boolean;
  hasSubs: boolean;
  form: SceneCutForm;
  onFormChange: (form: SceneCutForm) => void;
  /** 参数校验错误（null 表示参数有效） */
  paramsError: string | null;
  scan: SceneCutState;
  conflicts: CutConflict[];
  selectedId: string | null;
  onJump: (id: string, sec: number) => void;
  onStart: () => void;
  onCancel: () => void;
}

export default function SceneCutPanel({
  hasVideo,
  hasSubs,
  form,
  onFormChange,
  paramsError,
  scan,
  conflicts,
  selectedId,
  onJump,
  onStart,
  onCancel,
}: SceneCutPanelProps) {
  const update = (patch: Partial<SceneCutForm>) => onFormChange({ ...form, ...patch });
  const scanning = scan.status === 'scanning';
  const percent = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;

  return (
    <aside className="cut-panel">
      <div className="cut-header">
        <span className="cut-title">镜头切点检查</span>
      </div>

      <div className="cut-body">
        {!hasVideo && (
          <div className="merge-empty">
            导入视频后可扫描镜头切点；分析在浏览器本地进行，不上传视频，也不修改字幕
          </div>
        )}

        {hasVideo && (
          <>
            <div className="cut-params">
              <label className="cut-param">
                <span>采样间隔（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="50"
                  min="50"
                  value={form.intervalMs}
                  onChange={(e) => update({ intervalMs: e.target.value })}
                />
              </label>
              <label className="cut-param">
                <span>差值阈值（0–1）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="0.05"
                  min="0"
                  max="1"
                  value={form.threshold}
                  onChange={(e) => update({ threshold: e.target.value })}
                />
              </label>
              <label className="cut-param">
                <span>最小切点间隔（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="100"
                  min="0"
                  value={form.minGapMs}
                  onChange={(e) => update({ minGapMs: e.target.value })}
                />
              </label>
              <label className="cut-param">
                <span>边界容差（ms）</span>
                <input
                  type="number"
                  className="drift-input"
                  step="10"
                  min="0"
                  value={form.toleranceMs}
                  onChange={(e) => update({ toleranceMs: e.target.value })}
                />
              </label>
            </div>

            {paramsError && <div className="drift-error">{paramsError}</div>}

            {scan.status === 'idle' && (
              <div className="merge-empty">
                设置参数后点击「开始扫描」；修改参数或重新导入视频会清空已有结果
              </div>
            )}

            {scanning && (
              <div className="cut-progress">
                <div className="cut-progress-track">
                  <div className="cut-progress-bar" style={{ width: `${percent}%` }} />
                </div>
                <span className="cut-progress-text">
                  正在扫描 {scan.done}/{scan.total} 帧（{percent}%），可随时取消
                </span>
              </div>
            )}

            {scan.status === 'error' && <div className="drift-error">{scan.error}</div>}

            {scan.status === 'ready' && (
              <div className="drift-summary">
                <span>
                  检测到切点 <b>{scan.cuts.length}</b> 个 · 冲突 <b>{conflicts.length}</b> 条
                </span>
                <span className="dim">
                  切点已标注在时间轴；点击下面条目跳转到切点画面，分析不修改字幕
                </span>
              </div>
            )}

            {scan.status === 'ready' && scan.cuts.length === 0 && (
              <div className="merge-empty">
                未检测到切点：可降低差值阈值或减小采样间隔后重新扫描
              </div>
            )}

            {scan.status === 'ready' && scan.cuts.length > 0 && !hasSubs && (
              <div className="merge-empty">
                未导入字幕：切点已标注在时间轴，导入字幕后可核对冲突
              </div>
            )}

            {scan.status === 'ready' &&
              scan.cuts.length > 0 &&
              hasSubs &&
              conflicts.length === 0 && (
                <div className="issues-empty ok">✅ 所有字幕边界均避开切点</div>
              )}

            {conflicts.length > 0 && (
              <div className="cut-list">
                {conflicts.map((c) => (
                  <div
                    key={`${c.id}-${c.cutTime}`}
                    className={`cut-row ${c.id === selectedId ? 'active' : ''}`}
                    onClick={() => onJump(c.id, c.cutTime / 1000)}
                  >
                    <div className="cut-row-head">
                      <span className="cut-row-idx">#{c.index}</span>
                      <span className="cut-badges">
                        {c.types.map((t) => (
                          <i key={t} className={`cut-badge ${t}`}>
                            {TYPE_LABELS[t]}
                          </i>
                        ))}
                      </span>
                    </div>
                    <div className="cut-meta">
                      切点 {formatTimestamp(c.cutTime)} · 差值 {c.cutDiff.toFixed(3)}
                    </div>
                    <div className="cut-sub-time">
                      字幕 {formatTimestamp(c.subStart)} → {formatTimestamp(c.subEnd)}
                    </div>
                    {c.text && <div className="cut-text">{c.text}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="drift-footer">
        {scanning ? (
          <button className="btn danger" onClick={onCancel}>
            ✖ 取消扫描
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={!hasVideo || paramsError !== null}
            onClick={onStart}
            title={
              !hasVideo ? '请先导入视频' : paramsError ?? '按当前参数扫描镜头切点，结果只读不改字幕'
            }
          >
            🔍 {scan.status === 'ready' || scan.status === 'error' ? '重新扫描' : '开始扫描'}
          </button>
        )}
      </div>
    </aside>
  );
}
