import type { ObserverOverview } from '../observer.js';
import type { MemoryObservation } from './memory.js';
import type { RecordEntry, RuntimeChange, InvocationEvent } from '../changes.js';

/** Baseline is lightweight for completed executions; only active record bodies are preloaded. */
export interface ObservationBaseline {
  readonly type: 'baseline';
  readonly scopeId: string;
  readonly sequence: number;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly transcript: { readonly id: string; readonly revision: number; readonly starts: readonly number[] };
  readonly memories: { readonly id: string; readonly sequence: number };
  readonly recorder: { readonly id: string; readonly revision: number };
  readonly entries: readonly RecordEntry[];
  readonly invocations: readonly InvocationEvent[];
}
export interface ObservationDelta {
  readonly type: 'delta';
  readonly scopeId: string;
  readonly sequence: number;
  readonly changes: readonly RuntimeChange[];
}
export type ObservationFrame = ObservationBaseline | ObservationDelta;
export type ObservationUpdate = ObservationFrame | { type: 'error'; error: string; code?: string };
