import type { ModelInitialization } from '../provider.js';
import { Clock, RecordBook, Recorder, bindRecording, ChangeObserver, Transcript, Memories, SelectionUsage } from '@capix-observer/runtime';
import type { Message, RuntimeChange } from '@capix-observer/protocol';
import { ObserverRuntimeDefinition } from './definition.js';
import { bindObserver } from './binding.js';
import { ChangeConsumer } from './changes.js';
import { RecordSource } from './record-source.js';
import { TranscriptFeed } from './transcript/feed.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = []) {
  const book = new RecordBook();
  const clock = new Clock();
  const changes = new ChangeObserver<RuntimeChange>();
  const recorder = new Recorder(book, { clock, changes });
  const consumer = new ChangeConsumer(changes);
  const recordSource = new RecordSource(recorder, consumer);
  const recording = bindRecording(recorder, { invalidate: (error) => recordSource.invalidate(error) });
  const transcript = new Transcript(messages, { observation: recording.transcript, changes });
  const transcripts = new TranscriptFeed(transcript);
  consumer.subscribe((change) => {
    if (change.type === 'transcript') transcripts.publish(change);
  });
  const memories = new Memories(transcript, { observation: recording.memory, changes });
  const selectionUsage = new SelectionUsage();
  const definition = new ObserverRuntimeDefinition();
  const runtime = bindObserver(definition, { transcript, memories, selectionUsage }, provider, { observations: [recording], changes });
  return { transcript, memories, selectionUsage, book, clock, recorder, recording, runtime, changes, definition, consumer, recordSource, transcripts };
}
