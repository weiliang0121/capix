import type { ExecutionRecord, OperationRecord } from '../records.js';
import type { Message } from '../transcript/message.js';

/** Read-only projection of current messages and recorded selection calls. Not stored. */
export interface SelectionObservation {
  messages: { index: number; message: Readonly<Message>; count: number }[];
  executions: {
    id: string;
    startedAt: string;
    status: ExecutionRecord['status'];
    inputIndex: number;
    selections: { operationId: string; status: OperationRecord['status']; indexes?: readonly number[] }[];
  }[];
}
