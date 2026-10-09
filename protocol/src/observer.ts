import type { ExecutionRecord } from './records.js';
import type { ExecutionObservation } from './observation/execution.js';
import type { MemoryRecord } from './records/memory.js';
import type { TranscriptRangeLocator } from './transcript.js';

export interface SourceResponse {
  path: string;
  content: string;
}
export type { ObservationUpdate } from './observation/stream.js';

/** Timing facts only. No IO bodies, pixel layout, colors or UI selection state. */
export interface InvocationSummary {
  id: string;
  contextId: string;
  recordType: 'execution' | 'operation' | 'attempt';
  parentId?: string;
  name: string;
  label: string;
  source: string;
  status: ExecutionRecord['status'];
  offsetMs: number;
  durationMs?: number;
}
type ObservedExecution = ExecutionObservation['executions'][number];
export interface ExecutionSummary extends ObservedExecution {
  durationMs?: number;
  /** Last recorded monotonic offset; includes incomplete runs without inventing an end. */
  observedOffsetMs: number;
  calls: InvocationSummary[];
  transcriptRange?: TranscriptRangeLocator;
  /** IDs present in this run's captured selection input. Not a claim of causal model use. */
  availableMemoryIds: string[];
  memoryChanges: { id: string; memoryId: string; operationId?: string; action: MemoryRecord['value']['action']; change: string }[];
}
export interface ObserverOverview {
  transcriptId: string;
  messages: ExecutionObservation['messages'];
  executions: ExecutionSummary[];
}
