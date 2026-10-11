export type TextSource = { text: string; complete: boolean };

export type TextRevealSnapshot = Readonly<{ text: string; phase: 'revealing' | 'waiting' | 'finished' }>;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const baseRate = 40;
const maximumRate = 120;
const remainingSeconds = 8;
const maximumFrameMs = 100;

/** A presentation clock. Receiving text never advances the clock or business state. */
export class TextReveal {
  private source: TextSource;
  private ends: number[];
  private visible = 0;
  private rate = baseRate;
  private credit = 0;
  private previousTick?: number;
  private immediate = false;
  private state: TextRevealSnapshot = Object.freeze({ text: '', phase: 'waiting' });

  constructor(source: TextSource) {
    this.source = { ...source };
    this.ends = graphemeEnds(source.text);
    if (source.complete) this.selectFinalRate();
    this.publish();
  }

  get snapshot(): TextRevealSnapshot {
    return this.state;
  }

  receive(source: TextSource): void {
    const previous = this.source;
    const textChanged = source.text !== previous.text;
    const complete = previous.complete || source.complete;
    const wasWaiting = this.state.phase !== 'revealing';
    this.source = { text: source.text, complete };
    if (textChanged) {
      // Already published text may gain a combining mark or an emoji continuation.
      // Keep its grapheme position, then reveal the whole updated cluster.
      this.ends = graphemeEnds(source.text);
      if (previous.complete || !source.text.startsWith(previous.text)) this.immediate = true;
    }
    if (this.immediate) this.visible = this.ends.length;
    if (!previous.complete && complete) this.selectFinalRate();
    if (wasWaiting || this.immediate) this.pause();
    this.publish();
  }

  tick(now: number): boolean {
    if (this.state.phase !== 'revealing') {
      this.pause();
      return false;
    }
    const previous = this.previousTick;
    this.previousTick = now;
    if (previous === undefined || now <= previous) return false;
    const elapsed = Math.min(now - previous, maximumFrameMs);
    this.credit += (elapsed / 1000) * this.rate;
    const advance = Math.floor(this.credit);
    if (!advance) return false;
    this.credit -= advance;
    this.visible = Math.min(this.visible + advance, this.ends.length);
    if (this.visible === this.ends.length) this.pause();
    return this.publish();
  }

  /** Hidden or inactive views accrue no display time. */
  pause(): void {
    this.previousTick = undefined;
    this.credit = 0;
  }

  /** Show this source and any later additions immediately. */
  finish(): void {
    this.immediate = true;
    this.visible = this.ends.length;
    this.pause();
    this.publish();
  }

  private selectFinalRate(): void {
    this.rate = Math.min(maximumRate, Math.max(this.rate, (this.ends.length - this.visible) / remainingSeconds));
  }

  private publish(): boolean {
    const text = this.source.text.slice(0, this.ends[this.visible - 1] ?? 0);
    const phase = this.visible < this.ends.length ? 'revealing' : this.source.complete ? 'finished' : 'waiting';
    if (this.state.text === text && this.state.phase === phase) return false;
    this.state = Object.freeze({ text, phase });
    return true;
  }
}

function graphemeEnds(text: string): number[] {
  return Array.from(segmenter.segment(text), (segment) => segment.index + segment.segment.length);
}
