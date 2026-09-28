import { Clock, RecordBook, RecordIndex, type OperationRecord, type AttemptRecord, type EventRecord, RuntimeRecorder, Runtime } from '@capix-observer/runtime';
import type { Message } from '@capix-observer/protocol';
import type { ModelProvider } from '../provider.js';

import { ObserverExecution } from './execution.js';

/** Assemble the existing world. This does not accept a call or create a Context. */
export function initializeObserver(provider: ModelProvider, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const operationIndex = new RecordIndex<OperationRecord>((record) => record.executionId);
  const attemptIndex = new RecordIndex<AttemptRecord>((record) => record.operationId);
  const eventIndex = new RecordIndex<EventRecord>((record) => record.executionId);
  const clock = new Clock();
  const recorder = new RuntimeRecorder(book, operationIndex, attemptIndex, eventIndex, clock);
  const runtime = new Runtime({ recorder, messages });
  const execution = new ObserverExecution(runtime, provider);
  return { transcript: runtime.transcript, book, operationIndex, attemptIndex, eventIndex, clock, recorder, runtime, execution };
}
