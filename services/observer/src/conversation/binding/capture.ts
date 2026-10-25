import { isEqual } from 'es-toolkit';
import type { CallableInvocationCallbacks } from '@capix/server-runtime';
import { TranscriptRangeRef, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import type { GenerationOutput, ModelSettings } from '@capix/protocol';
import type { ConversationScene } from '../scene.js';
import { validateSettings } from '../model/settings.js';
import type { AcceptedConversationInput } from '../accept.js';
import { checkpointTranscriptFingerprint, type ConversationCheckpointRun } from '../checkpoints.js';
import type { ConversationCheckpointOptions, ConversationEntities, ConversationRunOptions } from './contract.js';
import { conversationCheckpointConfiguration, validateConversationCheckpointRestoration } from './checkpoint.js';
import { messageProgress } from './progress.js';

interface Capture {
  readonly settings: Readonly<ModelSettings>;
  input?: TranscriptAppendProgress;
  transcript?: ConversationCheckpointRun['transcript'];
}

/** Correlate accepted input and checkpoint registration without owning resource supply. */
export class ConversationCallCapture {
  readonly #captures = new WeakMap<ConversationRunOptions, Capture>();

  constructor(
    private readonly scene: ConversationScene,
    private readonly entities: ConversationEntities,
    private readonly capabilities: ConversationCheckpointOptions = {},
  ) {
    this.entities = Object.freeze({ ...entities });
    this.capabilities = Object.freeze({ ...capabilities });
    if (capabilities.checkpointRuns && (!capabilities.checkpoints || !capabilities.conversationId)) throw new Error('Checkpoint run association requires a conversation and checkpoint store');
  }

  /** Resource supply and call hooks must describe the same installed conversation. */
  assertScope(scene: ConversationScene, entities?: ConversationEntities): void {
    if (scene !== this.scene) throw new Error('Conversation call capture belongs to another scene');
    if (!entities) return;
    for (const key of ['transcript', 'memories', 'active', 'selectionUsage', 'files'] as const) {
      if (entities[key] !== this.entities[key]) throw new Error(`Conversation call capture has a different ${key} entity`);
    }
  }

  validate(options: ConversationRunOptions): undefined {
    validateSettings(options.settings);
    const restored = options.checkpointRun;
    if (restored) {
      if (restored.conversationId !== this.capabilities.conversationId) throw new Error('Checkpoint belongs to another conversation');
      const known = this.capabilities.checkpointRuns?.read(restored.conversationId, restored.rootContextId);
      if (!known || !isEqual(known, restored)) throw new Error('Checkpoint run is not registered in this conversation');
      const checkpoints = this.capabilities.checkpoints;
      if (!checkpoints) throw new Error('Checkpoint restoration requires a checkpoint store');
      validateConversationCheckpointRestoration(restored, { configuration: conversationCheckpointConfiguration(this.scene, this.entities.files), transcript: this.entities.transcript, memories: this.entities.memories, checkpoints });
    }
    this.#captures.set(options, { settings: Object.freeze({ ...(restored?.settings ?? options.settings) }) });
  }

  settings(options: ConversationRunOptions): Readonly<ModelSettings> {
    const capture = this.#captures.get(options);
    if (!capture) throw new Error('Conversation call must be validated before capturing resources');
    return capture.settings;
  }

  inputProgress(options: ConversationRunOptions) {
    return messageProgress('input', options.progress, (range) => this.captureInput(options, range));
  }

  captureTask(accepted: AcceptedConversationInput, options: ConversationRunOptions): TranscriptRangeRef {
    const restored = options.checkpointRun;
    const transcript = this.entities.transcript;
    const inputRange = this.#captures.get(options)?.input;
    if (!accepted || !Number.isSafeInteger(accepted.messageIndex) || accepted.messageIndex < 0 || !isEqual(transcript.get(accepted.messageIndex), accepted.message)) throw new Error('Task input must identify an accepted source message');
    if (!restored && (!inputRange || inputRange.end - 1 !== accepted.messageIndex)) throw new Error('Task input differs from the actual accepted input range');
    const range = new TranscriptRangeRef(transcript, restored?.transcript.start ?? 0, restored?.transcript.end ?? accepted.messageIndex + 1);
    if (this.capabilities.checkpointRuns && !restored) {
      const capture = this.#captures.get(options);
      if (!capture?.input) throw new Error('Checkpoint construction requires the actual accepted input range');
      capture.transcript = Object.freeze({ transcriptId: transcript.id, start: range.start, end: range.end, revision: transcript.revision, fingerprint: checkpointTranscriptFingerprint(transcript, Math.min(range.start, capture.input.start), range.end) });
    }
    return range;
  }

  startedTask(options: ConversationRunOptions): NonNullable<CallableInvocationCallbacks<AcceptedConversationInput, GenerationOutput, object>['started']> {
    return (context, invocation) => {
      this.registerTask(options, context.id, invocation.identity.parentContextId);
      const result = options.executionCallbacks?.started?.(context, invocation);
      if (result !== undefined) return result;
      options.progress?.publish({ kind: 'execution', contextId: context.id });
      return undefined;
    };
  }

  private captureInput(options: ConversationRunOptions, input: TranscriptAppendProgress): void {
    const capture = this.#captures.get(options);
    if (capture) capture.input = input;
  }

  private registerTask(options: ConversationRunOptions, executionContextId: string, rootContextId?: string): void {
    const runs = this.capabilities.checkpointRuns;
    if (!runs) return;
    const capture = this.#captures.get(options);
    if (!capture?.input || !capture.transcript || !rootContextId) throw new Error('Checkpoint construction basis is incomplete');
    const memories = this.entities.memories;
    runs.register({ conversationId: this.capabilities.conversationId!, rootContextId, executionContextId, settings: capture.settings, configuration: conversationCheckpointConfiguration(this.scene, this.entities.files), transcript: capture.transcript, input: capture.input, memories: { id: memories.id, sequence: memories.sequence, items: memories.snapshot() } });
  }
}
