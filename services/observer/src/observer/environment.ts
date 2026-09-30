import { Clock, RecordBook, Recorder, createRuntime, ChangeObserver } from '@capix-observer/runtime';
import type { Message, RuntimeChange } from '@capix-observer/protocol';
import type { ModelProvider } from '../provider.js';

import { ObserverExecution } from './execution.js';

/** Establish a Runtime scope and assemble its Observer behavior; no execution is started. */
export function initializeObserver(provider: ModelProvider, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const changes = new ChangeObserver<RuntimeChange>();
  const recorder = new Recorder(book, { clock, changes });
  const runtime = createRuntime({ recorder, messages, changes });
  const recording = runtime.recording!;
  const execution = new ObserverExecution(runtime, provider);
  return { transcript: runtime.context.transcript, book, clock, recorder, recording, runtime, execution, changes };
}
