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
import { ModelInteractions } from '../conversation/model/interactions.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ConversationDecisionDefinition } from '../conversation/decision/types.js';
import type { ConversationContent } from './content.js';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = [], options: { files?: WorkspaceFiles; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number; persistence?: SqliteObserverStore; conversationId?: string; content?: ConversationContent; model?: ModelSource; shared?: boolean } = {}) {
  const persistence = options.persistence;
  const saved = persistence?.load(options.conversationId);
  if (saved && options.content && (options.content.transcript.id !== saved.transcript.id || options.content.memories.id !== saved.memories.id)) throw new Error('Content belongs to another conversation');
  if (saved && messages.length) throw new Error('Cannot append startup messages to restored content');
  // Restore and validate everything before a new recording installation can publish changes.
  const initialTranscript = persistence ? (saved ? Transcript.restore(saved.transcript) : new Transcript(messages)) : undefined;
  const initialMemories = initialTranscript ? (saved ? Memories.restore(saved.memories, initialTranscript) : new Memories(initialTranscript)) : undefined;
  const book = saved ? RecordBook.restore(saved.recording.book) : new RecordBook();
  if (persistence && !saved) persistence.initialize({ transcript: initialTranscript!.exportState(), memories: initialMemories!.exportState() });
  const recordingArchives = saved?.recording.archives ?? [];
  const clock = new Clock();
  const changes = options.content?.changes ?? new ChangeBuffer<ObserverChange>();
  const recorder = new Recorder(book, {
    clock,
    changes: persistence
      ? {
          capture(event) {
            persistence.applyRecordChange(event);
            changes.capture(event);
          },
        }
      : changes,
  });
  persistence?.openRecording(recorder.id, options.conversationId);
  const consumer = options.content?.consumer ?? new ChangeConsumer(changes);
  const recordSource = new RecordSource(recorder, consumer);
  try {
    const recording = bindRecording(recorder, {
      invalidate: (error) => {
        persistence?.invalidateRecording(recorder.id);
        recordSource.invalidate(error);
      },
    });
    const transcript = options.content?.transcript ?? (initialTranscript ? Transcript.restore(initialTranscript.exportState(), { observation: recording.transcript, changes, persistence: persistence?.transcript }) : new Transcript(messages, { observation: recording.transcript, changes }));
    const transcripts = options.content?.transcripts ?? new TranscriptFeed(transcript);
    if (!options.content)
      consumer.subscribe((change) => {
        if (change.type === 'transcript') transcripts.publish(change);
      });
    const memories = options.content?.memories ?? (initialMemories ? Memories.restore(initialMemories.exportState(), transcript, { observation: recording.memory, changes, persistence: persistence?.memories }) : new Memories(transcript, { observation: recording.memory, changes }));
    const selectionUsage = new SelectionUsage();
    const definition = new ConversationRuntimeDefinition({ files: Boolean(options.files), decision: options.decision, maxDecisionSteps: options.maxDecisionSteps });
    const model = options.model ?? new ModelSource(provider);
    const interactions = new ModelInteractions(model, { persistence: persistence?.interactions });
    const runtime = bindConversation(definition, { transcript, memories, selectionUsage, files: options.files }, interactions, { observations: [recording], changes });
    options.content?.observe(recording);
    let closed = false;
    function close(): void {
      if (closed) return;
      if (runtime.running) throw new Error('Cannot close an environment with an active invocation');
      if (interactions.active) throw new Error('Cannot close an environment with active external interactions');
      interactions.close();
      closed = true;
      try {
        persistence?.sealRecording(recorder.id, recorder.revision);
      } finally {
        transcripts.close();
        consumer.close();
        if (!options.shared) persistence?.close();
      }
    }
    return { transcript, memories, selectionUsage, files: options.files, model, interactions, book, clock, recorder, recording, runtime, changes, definition, consumer, recordSource, transcripts, recordingArchives, persistence, close };
  } catch (error) {
    recordSource.invalidate(error);
    if (!options.content) consumer.close();
    persistence?.invalidateRecording(recorder.id);
    throw error;
  }
}
