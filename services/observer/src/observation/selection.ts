import { executionTranscript } from './evidence.js';
import { readOutput, type SelectionObservation } from '@capix/protocol';

import type { Selection } from '../conversation/model/types.js';
import { type RecordBook } from '@capix/server-runtime/recording';
import { type Transcript } from '@capix/transcript';

import { isTaskRecord, callRecord, taskRecord } from './calls.js';

/** Count fixed active-material references; legacy selection records remain readable. */
export function observeSelection(book: RecordBook, transcript: Transcript): SelectionObservation {
  const messages = transcript.snapshot().map((_message, index) => ({ index, count: 0 }));
  const executions = new Map<string, SelectionObservation['executions'][number]>();
  for (const record of book.values()) {
    if (!isTaskRecord(record)) continue;
    const range = executionTranscript(book, record.id);
    if (!range || range.transcriptId !== transcript.id) continue;
    const startedAt = record.value.startedAt;
    if (startedAt === undefined) throw new Error('Conversation task has no recorded start');
    executions.set(record.id, { id: record.id, startedAt, status: record.status, inputIndex: range.end - 1, selections: [] });
  }
  for (const record of book.values()) {
    const call = callRecord(record);
    if (!call || (call.name !== 'selection' && call.name !== 'prepareContext')) continue;
    const execution = executions.get(taskRecord(book, record.id)?.id ?? '');
    if (!execution) continue;
    // This concrete operation's succeeded output has already passed its output contract.
    const output = call.status === 'succeeded' ? readOutput(call.value) : undefined;
    const selected = call.name === 'prepareContext' ? (output as { readonly selection: Selection } | undefined)?.selection : (output as Selection | undefined);
    const indexes = selected ? [...selected.historyIndexes] : undefined;
    execution.selections.push({ operationId: record.id, status: call.status, ...(indexes ? { indexes } : {}) });
    for (const index of indexes ?? []) messages[index]!.count++;
  }
  return { transcriptId: transcript.id, messages, executions: [...executions.values()] };
}
