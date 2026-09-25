import type { ModelSettings } from '@capix-observer/protocol';
import { TranscriptRangeRef } from '../transcript/ref.js';
import type { Transcript } from '../transcript/transcript.js';
import { RuntimeContext } from './context.js';

export interface ExecutionOptions {
  settings: ModelSettings;
  signal?: AbortSignal;
  transcript?: Transcript;
}

export class ExecutionContext<I = unknown, O = unknown> extends RuntimeContext<I, O> {
  readonly settings: Readonly<ModelSettings>;
  readonly signal: AbortSignal;
  readonly transcriptRange?: TranscriptRangeRef;

  constructor(input: I, options: ExecutionOptions) {
    super(input);
    // ModelSettings has scalar fields. One independent configuration is used for the whole execution.
    this.settings = Object.freeze({ ...options.settings });
    this.signal = options.signal ?? new AbortController().signal;
    this.transcriptRange = options.transcript ? new TranscriptRangeRef(options.transcript, options.transcript.activeStart, options.transcript.length) : undefined;
    Object.freeze(this);
  }
}
