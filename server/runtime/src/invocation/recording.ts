import type { InvocationProcess } from './cycle.js';

/** Per-call recording specialization, composed by the corresponding record helper. */
export interface InvocationRecording<C> {
  begin(context: C): void;
  process(context: C, process: InvocationProcess): void;
  finish(context: C): void;
}
