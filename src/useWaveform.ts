import { useCallback, useEffect, useRef, useState } from 'react';
import { computePeaks, decodeAudioTrack, WaveformError, type WaveformData } from './waveform';

export type WaveformStatus = 'idle' | 'decoding' | 'ready' | 'error';

export interface WaveformState {
  status: WaveformStatus;
  /** 峰值数据，仅保存在内存中，切换视频时随状态替换被回收 */
  data: WaveformData | null;
  error: string | null;
}

const IDLE: WaveformState = { status: 'idle', data: null, error: null };

/**
 * 波形解码状态机：idle → decoding → ready / error。
 * 每次 load 递增任务号，旧任务的结果到达时直接丢弃，避免快速切换视频产生竞态。
 */
export function useWaveform() {
  const [state, setState] = useState<WaveformState>(IDLE);
  const jobRef = useRef(0);

  const load = useCallback((file: File) => {
    const job = ++jobRef.current;
    // 旧视频的峰值数据随状态替换释放（GC），AudioContext 在解码函数内关闭
    setState({ status: 'decoding', data: null, error: null });
    (async () => {
      try {
        const audio = await decodeAudioTrack(file);
        const data = computePeaks(audio);
        if (jobRef.current === job) setState({ status: 'ready', data, error: null });
      } catch (err) {
        if (jobRef.current !== job) return;
        const message =
          err instanceof WaveformError
            ? err.message
            : `音频解码失败：${err instanceof Error ? err.message : String(err)}`;
        setState({ status: 'error', data: null, error: message });
      }
    })();
  }, []);

  /** 关闭提示 / 隐藏波形：回到 idle，不影响字幕编辑 */
  const dismiss = useCallback(() => {
    jobRef.current++; // 使进行中的解码结果失效
    setState(IDLE);
  }, []);

  // 卸载时使进行中的任务失效，峰值数据随组件卸载释放
  useEffect(
    () => () => {
      jobRef.current++;
    },
    []
  );

  return { waveform: state, loadWaveform: load, dismissWaveform: dismiss };
}
