import type { RefObject } from 'react';

interface VideoPlayerProps {
  url: string;
  name: string;
  videoRef: RefObject<HTMLVideoElement>;
  onTimeUpdate: (t: number) => void;
  onDuration: (d: number) => void;
}

export default function VideoPlayer({ url, name, videoRef, onTimeUpdate, onDuration }: VideoPlayerProps) {
  if (!url) {
    return (
      <div className="video-placeholder">
        <span className="video-placeholder-icon">🎬</span>
        <p>未加载视频</p>
        <p className="dim">点击「导入视频」关联本地视频文件；不导入也可以直接编辑时间轴</p>
      </div>
    );
  }
  return (
    <div className="video-box">
      <video
        ref={videoRef}
        src={url}
        controls
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
      />
      <div className="video-name" title={name}>
        {name}
      </div>
    </div>
  );
}
