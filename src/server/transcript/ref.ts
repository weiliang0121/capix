import type { Transcript } from './transcript.js';

/** Stable position in one append-only Transcript. */
export class MessageRef {
  constructor(
    readonly transcript: Transcript,
    readonly index: number,
  ) {
    if (!Number.isSafeInteger(index) || index < 0 || !transcript.get(index)) throw new RangeError('Message index does not exist');
    Object.freeze(this);
  }

  read() {
    return this.transcript.get(this.index)!;
  }
}

/** A fixed, exclusive upper bound; appends never expand this range. */
export class TranscriptRangeRef {
  constructor(
    readonly transcript: Transcript,
    readonly start: number,
    readonly end: number,
  ) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > transcript.length) throw new RangeError('Transcript range does not exist');
    Object.freeze(this);
  }

  get length(): number {
    return this.end - this.start;
  }

  ref(index: number): MessageRef {
    if (index < this.start || index >= this.end) throw new RangeError('Message is outside the fixed history range');
    return new MessageRef(this.transcript, index);
  }

  refs(): readonly MessageRef[] {
    return Array.from({ length: this.length }, (_, offset) => this.ref(this.start + offset));
  }
}
