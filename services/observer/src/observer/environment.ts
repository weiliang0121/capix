import { Clock, RecordBook, RuntimeRecorder, Runtime } from '@capix-observer/runtime';
import type { Message } from '@capix-observer/protocol';
import type { ModelProvider } from '../provider.js';

import { ObserverExecution } from './execution.js';

/** Assemble the existing world. This does not accept a call or create a Context. */
export function initializeObserver(provider: ModelProvider, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const recorder = new RuntimeRecorder(book, clock);
  const runtime = new Runtime({ recorder, messages });
  const recording = runtime.recording!;
  const execution = new ObserverExecution(runtime, provider);
  return { transcript: runtime.transcript, book, clock, recorder, recording, runtime, execution };
}
