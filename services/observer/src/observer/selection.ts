import { executionTranscript } from './evidence.js';
import { readOutput, type SelectionObservation } from '@capix-observer/protocol';

import type { Selection } from '../model/types.js';
import { type RecordBook, ExecutionRecord, OperationRecord, type Transcript } from '@capix-observer/runtime';

/** Recompute heat from accepted selection outcomes; never mutate messages or drive loading. */
export function observeSelection(book: RecordBook, transcript: Transcript): SelectionObservation {
  const messages = transcript.snapshot().map((_message, index) => ({ index, count: 0 }));
  const executions = new Map<string, SelectionObservation['executions'][number]>();
  for (const record of book.values()) {
    if (!(record instanceof ExecutionRecord)) continue;
    const range = executionTranscript(book, record.id);
    if (!range || range.transcriptId !== transcript.id) continue;
    executions.set(record.id, { id: record.id, startedAt: record.value.startedAt, status: record.status, inputIndex: range.end - 1, selections: [] });
  }
  for (const record of book.values()) {
    if (!(record instanceof OperationRecord) || record.operation !== 'selection') continue;
    const execution = executions.get(record.executionId);
    if (!execution) continue;
    // This concrete operation's succeeded output has already passed its output contract.
    const indexes = record.status === 'succeeded' ? [...(readOutput(record.value) as Selection).historyIndexes] : undefined;
    execution.selections.push({ operationId: record.id, status: record.status, ...(indexes ? { indexes } : {}) });
    for (const index of indexes ?? []) messages[index]!.count++;
  }
  return { transcriptId: transcript.id, messages, executions: [...executions.values()] };
}
