import type { ModelInitialization } from '../conversation/model/types.js';
import { Clock, Runner, Resources, MemoryCheckpointStore, RuntimeError, type CheckpointInstallation } from '@capix/server-runtime';
import { RecordBook, Recorder, bindRecording } from '@capix/server-runtime/recording';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { Message, RecordingArchive } from '@capix/protocol';
import { createConversationStructure } from '../conversation/scene.js';
import { registerConversationResources, type ConversationRunOptions } from '../conversation/binding.js';
import { MemoryConversationCheckpointRuns } from '../conversation/checkpoints.js';
import { RecordSource } from '../observation/record/source.js';
import { CheckpointObservation, bindCheckpointObservation } from '../observation/checkpoints.js';
import { ModelSource } from '../conversation/model/source.js';
import { ModelInteractions } from '../conversation/model/interactions.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ContextMaintenanceConfiguration } from '../conversation/group/context/maintain.js';
import type { ConversationDecisionFactory } from '../conversation/decision/types.js';
import { ConversationContent } from './content.js';
import { ObserverEnvironment } from './environment.js';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export interface ObserverInitializationOptions {
  readonly files?: WorkspaceFiles;
  readonly decision?: ConversationDecisionFactory;
  readonly maxDecisionSteps?: number;
  readonly maintenance?: ContextMaintenanceConfiguration;
  readonly persistence?: SqliteObserverStore;
  readonly checkpointObservation?: CheckpointInstallation['observation'];
  readonly conversationId?: string;
  readonly content?: ConversationContent;
  readonly model?: ModelSource;
  /** The caller retains ownership of the persistence connection. */
  readonly shared?: boolean;
}

export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = [], options: ObserverInitializationOptions = {}): ObserverEnvironment {
  const persistence = options.persistence;
  let content = options.content;
  if (content?.closed) throw new RuntimeError('SERVICE_CLOSED', '对话内容同步已关闭。');
  if (!content) {
    let saved = persistence?.loadContent(options.conversationId);
    if (saved && messages.length) throw new Error('Cannot append startup messages to restored content');
    if (persistence && !saved) {
      const transcript = new Transcript(messages);
      const memories = new Memories(transcript);
      saved = { version: 1, transcript: transcript.exportState(), memories: memories.exportState() };
      persistence.initialize(saved);
    }
    content = new ConversationContent({ saved, messages: persistence ? messages : [], persistence });
  } else if (persistence) {
    const identity = options.conversationId ? persistence.contentIdentity(options.conversationId) : undefined;
    if (!identity || identity.transcriptId !== content.transcript.id || identity.memoriesId !== content.memories.id || content.memories.transcript !== content.transcript) throw new Error('Content belongs to another conversation');
  }
  let book = new RecordBook();
  let recordingArchives: readonly RecordingArchive[] = [];
  let recordingFailure: unknown;
  try {
    const saved = persistence?.loadRecording(options.conversationId);
    if (saved) {
      book = RecordBook.restore(saved.book);
      recordingArchives = saved.archives;
    }
  } catch (error) {
    if (persistence?.failure) {
      if (!options.content) {
        try {
          content.close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Observer initialization and cleanup failed');
        }
      }
      throw error;
    }
    recordingFailure = error;
  }
  const clock = new Clock();
  const changes = content.changes;
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
  const consumer = content.consumer;
  const recordSource = new RecordSource(recorder, consumer);
  if (recordingFailure) recordSource.invalidate(recordingFailure);
  let recordingOpened = false;
  let interactions: ModelInteractions | undefined;
  let checkpointObservation: CheckpointObservation | undefined;
  let releaseObservation: (() => void) | undefined;
  try {
    persistence?.openRecording(recorder.id, options.conversationId);
    recordingOpened = true;
    const recording = bindRecording(recorder, {
      invalidate: (error) => {
        persistence?.invalidateRecording(recorder.id);
        recordSource.invalidate(error);
      },
    });
    const { transcript, memories, active } = content;
    const selectionUsage = new SelectionUsage();
    const structure = createConversationStructure({ files: Boolean(options.files), decision: options.decision, maxDecisionSteps: options.maxDecisionSteps, maintenance: options.maintenance });
    const model = options.model ?? new ModelSource(provider);
    interactions = new ModelInteractions(model, { persistence: persistence?.interactions });
    const checkpoints = persistence?.checkpoints ?? new MemoryCheckpointStore();
    const checkpointRuns = persistence?.checkpointRuns ?? new MemoryConversationCheckpointRuns();
    const conversationId = options.conversationId ?? persistence?.conversationForTranscript(transcript.id)?.id ?? transcript.id;
    const observation = new CheckpointObservation(conversationId, checkpointRuns);
    checkpointObservation = observation;
    const resources = new Resources<ConversationRunOptions>();
    const calls = registerConversationResources(resources, structure, { transcript, memories, active, selectionUsage, files: options.files }, interactions, { checkpointRuns, conversationId, checkpoints });
    const runner = new Runner(structure.scene, resources, undefined, { ...calls, clock, observations: [recording], changes, checkpoints: { store: checkpoints, observation: bindCheckpointObservation(observation, options.checkpointObservation) } }).build();
    releaseObservation = content.observe(recording);
    // Fresh in-memory input is a real append after observation binds; restored content stays silent.
    if (!options.content && !persistence) transcript.append(...messages);
    return new ObserverEnvironment({ conversationId, content, selectionUsage, files: options.files, model, interactions, book, clock, recorder, recording, resources, runner, structure, recordSource, recordingArchives, persistence, checkpoints, checkpointRuns, checkpointObservation: observation }, { ownsContent: !options.content, ownsPersistence: !options.shared, releaseObservation });
  } catch (error) {
    const failures: unknown[] = [error];
    const releases = [
      () => releaseObservation?.(),
      () => recordSource.invalidate(error),
      () => interactions?.close(),
      () => checkpointObservation?.close(),
      () => {
        if (!options.content) content.close();
      },
      () => {
        if (recordingOpened) persistence?.invalidateRecording(recorder.id);
      },
    ];
    for (const release of releases) {
      try {
        release();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Observer initialization and cleanup failed');
    throw error;
  }
}
