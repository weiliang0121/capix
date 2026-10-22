import { RuntimeError, type Driver, type Clock, type ChangeBuffer, type CheckpointStore, type InvocationControls } from '@capix/server-runtime';
import type { RecordBook, Recorder, RecordingInstallation } from '@capix/server-runtime/recording';
import type { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { ObserverChange, RecordingArchive } from '@capix/protocol';
import type { ConversationStructure } from '../conversation/scene.js';
import type { BuiltConversationScene } from '../conversation/binding.js';
import type { ConversationCheckpointRuns } from '../conversation/checkpoints.js';
import { conversationCheckpointConfiguration, validateConversationCheckpointRestoration } from '../conversation/binding/checkpoint.js';
import type { ModelSource } from '../conversation/model/source.js';
import type { ModelInteractions } from '../conversation/model/interactions.js';
import type { TranscriptFeed } from '../conversation/transcript/feed.js';
import type { RecordSource } from '../observation/record/source.js';
import type { CheckpointObservation } from '../observation/checkpoints.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { SqliteObserverStore } from '../persistence/store.js';
import type { ChangeConsumer } from './changes.js';
import type { ConversationContent } from './content.js';

export interface ObserverEnvironmentParts {
  readonly conversationId: string;
  readonly content: ConversationContent;
  readonly selectionUsage: SelectionUsage;
  readonly files?: WorkspaceFiles;
  readonly model: ModelSource;
  readonly interactions: ModelInteractions;
  readonly book: RecordBook;
  readonly clock: Clock;
  readonly recorder: Recorder;
  readonly recording: RecordingInstallation;
  readonly driver: Driver;
  readonly scene: BuiltConversationScene;
  readonly structure: ConversationStructure;
  readonly recordSource: RecordSource;
  readonly recordingArchives: readonly RecordingArchive[];
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
  readonly selectionUsage: SelectionUsage;
  readonly files?: WorkspaceFiles;
  readonly model: ModelSource;
  readonly interactions: ModelInteractions;
  readonly book: RecordBook;
  readonly clock: Clock;
  readonly recorder: Recorder;
  readonly recording: RecordingInstallation;
  readonly driver: Driver;
  readonly scene: BuiltConversationScene;
  readonly changes: ChangeBuffer<ObserverChange>;
  readonly structure: ConversationStructure;
  readonly consumer: ChangeConsumer;
  readonly recordSource: RecordSource;
  readonly transcripts: TranscriptFeed;
  readonly recordingArchives: readonly RecordingArchive[];
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
    this.selectionUsage = parts.selectionUsage;
    this.files = parts.files;
    this.model = parts.model;
    this.interactions = parts.interactions;
    this.book = parts.book;
    this.clock = parts.clock;
    this.recorder = parts.recorder;
    this.recording = parts.recording;
    this.driver = parts.driver;
    this.scene = parts.scene;
    this.structure = parts.structure;
    this.recordSource = parts.recordSource;
    this.recordingArchives = parts.recordingArchives;
    this.persistence = parts.persistence;
    this.checkpoints = parts.checkpoints;
    this.checkpointRuns = parts.checkpointRuns;
    this.checkpointObservation = parts.checkpointObservation;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get active(): boolean {
    return this.driver.isRunning(this.scene) || this.interactions.active;
  }

  async recover(rootContextId: string, controls: InvocationControls = {}) {
    if (this.#closed) throw new RuntimeError('SERVICE_CLOSED', '服务已关闭。');
    if (this.driver.isRunning(this.scene)) throw new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
    const run = this.checkpointRuns.read(this.conversationId, rootContextId);
    if (!run) throw new RuntimeError('CHECKPOINT_NOT_FOUND', '未找到该对话的恢复依据。');
    validateConversationCheckpointRestoration(run, { configuration: conversationCheckpointConfiguration(this.scene, this.files), transcript: this.transcript, memories: this.memories, checkpoints: this.checkpoints });
    return this.driver.resume(this.scene, rootContextId, { ...controls, settings: run.settings, checkpointRun: run });
  }

  close(): void {
    if (this.#closed) return;
    if (this.driver.isRunning(this.scene)) throw new Error('Cannot close an environment with an active invocation');
    if (this.interactions.active) throw new Error('Cannot close an environment with active external interactions');
    this.#closed = true;
    const failures: unknown[] = [];
    const releases = [
      () => this.lifetime.releaseObservation(),
      () => this.interactions.close(),
      () => this.checkpointObservation.close(),
      () => this.persistence?.sealRecording(this.recorder.id, this.recorder.revision),
      () => this.recordSource.close(),
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
