import type { ExecutionRecord, OperationRecord } from '../records.js';

/** Read-only projection of current messages and recorded selection calls. Not stored. */
export interface SelectionObservation {
  transcriptId: string;
  messages: { index: number; count: number }[];
  executions: {
    id: string;
    startedAt: string;
    status: ExecutionRecord['status'];
    inputIndex: number;
    selections: { operationId: string; status: OperationRecord['status']; indexes?: readonly number[] }[];
  }[];
}
