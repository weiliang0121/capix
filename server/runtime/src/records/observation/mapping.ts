import type { MemoryEvent, TranscriptEvent, RecordedInvocationResult } from '@weiliang0121/capix-protocol';
import { RuntimeErrorHelper, failureFact, type InvocationResult } from '@weiliang0121/capix-invocation';
import { MemoryRecord, TranscriptRecord, type RecordChangeSource } from '@weiliang0121/capix-records';
import type { InvocationRecordDescription } from './declaration.js';

export function recordedResult(result: InvocationResult<unknown>, description?: InvocationRecordDescription): RecordedInvocationResult {
  if (result.status === 'succeeded') return { status: 'succeeded', output: description?.output ? description.output(result.output) : result.output };
  return { status: 'failed', error: RuntimeErrorHelper.format(result.error), ...(result.failure ? { failure: failureFact(result.failure) } : {}) };
}
export function transcriptRecord(event: TranscriptEvent, source?: RecordChangeSource): TranscriptRecord {
  const change = event.change;
  return new TranscriptRecord({ transcriptId: event.transcriptId, revision: event.revision, occurredAt: event.occurredAt, ...(source ? { source } : {}) }, change.kind === 'messages-appended' ? { action: 'append', start: change.start, end: change.start + change.messages.length } : { action: 'segment', previousStart: change.previousStart, start: change.start, end: change.end });
}
export function memoryRecord(event: MemoryEvent, source?: RecordChangeSource): MemoryRecord {
  return new MemoryRecord({ memoriesId: event.memoriesId, memoryId: event.change.memoryId, sequence: event.sequence, ...(source ? { source } : {}) }, { action: event.change.action, change: event.change.explanation, sourceIndexes: event.change.sourceIndexes, ...(event.change.sourceResults ? { sourceResults: event.change.sourceResults } : {}), result: event.change.result });
}
