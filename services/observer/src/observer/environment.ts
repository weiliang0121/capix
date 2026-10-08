import { Clock, RecordBook, Recorder, createRuntime, ChangeObserver } from '@capix-observer/runtime';
import type { Message, RuntimeChange } from '@capix-observer/protocol';

import { ObserverRuntimeDefinition, type ModelInitialization } from './definition.js';
import { ObserverBinding } from './binding.js';

/** Establish a Runtime scope and assemble its Observer behavior; no execution is started. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const changes = new ChangeObserver<RuntimeChange>();
  const recorder = new Recorder(book, { clock, changes });
  const runtime = createRuntime({ recorder, messages, changes });
  const recording = runtime.recording!;
  const definition = new ObserverRuntimeDefinition(provider);
  const execution = new ObserverBinding(runtime, definition);
  return { transcript: runtime.context.transcript, book, clock, recorder, recording, runtime, execution, changes, definition };
}
