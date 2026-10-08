import type { ExecutionContextBuilder } from './execution/builder.js';
import type { ModelSettings } from '@capix-observer/protocol';
import { TranscriptRangeRef } from '../transcript/ref.js';
import type { Transcript } from '../transcript/transcript.js';
import { InvocationContext } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';

export interface ExecutionOptions {
  settings: ModelSettings;
  signal?: AbortSignal;
  transcript?: Transcript;
}

/** Construction and recording metadata, never the work's resource interface. */
export interface ExecutionResourceSource {
  readonly settings: Readonly<ModelSettings>;
  readonly transcriptRange?: TranscriptRangeRef;
}
const sources = new WeakMap<ExecutionContext, ExecutionResourceSource>();
/** Internal recording access; not exported from the runtime package. */
export function executionSource(context: ExecutionContext): ExecutionResourceSource {
  return sources.get(context)!;
}

export class ExecutionContext<I = unknown, O = unknown, R extends object = object> extends InvocationContext<I, O> {
  readonly signal: AbortSignal;
  readonly resources: ResourceBindings<R>;
  readonly #owner?: ExecutionContextBuilder;

  constructor(input: I, options: ExecutionOptions, owner?: ExecutionContextBuilder, bind?: (source: ExecutionResourceSource) => ResourceBindings<R>) {
    super(input);
    this.#owner = owner;
    this.signal = options.signal ?? new AbortController().signal;
    const source = Object.freeze({ settings: Object.freeze({ ...options.settings }), ...(options.transcript ? { transcriptRange: new TranscriptRangeRef(options.transcript, options.transcript.activeStart, options.transcript.length) } : {}) });
    sources.set(this, source);
    this.resources = bind ? bind(source) : new ResourceBindings({} as ResourceRequirements<R>);
    Object.freeze(this);
  }

  belongsTo(builder: ExecutionContextBuilder): boolean {
    return !this.#owner || this.#owner === builder;
  }

  requireActive(): void {
    this.requireRunning();
  }
}
