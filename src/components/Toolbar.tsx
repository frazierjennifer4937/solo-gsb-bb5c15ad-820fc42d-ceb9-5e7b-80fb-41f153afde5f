import { useRef } from 'react';

interface ToolbarProps {
  srtName: string;
  videoName: string;
  canUndo: boolean;
  canRedo: boolean;
  chainMode: boolean;
  follow: boolean;
  pxPerSec: number;
  hasSubs: boolean;
  hasSelection: boolean;
  showMerge: boolean;
  showDrift: boolean;
  showSilence: boolean;
  showReflow: boolean;
  showCuts: boolean;
  showGlossary: boolean;
  /** 音频波形是否就绪：静音吸附仅在波形就绪后可用 */
  canSilence: boolean;
  /** 是否已导入视频：切点检查仅在导入视频后可用 */
  canCuts: boolean;
  onImportSrt: (file: File) => void;
  onImportVideo: (file: File) => void;
  onLoadSample: () => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleChain: (v: boolean) => void;
  onToggleFollow: (v: boolean) => void;
  onZoom: (v: number) => void;
  onDeleteSelected: () => void;
  onToggleMerge: () => void;
  onToggleDrift: () => void;
  onToggleSilence: () => void;
  onToggleReflow: () => void;
  onToggleCuts: () => void;
  onToggleGlossary: () => void;
}

export default function Toolbar(props: ToolbarProps) {
  const srtInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const pick =
    (cb: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) cb(file);
      e.target.value = '';
    };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-icon">🛠️</span>
        <h1>字幕时间轴修复器</h1>
      </div>

      <div className="tool-group">
        <button className="btn primary" onClick={() => srtInputRef.current?.click()}>
          📄 导入 SRT
        </button>
        <button className="btn primary" onClick={() => videoInputRef.current?.click()}>
          🎬 导入视频
        </button>
        <button className="btn" onClick={props.onLoadSample}>
          ✨ 加载示例
        </button>
        <input
          ref={srtInputRef}
          type="file"
          accept=".srt,text/plain"
          hidden
          onChange={pick(props.onImportSrt)}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={pick(props.onImportVideo)}
        />
      </div>

      <div className="tool-group">
        <button className="btn" disabled={!props.canUndo} onClick={props.onUndo} title="Ctrl+Z">
          ↶ 撤销
        </button>
        <button className="btn" disabled={!props.canRedo} onClick={props.onRedo} title="Ctrl+Shift+Z / Ctrl+Y">
          ↷ 重做
        </button>
        <button
          className="btn danger"
          disabled={!props.hasSelection}
          onClick={props.onDeleteSelected}
          title="Delete"
        >
          🗑 删除选中
        </button>
        <button
          className={`btn ${props.showMerge ? 'primary' : ''}`}
          disabled={!props.hasSubs}
          onClick={props.onToggleMerge}
          title={props.hasSubs ? '打开修订稿合并侧栏' : '请先导入当前字幕'}
        >
          📚 修订稿合并
        </button>
        <button
          className={`btn ${props.showDrift ? 'primary' : ''}`}
          disabled={!props.hasSubs}
          onClick={props.onToggleDrift}
          title={props.hasSubs ? '打开双锚点漂移校准侧栏' : '请先导入当前字幕'}
        >
          ⚓ 漂移校准
        </button>
        <button
          className={`btn ${props.showSilence ? 'primary' : ''}`}
          disabled={!props.canSilence}
          onClick={props.onToggleSilence}
          title={
            props.canSilence
              ? '打开静音吸附侧栏：按音频静音段对齐字幕起止边界'
              : '请先导入视频并等待音频波形就绪'
          }
        >
          🔇 静音吸附
        </button>
        <button
          className={`btn ${props.showReflow ? 'primary' : ''}`}
          disabled={!props.hasSubs}
          onClick={props.onToggleReflow}
          title={
            props.hasSubs
              ? '打开断行重排侧栏：按每行最大字素数把字幕排成一行或两行'
              : '请先导入当前字幕'
          }
        >
          📏 断行重排
        </button>
        <button
          className={`btn ${props.showGlossary ? 'primary' : ''}`}
          disabled={!props.hasSubs}
          onClick={props.onToggleGlossary}
          title={
            props.hasSubs
              ? '打开术语校对侧栏：按本地术语表把错误写法替换为标准写法'
              : '请先导入当前字幕'
          }
        >
          🔤 术语校对
        </button>
        <button
          className={`btn ${props.showCuts ? 'primary' : ''}`}
          disabled={!props.canCuts}
          onClick={props.onToggleCuts}
          title={
            props.canCuts
              ? '打开镜头切点检查侧栏：检测画面切点并核对字幕边界'
              : '请先导入视频'
          }
        >
          ✂️ 切点检查
        </button>
      </div>

      <div className="tool-group">
        <label className="switch" title="移动某条字幕时，其后字幕保持相对间隔同步平移">
          <input
            type="checkbox"
            checked={props.chainMode}
            onChange={(e) => props.onToggleChain(e.target.checked)}
          />
          <span>连锁移动</span>
        </label>
        <label className="switch" title="播放时时间轴自动跟随播放头滚动">
          <input
            type="checkbox"
            checked={props.follow}
            onChange={(e) => props.onToggleFollow(e.target.checked)}
          />
          <span>跟随播放</span>
        </label>
        <label className="zoom">
          缩放
          <input
            type="range"
            min={20}
            max={300}
            step={10}
            value={props.pxPerSec}
            onChange={(e) => props.onZoom(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="tool-group right">
        <button className="btn success" disabled={!props.hasSubs} onClick={props.onExport}>
          💾 导出修复后 SRT
        </button>
      </div>

      <div className="file-hints">
        {props.srtName && <span className="file-chip">📄 {props.srtName}</span>}
        {props.videoName && <span className="file-chip">🎬 {props.videoName}</span>}
      </div>
    </header>
  );
}
