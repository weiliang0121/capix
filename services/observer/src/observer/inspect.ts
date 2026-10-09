import type { ExecutionObservation } from '@capix-observer/protocol';
import { type RecordBook, type Transcript, OperationRecord, TranscriptRecord } from '@capix-observer/runtime';
import { observeSelection } from './selection.js';

/** Associate answers by the actual E-owned append, including post-answer extraction failures. */
export function inspectExecutions(book: RecordBook, transcript: Transcript): ExecutionObservation {
  const selection = observeSelection(book, transcript);
  const executions: ExecutionObservation['executions'] = selection.executions.map((execution) => ({ ...execution }));
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  for (const record of book.values()) {
    if (record instanceof OperationRecord && record.operation === 'memory') {
      const execution = byId.get(record.executionId);
      if (execution) execution.memoryStatus = record.status;
    }
    if (!(record instanceof TranscriptRecord) || record.transcriptId !== transcript.id || record.value.action !== 'append') continue;
    const execution = byId.get(record.parentId ?? '');
    if (!execution) continue;
    for (let index = record.value.start; index < record.value.end; index++) {
      if (transcript.get(index)?.role === 'assistant') execution.response = { index };
    }
  }
  return { transcriptId: transcript.id, messages: selection.messages, executions };
}
