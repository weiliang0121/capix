import type { ModelInitialization } from '../conversation/model/types.js';
import { Clock, Runner, Resources, MemoryCheckpointStore, type CheckpointInstallation, type ObservationInstallation } from '@capix/server-runtime';
import { MessageUsage } from '@capix/measurement';
import type { Message } from '@capix/protocol';
import { createConversationStructure } from '../conversation/structure.js';
import { registerConversationRecording } from '../conversation/recording.js';
import { registerConversationResources } from '../conversation/binding.js';
import type { ConversationRunOptions } from '../conversation/binding/contract.js';
import { ConversationCallCapture } from '../conversation/binding/capture.js';
import { conversationCallHooks } from '../conversation/binding/calls.js';
import { MemoryConversationCheckpointRuns } from '../conversation/checkpoints.js';
import { ObserverRecording } from '../observation/record/installation.js';
import { CheckpointObservation, bindCheckpointObservation } from '../observation/checkpoints.js';
import { ModelSource } from '../conversation/model/source.js';
import { ModelInteractions } from '../conversation/model/interactions.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ContextMaintenanceConfiguration } from '../conversation/group/context/maintain.js';
import type { ConversationDecisionFactory } from '../conversation/decision/types.js';
import { ConversationContent } from '@capix/observer-content';
import { loadConversationContent } from './content.js';
import { ObserverEnvironment } from './environment.js';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Host-owned entities and optional service policies; the scene does not own their lifetimes. */
export interface ObserverInitializationOptions {
  readonly files?: WorkspaceFiles;
  readonly decision?: ConversationDecisionFactory;
  readonly maxDecisionSteps?: number;
  readonly maintenance?: ContextMaintenanceConfiguration;
  readonly persistence?: SqliteObserverStore;
  readonly observations?: readonly ObservationInstallation[];
  readonly checkpointObservation?: CheckpointInstallation['observation'];
  readonly conversationId?: string;
  readonly content?: ConversationContent;
  readonly model?: ModelSource;
  /** The caller retains ownership of the persistence connection. */
  readonly shared?: boolean;
}

export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = [], options: ObserverInitializationOptions = {}): ObserverEnvironment {
  const persistence = options.persistence;
  const content = loadConversationContent(messages, options);
  const clock = new Clock();
  const changes = content.changes;
  let records: ObserverRecording | undefined;
  let interactions: ModelInteractions | undefined;
  let checkpointObservation: CheckpointObservation | undefined;
  let releaseObservation: (() => void) | undefined;
  try {
    records = new ObserverRecording(changes, content.consumer, { clock, persistence, conversationId: options.conversationId });
    const { transcript, memories, active } = content;
    const messageUsage = new MessageUsage();
    const structure = createConversationStructure({ files: Boolean(options.files), decision: options.decision, maxDecisionSteps: options.maxDecisionSteps, maintenance: options.maintenance });
    registerConversationRecording(records.installation, structure);
    const model = options.model ?? new ModelSource(provider);
    interactions = new ModelInteractions(model, { persistence: persistence?.interactions });
    const checkpoints = persistence?.checkpoints ?? new MemoryCheckpointStore();
    const checkpointRuns = persistence?.checkpointRuns ?? new MemoryConversationCheckpointRuns();
    const conversationId = options.conversationId ?? persistence?.conversationForTranscript(transcript.id)?.id ?? transcript.id;
    const observation = new CheckpointObservation(conversationId, checkpointRuns);
    checkpointObservation = observation;
    const resources = new Resources<ConversationRunOptions>();
    const entities = { transcript, memories, active, messageUsage, files: options.files };
    const capture = new ConversationCallCapture(structure.scene, entities, { checkpointRuns, conversationId, checkpoints });
    registerConversationResources(resources, structure, entities, interactions, capture);
    const runner = new Runner(structure.scene, resources, undefined, {
      validate: (options) => capture.validate(options),
      hooks: conversationCallHooks(structure, capture),
      clock,
      observations: [records.installation, ...(options.observations ?? [])],
      changes,
      checkpoints: { store: checkpoints, observation: bindCheckpointObservation(observation, options.checkpointObservation) },
    }).build();
    releaseObservation = content.observe(records.installation);
    // Fresh in-memory input is a real append after observation binds; restored content stays silent.
    if (!options.content && !persistence) transcript.append(...messages);
    return new ObserverEnvironment({ conversationId, content, messageUsage, files: options.files, model, interactions, clock, records, resources, runner, structure, persistence, checkpoints, checkpointRuns, checkpointObservation: observation }, { ownsContent: !options.content, ownsPersistence: !options.shared, releaseObservation });
  } catch (error) {
    const failures: unknown[] = [error];
    const releases = [
      () => releaseObservation?.(),
      () => records?.abort(error),
      () => interactions?.close(),
      () => checkpointObservation?.close(),
      () => {
        if (!options.content) content.close();
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
