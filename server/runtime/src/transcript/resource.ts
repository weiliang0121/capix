import type { Transcript } from './transcript.js';
import type { Message } from '@capix-observer/protocol';
import type { ChangeSource } from '../records/source.js';
import { ResourceOffer } from '../resource/offer.js';
import { TranscriptRangeRef } from './ref.js';

/** Fixed membership over immutable messages; the source and its mutation methods remain private. */
export class TranscriptRangeReader {
  readonly #range: TranscriptRangeRef;
  readonly start: number;
  readonly end: number;

  constructor(range: TranscriptRangeRef) {
    this.#range = range;
    this.start = range.start;
    this.end = range.end;
    Object.freeze(this);
  }

  get length(): number {
    return this.end - this.start;
  }

  read(index: number) {
    return this.#range.read(index);
  }

  slice(start: number, end = this.end): TranscriptRangeReader {
    if (start < this.start || end > this.end) throw new RangeError('Requested range exceeds available messages');
    return new TranscriptRangeReader(new TranscriptRangeRef(this.#range.transcript, start, end));
  }

  entries() {
    return Object.freeze(
      Array.from({ length: this.length }, (_, offset) => {
        const index = this.start + offset;
        return Object.freeze({ index, message: this.read(index) });
      }),
    );
  }
}

/** Published by the message resource, independent of E/O/A and the application's history alias. */
export const TranscriptResource = Object.freeze({
  append: new ResourceOffer('transcript.append', (transcript: Transcript) =>
    Object.freeze({
      append(messages: readonly Message[], source?: ChangeSource) {
        const start = transcript.length;
        transcript.appendFrom(messages, source);
        return Object.freeze(messages.map((_, offset) => Object.freeze({ index: start + offset, message: transcript.get(start + offset)! })));
      },
    }),
  ),
  segmentation: new ResourceOffer('transcript.segmentation', (transcript: Transcript) =>
    Object.freeze({
      current: () => new TranscriptRangeReader(new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length)),
      start: (index: number) => transcript.startSegment(index),
    }),
  ),
  fixedRange: new ResourceOffer('transcript.fixedRange', (range: TranscriptRangeRef) => new TranscriptRangeReader(range), 'binding'),
});
