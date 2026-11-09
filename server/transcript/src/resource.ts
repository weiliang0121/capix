import { Transcript } from './transcript.js';
import type { Message, TranscriptRangeLocator } from '@weiliang0121/capix-protocol';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { ResourceEndpointActivity } from '@weiliang0121/capix-resources';
import { TranscriptRangeRef } from './ref.js';
import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import type { TranscriptAppendProgress } from './progress.js';

/** Binding-local commit receiver; business only receives the append endpoint. */
export interface TranscriptAppendSource {
  readonly transcript: Transcript;
  readonly progress?: ProgressReceiver<TranscriptAppendProgress>;
}

/** Fixed message membership; endpoints retain private entity access, records only retain locators. */
export class TranscriptRangeReader {
  readonly #range: TranscriptRangeRef;
  readonly #activity?: ResourceEndpointActivity;
  readonly start: number;
  readonly end: number;
  readonly transcriptId: string;
  readonly revision: number;

  constructor(range: TranscriptRangeRef, activity?: ResourceEndpointActivity, revision = range.transcript.revision) {
    this.#range = range;
    this.#activity = activity;
    this.start = range.start;
    this.end = range.end;
    this.transcriptId = range.transcript.id;
    this.revision = revision;
    Object.freeze(this);
  }
  get length(): number {
    return this.end - this.start;
  }
  locate(): TranscriptRangeLocator {
    return Object.freeze({ transcriptId: this.transcriptId, start: this.start, end: this.end, revision: this.revision });
  }
  read(index: number) {
    const read = () => this.#range.read(index);
    return this.#activity ? this.#activity.runSync('read', { input: () => ({ transcriptId: this.transcriptId, index }), output: () => ({ transcriptId: this.transcriptId, index }) }, read) : read();
  }
  slice(start: number, end = this.end): TranscriptRangeReader {
    this.#activity?.validate();
    if (start < this.start || end > this.end) throw new RangeError('Requested range exceeds available messages');
    return new TranscriptRangeReader(new TranscriptRangeRef(this.#range.transcript, start, end), this.#activity, this.revision);
  }
  entries() {
    const read = () =>
      Object.freeze(
        Array.from({ length: this.length }, (_, offset) => {
          const index = this.start + offset;
          return Object.freeze({ index, message: this.#range.read(index) });
        }),
      );
    return this.#activity ? this.#activity.runSync('entries', { input: () => this.locate(), output: () => this.locate() }, read) : read();
  }
}

export const TranscriptResource = Object.freeze({
  append: new ResourceOffer({
    name: 'transcript.append',
    expose: (source: Transcript | TranscriptAppendSource, activity) => {
      const transcript = source instanceof Transcript ? source : source.transcript;
      const progress = source instanceof Transcript || !source.progress ? undefined : new ProgressChannel(source.progress);
      return Object.freeze({
        applyFixed(input: { readonly position: string; readonly messages: readonly Message[] }) {
          return activity.runSync('applyFixed', { input: () => ({ position: input.position, count: input.messages.length }), output: (receipt) => receipt }, () =>
            transcript.applyFixed(
              {
                contract: { key: 'transcript.append', version: 1 },
                operation: { ...activity.reception(), position: input.position },
                transcriptId: transcript.id,
                messages: input.messages,
              },
              { origin: activity.origin, observation: activity.transcriptObservation, progress },
            ),
          );
        },
        append(messages: readonly Message[]) {
          return activity.runSync('append', { input: () => ({ count: messages.length }), output: (result) => ({ transcriptId: transcript.id, indexes: result.map((item) => item.index), revision: transcript.revision }) }, () => {
            const start = transcript.length;
            transcript.appendFrom(messages, { origin: activity.origin, observation: activity.transcriptObservation, progress });
            return Object.freeze(messages.map((_, offset) => Object.freeze({ transcriptId: transcript.id, index: start + offset, message: transcript.get(start + offset)! })));
          });
        },
      });
    },
    timing: 'access',
    describe: (source) => ({ transcriptId: (source instanceof Transcript ? source : source.transcript).id }),
  }),
  segmentation: new ResourceOffer({
    name: 'transcript.segmentation',
    expose: (transcript: Transcript, activity) =>
      Object.freeze({
        current: () => activity.runSync('current', { output: (reader) => reader.locate() }, () => new TranscriptRangeReader(new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length), activity)),
        start: (index: number) => activity.runSync('start', { input: () => ({ start: index }), output: () => ({ transcriptId: transcript.id, start: transcript.activeStart, end: transcript.length, revision: transcript.revision }) }, () => transcript.startSegment(index, { origin: activity.origin, observation: activity.transcriptObservation })),
      }),
    timing: 'access',
    describe: (transcript) => ({ transcriptId: transcript.id }),
  }),
  fixedRange: new ResourceOffer<TranscriptRangeRef, TranscriptRangeReader, { range: TranscriptRangeRef; revision: number }>({
    name: 'transcript.fixedRange',
    expose: (captured: { range: TranscriptRangeRef; revision: number }, activity) => new TranscriptRangeReader(captured.range, activity, captured.revision),
    timing: 'binding',
    capture: (range) => ({ range, revision: range.transcript.revision }),
    describe: ({ range, revision }: { range: TranscriptRangeRef; revision: number }) => ({ transcriptId: range.transcript.id, start: range.start, end: range.end, revision }),
  }),
});
