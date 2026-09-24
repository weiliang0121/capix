import type { SelectionObservation } from '../../shared/observation/selection.js';
import type { Selection } from '../../shared/types.js';
import type { RecordBook } from '../records/container/book.js';
import { ExecutionRecord } from '../records/execution/record.js';
import { OperationRecord } from '../records/operation/record.js';
import { TranscriptRangeRef } from '../transcript/ref.js';
import type { Transcript } from '../transcript/transcript.js';

/** Recompute heat from accepted selection outcomes; never mutate messages or drive loading. */
export function observeSelection(book: RecordBook, transcript: Transcript, selectionInstanceId: string): SelectionObservation {
  const messages = transcript.snapshot().map((message, index) => ({ index, message, count: 0 }));
  const executions = new Map<string, SelectionObservation['executions'][number]>();
  for (const record of book.values()) {
    if (!(record instanceof ExecutionRecord)) continue;
    const range = record.value.transcriptRange;
    if (!(range instanceof TranscriptRangeRef) || range.transcript !== transcript) continue;
    executions.set(record.id, { id: record.id, startedAt: record.value.startedAt, status: record.status, inputIndex: range.end - 1, selections: [] });
  }
  for (const record of book.values()) {
    if (!(record instanceof OperationRecord) || record.operationInstanceId !== selectionInstanceId) continue;
    const execution = executions.get(record.executionId);
    if (!execution) continue;
    // This concrete operation's succeeded output has already passed its output contract.
    const indexes = record.status === 'succeeded' ? [...(record.value.output as Selection).historyIndexes] : undefined;
    execution.selections.push({ operationId: record.id, status: record.status, ...(indexes ? { indexes } : {}) });
    for (const index of indexes ?? []) messages[index]!.count++;
  }
  return { messages, executions: [...executions.values()] };
}
