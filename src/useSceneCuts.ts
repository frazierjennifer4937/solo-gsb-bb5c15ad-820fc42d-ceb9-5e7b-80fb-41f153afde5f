import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeHistogram,
  histogramDiff,
  selectCuts,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  type SceneCut,
  type SceneCutParams,
} from './scenecut';

export type SceneCutStatus = 'idle' | 'scanning' | 'ready' | 'error';

export interface SceneCutState {
  status: SceneCutStatus;
  /** 检测到的切点（仅 ready 时非空），按时间升序 */
  cuts: SceneCut[];
  /** 已处理帧数 / 总帧数（scanning 时用于进度显示） */
  done: number;
  total: number;
  error: string | null;
}

const IDLE: SceneCutState = { status: 'idle', cuts: [], done: 0, total: 0, error: null };

/** 单次定位 / 读取元数据的超时：防止损坏文件让扫描永远挂起 */
const SEEK_TIMEOUT_MS = 8000;
/** 采样点数量上限：防止过小间隔 × 超长视频导致扫描不可控 */
const MAX_SAMPLES = 200_000;

/** 可预期的扫描失败（无法解码 / 超时 / 采样点过多），message 可直接展示 */
export class SceneCutError extends Error {}

/**
 * 镜头切点扫描状态机：idle → scanning → ready / error，可随时取消回 idle。
 * 分析使用独立的隐藏 video 元素逐帧定位取图，不影响播放器，也不上传数据；
 * 每次 start 递增任务号，旧任务的结果到达时直接丢弃，避免竞态。
 */
export function useSceneCuts() {
  const [state, setState] = useState<SceneCutState>(IDLE);
  const jobRef = useRef(0);
  const cancelRef = useRef<(() => void) | null>(null);

  const start = useCallback((file: File, params: SceneCutParams) => {
    const job = ++jobRef.current;
    cancelRef.current?.(); // 停掉进行中的旧扫描，释放其资源
    setState({ status: 'scanning', cuts: [], done: 0, total: 0, error: null });

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let cancelled = false;
    let disposed = false;
    let pendingReject: ((e: Error) => void) | null = null;

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load(); // 释放解码资源
    };

    cancelRef.current = () => {
      cancelled = true;
      pendingReject?.(new SceneCutError('扫描已取消'));
      pendingReject = null;
      dispose();
    };

    /** 等待一个 video 事件；超时、出错或取消时拒绝 */
    const waitFor = (event: string, timeoutMessage: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => finish(() => reject(new SceneCutError(timeoutMessage))),
          SEEK_TIMEOUT_MS
        );
        const onEvent = () => finish(resolve);
        const onError = () =>
          finish(() => reject(new SceneCutError('无法解码视频：格式不受支持或文件已损坏')));
        function finish(done: () => void) {
          window.clearTimeout(timer);
          pendingReject = null;
          video.removeEventListener(event, onEvent);
          video.removeEventListener('error', onError);
          done();
        }
        pendingReject = (e) => finish(() => reject(e));
        video.addEventListener(event, onEvent);
        video.addEventListener('error', onError);
      });

    /** 定位到指定时间（秒）；已停在目标位置且画面就绪时跳过 */
    const seekTo = async (t: number) => {
      if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return;
      const p = waitFor('seeked', '视频定位超时：文件可能已损坏');
      video.currentTime = t;
      await p;
    };

    (async () => {
      try {
        if (!ctx) throw new SceneCutError('当前浏览器不支持 Canvas 2D，无法分析画面');
        video.src = url;
        await waitFor('loadedmetadata', '读取视频信息超时：文件可能已损坏');
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0)
          throw new SceneCutError('无法读取视频时长，无法扫描');
        // 等首帧解码完成，保证 t=0 的采样能取到图
        if (video.readyState < 2) await waitFor('loadeddata', '视频首帧解码超时');

        const intervalSec = params.intervalMs / 1000;
        // 采样点：0, interval, 2*interval, …（严格小于 duration）
        const total = Math.max(1, Math.ceil(duration / intervalSec - 1e-6));
        if (total > MAX_SAMPLES)
          throw new SceneCutError(`采样点过多（约 ${total} 个）：请增大采样间隔`);

        const candidates: SceneCut[] = [];
        let prevHist: Uint32Array | null = null;
        for (let i = 0; i < total; i++) {
          if (cancelled || jobRef.current !== job) return;
          const t = i * intervalSec;
          if (t >= duration) break;
          await seekTo(t);
          if (cancelled || jobRef.current !== job) return;
          ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
          const pixels = ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data;
          const hist = computeHistogram(pixels);
          if (prevHist) {
            const diff = histogramDiff(prevHist, hist, FRAME_WIDTH * FRAME_HEIGHT);
            if (diff > params.threshold) {
              candidates.push({ time: Math.round(t * 1000), diff });
            }
          }
          prevHist = hist;
          setState({ status: 'scanning', cuts: [], done: i + 1, total, error: null });
        }

        const cuts = selectCuts(candidates, params.minGapMs);
        if (cancelled || jobRef.current !== job) return;
        setState({ status: 'ready', cuts, done: total, total, error: null });
      } catch (err) {
        if (cancelled || jobRef.current !== job) return;
        const message =
          err instanceof SceneCutError
            ? err.message
            : `扫描失败：${err instanceof Error ? err.message : String(err)}`;
        setState({ status: 'error', cuts: [], done: 0, total: 0, error: message });
      } finally {
        dispose();
        if (jobRef.current === job) cancelRef.current = null;
      }
    })();
  }, []);

  /** 取消扫描 / 清空结果：回到 idle；重新导入视频或修改参数时调用 */
  const stop = useCallback(() => {
    jobRef.current++;
    cancelRef.current?.();
    cancelRef.current = null;
    setState(IDLE);
  }, []);

  // 卸载时取消进行中的扫描，隐藏 video 与 object URL 随 dispose 释放
  useEffect(
    () => () => {
      jobRef.current++;
      cancelRef.current?.();
    },
    []
  );

  return { sceneCuts: state, startScan: start, stopScan: stop };
}
