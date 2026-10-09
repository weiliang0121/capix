import type { ModelInitialization } from '../provider.js';
import { Clock, RecordBook, Recorder, ChangeObserver, Transcript, Memories, SelectionUsage } from '@capix-observer/runtime';
import type { Message, RuntimeChange } from '@capix-observer/protocol';
import { ObserverRuntimeDefinition } from './definition.js';
import { bindObserver } from './binding.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const changes = new ChangeObserver<RuntimeChange>();
  const recorder = new Recorder(book, { clock, changes });
  const transcript = new Transcript(messages, { recorder, changes });
  const memories = new Memories(transcript, { recorder, changes });
  const selectionUsage = new SelectionUsage();
  const definition = new ObserverRuntimeDefinition();
  const runtime = bindObserver(definition, { transcript, memories, selectionUsage }, provider, { recorder, changes });
  const recording = runtime.recording!;
  return { transcript, memories, selectionUsage, book, clock, recorder, recording, runtime, changes, definition };
}
