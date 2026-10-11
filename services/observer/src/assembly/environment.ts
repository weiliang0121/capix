import type { ModelInitialization } from '../conversation/model/types.js';
import { Clock, ChangeBuffer } from '@capix/server-runtime';
import { RecordBook, Recorder, bindRecording } from '@capix/server-runtime/recording';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { Message, ObserverChange } from '@capix/protocol';
import { ConversationRuntimeDefinition } from '../conversation/definition.js';
import { bindConversation } from '../conversation/binding.js';
import { ChangeConsumer } from './changes.js';
import { RecordSource } from '../observation/record/source.js';
import { TranscriptFeed } from '../conversation/transcript/feed.js';
import { ModelSource } from '../conversation/model/source.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ConversationDecisionDefinition } from '../conversation/decision/types.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = [], options: { files?: WorkspaceFiles; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number } = {}) {
  const book = new RecordBook();
  const clock = new Clock();
  const changes = new ChangeBuffer<ObserverChange>();
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
  const definition = new ConversationRuntimeDefinition({ files: Boolean(options.files), decision: options.decision, maxDecisionSteps: options.maxDecisionSteps });
  const model = new ModelSource(provider);
  const runtime = bindConversation(definition, { transcript, memories, selectionUsage, files: options.files }, model, { observations: [recording], changes });
  return { transcript, memories, selectionUsage, files: options.files, model, book, clock, recorder, recording, runtime, changes, definition, consumer, recordSource, transcripts };
}
