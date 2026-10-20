import type { RecordingArchive, RecordingArchiveOrigin } from './archive.js';
import type { CallableKind } from '../invocation/types.js';
import type { ExecutionRecord } from '../recording/types.js';
import type { ExecutionObservation } from './execution.js';
import type { MemoryRecord } from '../recording/memory.js';
import type { TranscriptRangeLocator } from '../content/transcript.js';

export interface SourceResponse {
  path: string;
  content: string;
}
export type { ObservationUpdate } from './stream.js';

/** Timing facts only. No IO bodies, pixel layout, colors or UI selection state. */
export interface InvocationSummary {
  id: string;
  contextId: string;
  recordType: CallableKind;
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
  readonly archive?: RecordingArchiveOrigin;
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
  readonly archives?: readonly RecordingArchive[];
  transcriptId: string;
  messages: ExecutionObservation['messages'];
  executions: ExecutionSummary[];
}
