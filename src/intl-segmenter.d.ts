/**
 * Intl.Segmenter 的最小类型声明：tsconfig 的 lib 仅含 ES2020，
 * 而所有现代浏览器（Chrome 87+ / Firefox 125+ / Safari 14.1+）均已支持，
 * 运行时不可用时 reflow.ts 会回退到 Array.from 的码点切分。
 */

interface IntlSegmenterSegment {
  readonly segment: string;
  readonly index: number;
  readonly input: string;
  isWordLike?: boolean;
}

interface IntlSegmenterSegments extends Iterable<IntlSegmenterSegment> {
  containing(codeUnitIndex?: number): IntlSegmenterSegment;
  [Symbol.iterator](): IterableIterator<IntlSegmenterSegment>;
}

interface IntlSegmenterOptions {
  granularity?: 'grapheme' | 'word' | 'sentence';
  localeMatcher?: 'best fit' | 'lookup';
}

interface IntlSegmenter {
  segment(input: string): IntlSegmenterSegments;
  resolvedOptions(): Required<Pick<IntlSegmenterOptions, 'granularity' | 'localeMatcher'>> & {
    locale: string;
  };
}

interface IntlSegmenterConstructor {
  new (locales?: string | string[], options?: IntlSegmenterOptions): IntlSegmenter;
  supportedLocalesOf(locales: string | string[]): string[];
}
