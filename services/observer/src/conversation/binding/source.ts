import { isEqual } from 'es-toolkit';
import type { CallableInvocationCallbacks, CallableCallSource, CheckpointStore } from '@capix/server-runtime';
import { TranscriptRangeRef, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import type { GenerationOutput } from '@capix/protocol';
import type { ConversationScene } from '../scene.js';
import type { ModelInteractions } from '../model/interactions.js';
import { validateSettings } from '../model/settings.js';
import type { AcceptedConversationInput } from '../accept.js';
import type { ConversationTaskResources, ConversationResourceSource } from '../resources.js';
import { checkpointTranscriptFingerprint, type ConversationCheckpointRun } from '../checkpoints.js';
import type { ConversationBindingOptions, ConversationEntities, ConversationRunOptions } from './contract.js';
import { conversationCheckpointConfiguration, validateConversationCheckpointRestoration } from './checkpoint.js';
import { activityProgress, answerProgress, messageProgress, taskProgress } from './progress.js';

interface ConversationCallCapture {
  input?: TranscriptAppendProgress;
  transcript?: ConversationCheckpointRun['transcript'];
}

/** One reusable binding source; each run's input/capture/started facts have their own slot. */
export class ConversationCallSource implements CallableCallSource<unknown, ConversationRunOptions, ConversationResourceSource> {
  readonly #captures = new WeakMap<ConversationRunOptions, ConversationCallCapture>();

  constructor(
    private readonly definition: ConversationScene,
    private readonly entities: ConversationEntities,
    private readonly model: ModelInteractions,
    private readonly capabilities: ConversationBindingOptions,
    private readonly checkpointStore?: CheckpointStore,
  ) {
    if (capabilities.checkpointRuns && (!checkpointStore || !capabilities.conversationId)) throw new Error('Checkpoint run association requires a conversation and checkpoint store');
  }

  validate(options: ConversationRunOptions): void {
    validateSettings(options.settings);
    const restored = options.checkpointRun;
    if (restored) {
      if (restored.conversationId !== this.capabilities.conversationId) throw new Error('Checkpoint belongs to another conversation');
      const known = this.capabilities.checkpointRuns?.read(restored.conversationId, restored.rootContextId);
      if (!known || !isEqual(known, restored)) throw new Error('Checkpoint run is not registered in this conversation');
      const checkpoints = this.checkpointStore;
      if (!checkpoints) throw new Error('Checkpoint restoration requires a checkpoint store');
      validateConversationCheckpointRestoration(restored, { configuration: conversationCheckpointConfiguration(this.definition, this.entities.files), transcript: this.entities.transcript, memories: this.entities.memories, checkpoints });
    }
    this.#captures.set(options, {});
  }

  capture(_input: unknown, options: ConversationRunOptions): ConversationResourceSource {
    return this.resources(options, 'input');
  }

  captureTask(accepted: AcceptedConversationInput, options: ConversationRunOptions): ConversationResourceSource {
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
    return { ...this.resources(options, 'answer'), fileTask: accepted?.fileTask, transcriptRange: range };
  }

  startedTask(options: ConversationRunOptions): NonNullable<CallableInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationTaskResources>['started']> {
    return (context, invocation) => {
      this.registerTask(options, context.id, invocation.identity.parentContextId);
      const result = options.executionCallbacks?.started?.(context, invocation);
      if (result !== undefined) return result;
      options.progress?.publish({ kind: 'execution', contextId: context.id });
      return undefined;
    };
  }

  progress(_input: unknown, options: ConversationRunOptions) {
    return activityProgress(options.activity);
  }

  taskOutput(options: ConversationRunOptions) {
    return answerProgress(options.answerProgress);
  }

  private resources(options: ConversationRunOptions, kind: 'input' | 'answer'): ConversationResourceSource {
    const restored = options.checkpointRun;
    const captureInput = kind === 'input' ? (range: TranscriptAppendProgress) => this.captureInput(options, range) : undefined;
    return {
      ...this.entities,
      ...(restored?.memories.items ? { memorySnapshot: { memoriesId: this.entities.memories.id, sequence: restored.memories.sequence, items: restored.memories.items } } : {}),
      settings: Object.freeze({ ...(restored?.settings ?? options.settings) }),
      model: this.model,
      fileProgress: options.fileProgress,
      taskProgress: taskProgress(options.progress, options.fileProgress),
      messageProgress: messageProgress(kind, options.progress, captureInput),
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
    runs.register({ conversationId: this.capabilities.conversationId!, rootContextId, executionContextId, settings: options.settings, configuration: conversationCheckpointConfiguration(this.definition, this.entities.files), transcript: capture.transcript, input: capture.input, memories: { id: memories.id, sequence: memories.sequence, items: memories.snapshot() } });
  }
}
