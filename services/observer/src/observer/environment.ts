import { Clock, RecordBook, Recorder, createRuntime } from '@capix-observer/runtime';
import type { Message } from '@capix-observer/protocol';
import type { ModelProvider } from '../provider.js';

import { ObserverExecution } from './execution.js';

/** Establish a Runtime scope and assemble its Observer behavior; no execution is started. */
export function initializeObserver(provider: ModelProvider, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const recorder = new Recorder(book, clock);
  const runtime = createRuntime({ recorder, messages });
  const recording = runtime.recording!;
  const execution = new ObserverExecution(runtime, provider);
  return { transcript: runtime.context.transcript, book, clock, recorder, recording, runtime, execution };
}
