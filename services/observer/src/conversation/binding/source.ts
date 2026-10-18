import { isEqual } from 'es-toolkit';
import type { ExecutionDefinition, ExecutionInvocationCallbacks, RuntimeCallSource } from '@capix/server-runtime';
import { TranscriptRangeRef, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import type { GenerationOutput } from '@capix/protocol';
import type { ConversationRuntimeDefinition } from '../definition.js';
import type { ModelInteractions } from '../model/interactions.js';
import { validateSettings } from '../model/settings.js';
import type { AcceptedConversationInput } from '../accept.js';
import type { ConversationExecutionResources, ConversationResourceSource } from '../resources.js';
import { checkpointTranscriptFingerprint, type ConversationCheckpointRun } from '../checkpoints.js';
import type { ConversationBindingOptions, ConversationEntities, ConversationRunOptions } from './contract.js';
import { conversationCheckpointConfiguration, validateConversationCheckpointRestoration } from './checkpoint.js';
import { activityProgress, answerProgress, executionProgress, messageProgress, taskProgress } from './progress.js';

type AnyExecutionDefinition = ExecutionDefinition<any, any, any, any, any>;
interface ConversationCallCapture {
  input?: TranscriptAppendProgress;
  transcript?: ConversationCheckpointRun['transcript'];
}

/** One reusable binding source; each run's input/capture/started facts have their own slot. */
export class ConversationCallSource implements RuntimeCallSource<unknown, ConversationRunOptions, ConversationResourceSource> {
  readonly #captures = new WeakMap<ConversationRunOptions, ConversationCallCapture>();

  constructor(
    private readonly definition: ConversationRuntimeDefinition,
    private readonly entities: ConversationEntities,
    private readonly model: ModelInteractions,
    private readonly capabilities: ConversationBindingOptions,
  ) {
    if (capabilities.checkpointRuns && (!capabilities.checkpoints || !capabilities.conversationId)) throw new Error('Checkpoint run association requires a conversation and checkpoint store');
  }

  validate(options: ConversationRunOptions): void {
    validateSettings(options.settings);
    const restored = options.checkpointRun;
    if (restored) {
      if (restored.conversationId !== this.capabilities.conversationId) throw new Error('Checkpoint belongs to another conversation');
      const known = this.capabilities.checkpointRuns?.read(restored.conversationId, restored.rootContextId);
      if (!known || !isEqual(known, restored)) throw new Error('Checkpoint run is not registered in this conversation');
      const checkpoints = this.capabilities.checkpoints;
      if (!checkpoints) throw new Error('Checkpoint restoration requires a checkpoint store');
      validateConversationCheckpointRestoration(restored, { configuration: conversationCheckpointConfiguration(this.definition, this.entities.files), transcript: this.entities.transcript, memories: this.entities.memories, checkpoints: checkpoints.store });
    }
    this.#captures.set(options, {});
  }

  runtime(_input: unknown, options: ConversationRunOptions): ConversationResourceSource {
    return this.resources(options, 'input', true);
  }

  capture(input: unknown, options: ConversationRunOptions, current: AnyExecutionDefinition): ConversationResourceSource {
    const selected = current === this.definition.executionDefinition;
    const accepted = selected ? (input as AcceptedConversationInput) : undefined;
    const restored = options.checkpointRun;
    const transcript = this.entities.transcript;
    const inputRange = this.#captures.get(options)?.input;
    if (selected && (!accepted || !Number.isSafeInteger(accepted.messageIndex) || accepted.messageIndex < 0 || !isEqual(transcript.get(accepted.messageIndex), accepted.message))) throw new Error('Execution input must identify an accepted source message');
    if (selected && !restored && (!inputRange || inputRange.end - 1 !== accepted!.messageIndex)) throw new Error('Execution input differs from the actual accepted input range');
    const range = new TranscriptRangeRef(transcript, restored?.transcript.start ?? 0, restored?.transcript.end ?? (selected ? accepted!.messageIndex + 1 : transcript.length));
    if (selected && this.capabilities.checkpointRuns && !restored) {
      const capture = this.#captures.get(options);
      if (!capture?.input) throw new Error('Checkpoint construction requires the actual accepted input range');
      capture.transcript = Object.freeze({ transcriptId: transcript.id, start: range.start, end: range.end, revision: transcript.revision, fingerprint: checkpointTranscriptFingerprint(transcript, Math.min(range.start, capture.input.start), range.end) });
    }
    return { ...this.resources(options, 'answer', selected), fileTask: accepted?.fileTask, transcriptRange: range };
  }

  callbacks(current: AnyExecutionDefinition, options: ConversationRunOptions): ExecutionInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources> | undefined {
    if (current !== this.definition.executionDefinition) return;
    return {
      started: (context, invocation) => {
        this.started(options, context.id, invocation.identity.parentContextId);
        options.executionCallbacks?.started?.(context, invocation);
      },
    };
  }

  progress(_input: unknown, options: ConversationRunOptions) {
    return activityProgress(options.activity);
  }

  executionOutput(current: AnyExecutionDefinition, options: ConversationRunOptions) {
    return current === this.definition.executionDefinition ? answerProgress(options.answerProgress) : undefined;
  }

  executionProgress(current: AnyExecutionDefinition, options: ConversationRunOptions) {
    return current === this.definition.executionDefinition ? executionProgress(options.progress) : undefined;
  }

  private resources(options: ConversationRunOptions, kind: 'input' | 'answer', selected: boolean): ConversationResourceSource {
    const restored = options.checkpointRun;
    const captureInput = selected && kind === 'input' ? (range: TranscriptAppendProgress) => this.captureInput(options, range) : undefined;
    return {
      ...this.entities,
      ...(restored?.memories.items ? { memorySnapshot: { memoriesId: this.entities.memories.id, sequence: restored.memories.sequence, items: restored.memories.items } } : {}),
      settings: Object.freeze({ ...(restored?.settings ?? options.settings) }),
      model: this.model,
      fileProgress: selected ? options.fileProgress : undefined,
      taskProgress: selected ? taskProgress(options.progress, options.fileProgress) : undefined,
      messageProgress: selected ? messageProgress(kind, options.progress, captureInput) : undefined,
    };
  }

  private captureInput(options: ConversationRunOptions, input: TranscriptAppendProgress): void {
    const capture = this.#captures.get(options);
    if (capture) capture.input = input;
  }

  private started(options: ConversationRunOptions, executionContextId: string, rootContextId?: string): void {
    const runs = this.capabilities.checkpointRuns;
    if (!runs) return;
    const capture = this.#captures.get(options);
    if (!capture?.input || !capture.transcript || !rootContextId) throw new Error('Checkpoint construction basis is incomplete');
    const memories = this.entities.memories;
    runs.register({ conversationId: this.capabilities.conversationId!, rootContextId, executionContextId, settings: options.settings, configuration: conversationCheckpointConfiguration(this.definition, this.entities.files), transcript: capture.transcript, input: capture.input, memories: { id: memories.id, sequence: memories.sequence, items: memories.snapshot() } });
  }
}
