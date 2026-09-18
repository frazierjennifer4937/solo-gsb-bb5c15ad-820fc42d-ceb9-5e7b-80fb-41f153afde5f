export interface Subtitle {
  /** 稳定 id，用于 React key 与选中态 */
  id: string;
  /** 原始序号（导入时的顺序，从 1 开始） */
  index: number;
  /** 开始时间，毫秒 */
  start: number;
  /** 结束时间，毫秒 */
  end: number;
  /** 字幕文本（可含多行） */
  text: string;
}
