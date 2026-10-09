import type { InvocationProcess } from './cycle.js';
import type { CallRecord } from '../records/invocation/record.js';
import type { ChangeSource } from '../records/source.js';

/** Per-call specialization. Invocation owns the record bound at the start boundary. */
export interface InvocationRecording<C> {
  begin(context: C, bind: (record: CallRecord) => void): void;
  process(context: C, record: CallRecord, process: InvocationProcess, sequence: number): void;
  finish(context: C, record: CallRecord): void;
  source(record: CallRecord): ChangeSource;
}

/** Optional, record-only descriptions. They never replace values used by work. */
export interface InvocationObservation<I = unknown, O = unknown> {
  input?(input: I): unknown;
  output?(output: O): unknown;
}
