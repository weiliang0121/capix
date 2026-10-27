import { RuntimeError } from '@capix/contracts';
import { type Resources } from '@capix/server-runtime';
import { type Clock, type InvocationControls } from '@capix/invocation';
import { type CheckpointStore } from '@capix/checkpoint';
import { type ChangeBuffer } from '@capix/changes';
import type { Transcript } from '@capix/transcript';
import type { Memories } from '@capix/memory';
import type { MessageUsage } from '@capix/measurement';
import type { ObserverChange } from '@capix/protocol';
import type { ConversationScene } from '../conversation/scene.js';
import type { ConversationStructure } from '../conversation/structure.js';
import type { ConversationRunner, ConversationRunOptions } from '../conversation/binding/contract.js';
import type { ConversationCheckpointRuns } from '../conversation/checkpoints.js';
import { conversationCheckpointConfiguration, validateConversationCheckpointRestoration } from '../conversation/binding/checkpoint.js';
import type { ModelSource } from '../conversation/model/source.js';
import type { ModelInteractions } from '../conversation/model/interactions.js';
import type { TranscriptFeed } from '@capix/observer-content';
import type { ObserverRecording } from '../observation/record/installation.js';
import type { CheckpointObservation } from '../observation/checkpoints.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { SqliteObserverStore } from '../persistence/store.js';
import type { ChangeConsumer } from '@capix/observer-content';
import type { ConversationContent } from '@capix/observer-content';

export interface ObserverEnvironmentParts {
  readonly conversationId: string;
  readonly content: ConversationContent;
  readonly messageUsage: MessageUsage;
  readonly files?: WorkspaceFiles;
  readonly model: ModelSource;
  readonly interactions: ModelInteractions;
  readonly clock: Clock;
  readonly records: ObserverRecording;
  readonly resources: Resources<ConversationRunOptions>;
  readonly runner: ConversationRunner;
  readonly structure: ConversationStructure;
  readonly persistence?: SqliteObserverStore;
  readonly checkpoints: CheckpointStore;
  readonly checkpointRuns: ConversationCheckpointRuns;
  readonly checkpointObservation: CheckpointObservation;
}

/** A single installed environment; construction and the lifetime of borrowed entities stay outside it. */
export class ObserverEnvironment {
  readonly conversationId: string;
  readonly content: ConversationContent;
  readonly transcript: Transcript;
  readonly memories: Memories;
  readonly messageUsage: MessageUsage;
  readonly files?: WorkspaceFiles;
  readonly model: ModelSource;
  readonly interactions: ModelInteractions;
  readonly clock: Clock;
  readonly records: ObserverRecording;
  readonly resources: Resources<ConversationRunOptions>;
  readonly runner: ConversationRunner;
  readonly scene: ConversationScene;
  readonly changes: ChangeBuffer<ObserverChange>;
  readonly structure: ConversationStructure;
  readonly consumer: ChangeConsumer;
  readonly transcripts: TranscriptFeed;
  readonly persistence?: SqliteObserverStore;
  readonly checkpoints: CheckpointStore;
  readonly checkpointRuns: ConversationCheckpointRuns;
  readonly checkpointObservation: CheckpointObservation;
  #closed = false;

  constructor(
    parts: ObserverEnvironmentParts,
    private readonly lifetime: { readonly ownsContent: boolean; readonly ownsPersistence: boolean; readonly releaseObservation: () => void },
  ) {
    this.lifetime = Object.freeze({ ...lifetime });
    this.conversationId = parts.conversationId;
    this.content = parts.content;
    this.transcript = parts.content.transcript;
    this.memories = parts.content.memories;
    this.changes = parts.content.changes;
    this.consumer = parts.content.consumer;
    this.transcripts = parts.content.transcripts;
    this.messageUsage = parts.messageUsage;
    this.files = parts.files;
    this.model = parts.model;
    this.interactions = parts.interactions;
    this.clock = parts.clock;
    this.records = parts.records;
    this.resources = parts.resources;
    this.runner = parts.runner;
    this.scene = parts.structure.scene;
    this.structure = parts.structure;
    this.persistence = parts.persistence;
    this.checkpoints = parts.checkpoints;
    this.checkpointRuns = parts.checkpointRuns;
    this.checkpointObservation = parts.checkpointObservation;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get active(): boolean {
    return this.runner.isRunning || this.interactions.active;
  }

  async recover(rootContextId: string, controls: InvocationControls = {}) {
    if (this.#closed) throw new RuntimeError('SERVICE_CLOSED', '服务已关闭。');
    if (this.runner.isRunning) throw new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
    const run = this.checkpointRuns.read(this.conversationId, rootContextId);
    if (!run) throw new RuntimeError('CHECKPOINT_NOT_FOUND', '未找到该对话的恢复依据。');
    validateConversationCheckpointRestoration(run, { configuration: conversationCheckpointConfiguration(this.scene, this.files), transcript: this.transcript, memories: this.memories, checkpoints: this.checkpoints });
    return this.runner.resume(rootContextId, { ...controls, settings: run.settings, checkpointRun: run });
  }

  close(): void {
    if (this.#closed) return;
    if (this.runner.isRunning) throw new Error('Cannot close an environment with an active invocation');
    if (this.interactions.active) throw new Error('Cannot close an environment with active external interactions');
    this.#closed = true;
    const failures: unknown[] = [];
    const releases = [
      () => this.lifetime.releaseObservation(),
      () => this.interactions.close(),
      () => this.checkpointObservation.close(),
      () => this.records.close(),
      () => {
        if (this.lifetime.ownsContent) this.content.close();
      },
      () => {
        if (this.lifetime.ownsPersistence) this.persistence?.close();
      },
    ];
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Observer environment cleanup failed');
  }
}
