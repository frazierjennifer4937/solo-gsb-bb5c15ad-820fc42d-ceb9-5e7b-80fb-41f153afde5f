import { useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { Subtitle } from './types';
import { parseSrt, parseTimeInput, serializeSrt } from './srt';
import { detectIssues } from './issues';
import { alignSubtitles, applyMerge } from './merge';
import { applyDrift, planDrift, validateDrift } from './drift';
import { SAMPLE_SRT } from './sample';
import { useWaveform } from './useWaveform';
import Toolbar from './components/Toolbar';
import VideoPlayer from './components/VideoPlayer';
import Timeline from './components/Timeline';
import IssuesPanel from './components/IssuesPanel';
import RevisionMergePanel from './components/RevisionMergePanel';
import DriftPanel, { EMPTY_DRIFT_FORM } from './components/DriftPanel';
import type { DriftForm } from './components/DriftPanel';
import SilencePanel, { DEFAULT_SILENCE_FORM } from './components/SilencePanel';
import type { SilenceForm } from './components/SilencePanel';
import ReflowPanel, { DEFAULT_REFLOW_FORM, computeReflowPlan } from './components/ReflowPanel';
import type { ReflowForm } from './components/ReflowPanel';
import SceneCutPanel, { DEFAULT_CUT_FORM } from './components/SceneCutPanel';
import type { SceneCutForm } from './components/SceneCutPanel';
import TermProofPanel, { DEFAULT_TERM_FORM, computeTermPlan } from './components/TermProofPanel';
import type { TermProofForm } from './components/TermProofPanel';
import { applyTermProof } from './termproof';
import { useSceneCuts } from './useSceneCuts';
import { findCutConflicts, parseSceneCutParams } from './scenecut';
import { applyReflow } from './reflow';
import { applySilenceSnap, planSilenceSnap, resolveRange, parseSilenceParams } from './silence';
import './styles.css';

interface History {
  past: Subtitle[][];
  present: Subtitle[];
  future: Subtitle[][];
}

const EMPTY_HISTORY: History = { past: [], present: [], future: [] };

export default function App() {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const subs = history.present;

  const [srtName, setSrtName] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoName, setVideoName] = useState('');
  const [currentTime, setCurrentTime] = useState(0); // 秒
  const [videoDuration, setVideoDuration] = useState(0);
  const [chainMode, setChainMode] = useState(true);
  const [follow, setFollow] = useState(true);
  const [pxPerSec, setPxPerSec] = useState(80);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [showDrift, setShowDrift] = useState(false);
  const [showSilence, setShowSilence] = useState(false);
  const [showReflow, setShowReflow] = useState(false);
  const [showCuts, setShowCuts] = useState(false);
  const [showTerm, setShowTerm] = useState(false);
  // 漂移校准表单（锚点选择 + 目标时间输入），面板关闭后保留，重新导入字幕时重置
  const [driftForm, setDriftForm] = useState<DriftForm>(EMPTY_DRIFT_FORM);
  // 静音吸附表单（连续区间 + 阈值等参数），面板关闭后保留，重新导入字幕时重置
  const [silenceForm, setSilenceForm] = useState<SilenceForm>(DEFAULT_SILENCE_FORM);
  // 断行重排表单（连续区间 + 每行最大字素数），面板关闭后保留，重新导入字幕时重置
  const [reflowForm, setReflowForm] = useState<ReflowForm>(DEFAULT_REFLOW_FORM);
  // 术语校对表单（连续区间 + 本地术语表），面板关闭后保留，重新导入字幕时重置
  const [termForm, setTermForm] = useState<TermProofForm>(DEFAULT_TERM_FORM);
  // 镜头切点表单（采样间隔 / 阈值 / 最小间隔 / 容差），面板关闭后保留；
  // 与视频绑定，重新导入字幕不重置
  const [cutForm, setCutForm] = useState<SceneCutForm>(DEFAULT_CUT_FORM);
  // 当前视频文件：切点扫描用独立的隐藏 video 元素读取，不占用播放器
  const [videoFile, setVideoFile] = useState<File | null>(null);
  // 修订稿独立于当前字幕保存：导入不会替换当前时间轴
  const [revision, setRevision] = useState<Subtitle[]>([]);
  const [revisionName, setRevisionName] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const { waveform, loadWaveform, dismissWaveform } = useWaveform();
  const { sceneCuts, startScan, stopScan } = useSceneCuts();

  const issues = useMemo(() => detectIssues(subs), [subs]);

  // 切点参数解析与冲突核对都是只读计算：不写回字幕，撤销历史不受影响
  const cutParams = useMemo(() => parseSceneCutParams(cutForm), [cutForm]);
  const cutConflicts = useMemo(
    () =>
      sceneCuts.status === 'ready' && cutParams.ok
        ? findCutConflicts(subs, sceneCuts.cuts, cutParams.params.toleranceMs)
        : [],
    [subs, sceneCuts, cutParams]
  );

  const waveformReady = waveform.status === 'ready';

  // 波形失效（切换视频 / 关闭波形 / 解码失败）后，静音吸附侧栏自动收起：
  // 面板仅在音频波形就绪时可用
  useEffect(() => {
    if (!waveformReady) setShowSilence(false);
  }, [waveformReady]);

  // 对齐计算较重（大文件毫秒到秒级），用 deferred 值避免拖动字幕时的高频更新阻塞交互；
  // 应用合并（applyRevision）始终基于 history.present 即时重算，不受延迟影响。
  const deferredSubs = useDeferredValue(subs);
  const deferredRevision = useDeferredValue(revision);
  const mergeResult = useMemo(
    () => (deferredRevision.length > 0 ? alignSubtitles(deferredSubs, deferredRevision) : null),
    [deferredSubs, deferredRevision]
  );

  // ---- 历史操作 ----
  /** 拖动结束：把拖动前快照压入历史（present 已在拖动过程中实时更新） */
  const commitDrag = useCallback((before: Subtitle[]) => {
    setHistory((h) => ({ ...h, past: [...h.past, before], future: [] }));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length === 0
        ? h
        : {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
          }
    );
  }, []);

  const redo = useCallback(() => {
    setHistory((h) =>
      h.future.length === 0
        ? h
        : {
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
          }
    );
  }, []);

  const liveChange = useCallback((next: Subtitle[]) => {
    setHistory((h) => ({ ...h, present: next }));
  }, []);

  // ---- 文件导入导出 ----
  const loadSrt = useCallback((content: string, name: string) => {
    const parsed = parseSrt(content);
    setHistory({ past: [], present: parsed, future: [] });
    setSrtName(name);
    setSelectedId(null);
    setCurrentTime(0);
    // 新字幕载入后，旧修订稿的匹配与旧锚点（id 已失效）一并清空
    setRevision([]);
    setRevisionName('');
    setDriftForm(EMPTY_DRIFT_FORM);
    setSilenceForm(DEFAULT_SILENCE_FORM);
    setReflowForm(DEFAULT_REFLOW_FORM);
    setTermForm(DEFAULT_TERM_FORM);
  }, []);

  const importSrt = useCallback(
    async (file: File) => loadSrt(await file.text(), file.name),
    [loadSrt]
  );

  const importRevision = useCallback(
    async (file: File) => {
      const parsed = parseSrt(await file.text());
      setRevision(parsed);
      setRevisionName(file.name);
    },
    []
  );

  const clearRevision = useCallback(() => {
    setRevision([]);
    setRevisionName('');
  }, []);

  // 应用修订稿合并：仅已匹配条目的文本写回当前字幕，id / 序号 / 时间保留，
  // 整批作为一次撤销/重做操作
  const applyRevision = useCallback(() => {
    setHistory((h) => {
      if (revision.length === 0) return h;
      const result = alignSubtitles(h.present, revision);
      if (result.pairs.length === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applyMerge(h.present, revision, result),
        future: [],
      };
    });
  }, [revision]);

  // 应用双锚点漂移校准：所有字幕按锚点方案同步平移（时长不变），
  // 整批作为一次撤销/重做操作
  const applyDriftCalibration = useCallback(() => {
    const inputA = { id: driftForm.a.id, targetStart: parseTimeInput(driftForm.a.target) };
    const inputB = { id: driftForm.b.id, targetStart: parseTimeInput(driftForm.b.target) };
    setHistory((h) => {
      // 基于 history.present 即时校验并重算方案，与面板预览使用同一套规则
      if (validateDrift(h.present, inputA, inputB) !== null) return h;
      const plan = planDrift(h.present, inputA, inputB);
      if (!plan || plan.affected === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applyDrift(h.present, plan.offsets),
        future: [],
      };
    });
  }, [driftForm]);

  // 应用静音吸附：所选连续字幕的起止边界吸附到静音中点（保持顺序、
  // 每条时长达标且互不重叠），整批作为一次撤销/重做操作
  const applySilence = useCallback(() => {
    setHistory((h) => {
      if (waveform.status !== 'ready' || !waveform.data) return h;
      const parsed = parseSilenceParams(silenceForm);
      if (!parsed.ok) return h;
      const targets = resolveRange(h.present, silenceForm.fromId, silenceForm.toId);
      if (!targets) return h;
      // 应用时基于 history.present 即时重算，与面板预览使用同一套规则
      const plan = planSilenceSnap(targets, waveform.data, parsed.params);
      if (!plan || plan.moved === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applySilenceSnap(h.present, plan),
        future: [],
      };
    });
  }, [silenceForm, waveform]);

  // 应用断行重排：仅把勾选且可行（文本确有变化）的条目写回，其余字幕
  // （含无可行方案的条目）原样保留，整批作为一次撤销/重做操作
  const applyReflowSelection = useCallback(
    (checkedIds: Set<string>) => {
      setHistory((h) => {
        // 应用时基于 history.present 即时重算，与面板预览使用同一套规则
        const plan = computeReflowPlan(h.present, reflowForm);
        if (!plan) return h;
        const writeCount = plan.items.filter(
          (it) => it.ok && !it.unchanged && checkedIds.has(it.id)
        ).length;
        if (writeCount === 0) return h;
        const next = applyReflow(h.present, plan, checkedIds);
        return { past: [...h.past, h.present], present: next, future: [] };
      });
    },
    [reflowForm]
  );

  // 应用术语校对：仅把勾选且确有变化的条目的改后文本写回（标签原样、
  // 替换基于原文一次生成），其余字幕原样保留，整批作为一次撤销/重做
  const applyTermSelection = useCallback(
    (checkedIds: Set<string>) => {
      setHistory((h) => {
        // 应用时基于 history.present 即时重算，与面板预览使用同一套规则
        const plan = computeTermPlan(h.present, termForm);
        if (!plan) return h;
        const writeCount = plan.items.filter(
          (it) => !it.unchanged && checkedIds.has(it.id)
        ).length;
        if (writeCount === 0) return h;
        const next = applyTermProof(h.present, plan, checkedIds);
        return { past: [...h.past, h.present], present: next, future: [] };
      });
    },
    [termForm]
  );

  const importVideo = useCallback(    (file: File) => {
      setVideoUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
      setVideoName(file.name);
      setVideoFile(file);
      // 换视频后旧切点结果失效，进行中的扫描一并取消
      stopScan();
      // 浏览器内解码音轨生成波形；失败仅影响波形轨道，不影响字幕编辑。
      // 旧视频的波形数据随状态替换释放，不会累积在内存中。
      loadWaveform(file);
    },
    [loadWaveform, stopScan]
  );

  // 修改切点参数后旧扫描结果失效，立即清空（时间轴上的切点标记一并移除）
  const changeCutForm = useCallback(
    (form: SceneCutForm) => {
      setCutForm(form);
      stopScan();
    },
    [stopScan]
  );

  // 开始切点扫描：分析在浏览器本地进行，只读视频与字幕，不产生历史记录
  const startCutScan = useCallback(() => {
    if (!videoFile || !cutParams.ok) return;
    startScan(videoFile, cutParams.params);
  }, [videoFile, cutParams, startScan]);

  const loadSample = useCallback(() => loadSrt(SAMPLE_SRT, '示例字幕.srt'), [loadSrt]);

  const exportSrt = useCallback(() => {
    const blob = new Blob([serializeSrt(subs)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = srtName ? srtName.replace(/\.srt$/i, '') + '.fixed.srt' : 'fixed.srt';
    a.click();
    URL.revokeObjectURL(url);
  }, [subs, srtName]);

  // ---- 播放与跳转 ----
  const seekTo = useCallback((sec: number) => {
    if (videoRef.current) videoRef.current.currentTime = sec;
    setCurrentTime(sec);
  }, []);

  const jumpTo = useCallback(
    (id: string, sec: number) => {
      setSelectedId(id);
      seekTo(sec);
    },
    [seekTo]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setHistory((h) => ({
      past: [...h.past, h.present],
      present: h.present.filter((s) => s.id !== selectedId),
      future: [],
    }));
    setSelectedId(null);
  }, [selectedId]);

  // ---- 快捷键 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectedId, deleteSelected]);

  // 时间轴总时长：视频时长、字幕末尾、30 秒下限，再留 10 秒余量
  const timelineDuration =
    Math.max(videoDuration, ...subs.map((s) => s.end / 1000), 30) + 10;

  return (
    <div className="app">
      <Toolbar
        srtName={srtName}
        videoName={videoName}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        chainMode={chainMode}
        follow={follow}
        pxPerSec={pxPerSec}
        hasSubs={subs.length > 0}
        hasSelection={selectedId !== null}
        showMerge={showMerge}
        showDrift={showDrift}
        showSilence={showSilence}
        showReflow={showReflow}
        showCuts={showCuts}
        showTerm={showTerm}
        canSilence={waveformReady}
        canCuts={videoFile !== null}
        onImportSrt={importSrt}
        onImportVideo={importVideo}
        onLoadSample={loadSample}
        onExport={exportSrt}
        onUndo={undo}
        onRedo={redo}
        onToggleChain={setChainMode}
        onToggleFollow={setFollow}
        onZoom={setPxPerSec}
        onDeleteSelected={deleteSelected}
        onToggleMerge={() => {
          // 侧栏互斥，避免同时挤压视频区
          setShowMerge((v) => !v);
          setShowDrift(false);
          setShowSilence(false);
          setShowReflow(false);
          setShowCuts(false);
          setShowTerm(false);
        }}
        onToggleDrift={() => {
          setShowDrift((v) => !v);
          setShowMerge(false);
          setShowSilence(false);
          setShowReflow(false);
          setShowCuts(false);
          setShowTerm(false);
        }}
        onToggleSilence={() => {
          // 侧栏互斥；未就绪时按钮禁用，这里再兜底一次
          if (!waveformReady) return;
          setShowSilence((v) => !v);
          setShowMerge(false);
          setShowDrift(false);
          setShowReflow(false);
          setShowCuts(false);
          setShowTerm(false);
        }}
        onToggleReflow={() => {
          setShowReflow((v) => !v);
          setShowMerge(false);
          setShowDrift(false);
          setShowSilence(false);
          setShowCuts(false);
          setShowTerm(false);
        }}
        onToggleCuts={() => {
          setShowCuts((v) => !v);
          setShowMerge(false);
          setShowDrift(false);
          setShowSilence(false);
          setShowReflow(false);
          setShowTerm(false);
        }}
        onToggleTerm={() => {
          setShowTerm((v) => !v);
          setShowMerge(false);
          setShowDrift(false);
          setShowSilence(false);
          setShowReflow(false);
          setShowCuts(false);
        }}
      />

      <main className="main">
        <section className="top-row">
          <VideoPlayer
            url={videoUrl}
            name={videoName}
            videoRef={videoRef}
            onTimeUpdate={setCurrentTime}
            // 部分录制文件（如 MediaRecorder 产物）元数据时长为 Infinity，
            // 直接采用会让时间轴刻度循环失控，这里丢弃非有限时长
            onDuration={(d) => setVideoDuration(Number.isFinite(d) ? d : 0)}
          />
          <IssuesPanel subs={subs} issues={issues} selectedId={selectedId} onJump={jumpTo} />
          {showMerge && (
            <RevisionMergePanel
              subs={subs}
              revision={revision}
              revisionName={revisionName}
              result={mergeResult}
              selectedId={selectedId}
              onImportRevision={importRevision}
              onApply={applyRevision}
              onClear={clearRevision}
              onJump={jumpTo}
            />
          )}
          {showDrift && (
            <DriftPanel
              subs={subs}
              currentTime={currentTime}
              form={driftForm}
              onFormChange={setDriftForm}
              onApply={applyDriftCalibration}
            />
          )}
          {showSilence && waveformReady && (
            <SilencePanel
              subs={subs}
              waveform={waveform}
              form={silenceForm}
              onFormChange={setSilenceForm}
              selectedId={selectedId}
              onJump={jumpTo}
              onApply={applySilence}
            />
          )}
          {showReflow && (
            <ReflowPanel
              subs={subs}
              form={reflowForm}
              onFormChange={setReflowForm}
              selectedId={selectedId}
              onJump={jumpTo}
              onApply={applyReflowSelection}
            />
          )}
          {showCuts && (
            <SceneCutPanel
              hasVideo={videoFile !== null}
              hasSubs={subs.length > 0}
              form={cutForm}
              onFormChange={changeCutForm}
              paramsError={cutParams.ok ? null : cutParams.error}
              scan={sceneCuts}
              conflicts={cutConflicts}
              selectedId={selectedId}
              onJump={jumpTo}
              onStart={startCutScan}
              onCancel={stopScan}
            />
          )}
          {showTerm && (
            <TermProofPanel
              subs={subs}
              form={termForm}
              onFormChange={setTermForm}
              selectedId={selectedId}
              onJump={jumpTo}
              onApply={applyTermSelection}
            />
          )}
        </section>

        <Timeline
          subs={subs}
          issues={issues}
          duration={timelineDuration}
          pxPerSec={pxPerSec}
          currentTime={currentTime}
          chainMode={chainMode}
          selectedId={selectedId}
          follow={follow}
          waveform={waveform}
          cuts={sceneCuts.cuts}
          onSelect={setSelectedId}
          onSeek={seekTo}
          onLiveChange={liveChange}
          onDragCommit={commitDrag}
          onDismissWaveform={dismissWaveform}
        />
      </main>
    </div>
  );
}
