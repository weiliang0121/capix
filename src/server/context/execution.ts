import type { ModelSettings } from '../../shared/types.js';
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
  readonly transcript?: Transcript;

  constructor(input: I, options: ExecutionOptions) {
    super(input);
    // ModelSettings has scalar fields. One independent configuration is used for the whole execution.
    this.settings = Object.freeze({ ...options.settings });
    this.signal = options.signal ?? new AbortController().signal;
    this.transcript = options.transcript;
    Object.freeze(this);
  }
}
