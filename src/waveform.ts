/**
 * 音频波形：用 Web Audio API 在浏览器内解码音轨，
 * 按固定时间桶统计正/负峰值。数据仅驻留内存，不写入磁盘、不上传。
 */

export interface WaveformData {
  /** 每个时间桶的最小采样值（负峰） */
  mins: Float32Array;
  /** 每个时间桶的最大采样值（正峰） */
  maxs: Float32Array;
  /** 每个时间桶的时长（秒），整条音轨统一 */
  bucketSec: number;
  /** 音轨时长（秒） */
  duration: number;
}

/** 时间桶下限：10ms，放大到最高缩放级别时每个桶仍占多个像素 */
const MIN_BUCKET_SEC = 0.01;
/** 桶数量上限：防止超长音频占用过多内存（50 万桶 × 2 组峰值 ≈ 4MB） */
const MAX_BUCKETS = 500_000;

/** 可预期的解码失败（无音轨 / 格式不支持 / 浏览器不支持），message 可直接展示 */
export class WaveformError extends Error {}

/**
 * 解码文件音轨。AudioContext 在解码完成后立即关闭，
 * 返回的 AudioBuffer 独立于上下文存在。
 */
export async function decodeAudioTrack(file: File): Promise<AudioBuffer> {
  const Ctor =
    typeof window.AudioContext !== 'undefined'
      ? window.AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new WaveformError('当前浏览器不支持 Web Audio API，无法生成波形');

  const ctx = new Ctor();
  try {
    const encoded = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(encoded).catch(() => {
      throw new WaveformError('无法解码音轨：文件可能不含音轨、格式不受支持或已损坏');
    });
    if (audio.numberOfChannels === 0 || audio.length === 0) {
      throw new WaveformError('该文件不包含可解码的音轨');
    }
    return audio;
  } finally {
    // 关闭上下文释放解码资源；AudioBuffer 不受影响
    void ctx.close().catch(() => undefined);
  }
}

/** 按固定时间桶计算所有声道混合后的正/负峰值 */
export function computePeaks(audio: AudioBuffer): WaveformData {
  const { duration, sampleRate, numberOfChannels } = audio;
  const bucketSec = Math.max(MIN_BUCKET_SEC, duration / MAX_BUCKETS);
  const bucketCount = Math.max(1, Math.ceil(duration / bucketSec));
  const mins = new Float32Array(bucketCount).fill(Infinity);
  const maxs = new Float32Array(bucketCount).fill(-Infinity);
  const samplesPerBucket = bucketSec * sampleRate;

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let b = 0; b < bucketCount; b++) {
      const from = Math.floor(b * samplesPerBucket);
      const to = Math.min(data.length, Math.floor((b + 1) * samplesPerBucket));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn < mins[b]) mins[b] = mn;
      if (mx > maxs[b]) maxs[b] = mx;
    }
  }

  // 尾部没有采样覆盖的桶按静音处理
  for (let b = 0; b < bucketCount; b++) {
    if (mins[b] === Infinity) {
      mins[b] = 0;
      maxs[b] = 0;
    }
  }
  return { mins, maxs, bucketSec, duration };
}
