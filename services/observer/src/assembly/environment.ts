import type { ModelInitialization } from '../conversation/model/types.js';
import { Clock, MemoryCheckpointStore, RuntimeError, type InvocationControls, type CheckpointInstallation, type CheckpointFact } from '@capix/server-runtime';
import { RecordBook, Recorder, bindRecording } from '@capix/server-runtime/recording';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { Message, RecordingArchive } from '@capix/protocol';
import { ConversationRuntimeDefinition } from '../conversation/definition.js';
import { bindConversation } from '../conversation/binding.js';
import { MemoryConversationCheckpointRuns, validateConversationCheckpointContent, validateConversationCheckpointDeliveryContent, validateConversationCheckpointReceipt, validateConversationCheckpointHeads } from '../conversation/checkpoints.js';
import { RecordSource } from '../observation/record/source.js';
import { CheckpointObservation } from '../observation/checkpoints.js';
import { ModelSource } from '../conversation/model/source.js';
import { ModelInteractions } from '../conversation/model/interactions.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ConversationDecisionDefinition } from '../conversation/decision/types.js';
import { restoreConversationContent, type ConversationContent } from './content.js';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Independent entity lifetimes are established here; R only binds their published access. */
export function initializeObserver(provider: ModelInitialization, messages: readonly Message[] = [], options: { files?: WorkspaceFiles; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number; persistence?: SqliteObserverStore; checkpointObservation?: CheckpointInstallation['observation']; conversationId?: string; content?: ConversationContent; model?: ModelSource; shared?: boolean } = {}) {
  const persistence = options.persistence;
  let content = options.content;
  if (!content) {
    let saved = persistence?.loadContent(options.conversationId);
    if (saved && messages.length) throw new Error('Cannot append startup messages to restored content');
    if (persistence && !saved) {
      const transcript = new Transcript(messages);
      const memories = new Memories(transcript);
      saved = { version: 1, transcript: transcript.exportState(), memories: memories.exportState() };
      persistence.initialize(saved);
    }
    content = restoreConversationContent(saved, persistence ? messages : [], persistence);
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
        content.transcripts.close();
        content.consumer.close();
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
  try {
    persistence?.openRecording(recorder.id, options.conversationId);
    recordingOpened = true;
    const recording = bindRecording(recorder, {
      invalidate: (error) => {
        persistence?.invalidateRecording(recorder.id);
        recordSource.invalidate(error);
      },
    });
    const { transcript, transcripts, memories } = content;
    const selectionUsage = new SelectionUsage();
    const definition = new ConversationRuntimeDefinition({ files: Boolean(options.files), decision: options.decision, maxDecisionSteps: options.maxDecisionSteps });
    const model = options.model ?? new ModelSource(provider);
    const interactions = new ModelInteractions(model, { persistence: persistence?.interactions });
    const checkpoints = persistence?.checkpoints ?? new MemoryCheckpointStore();
    const checkpointRuns = persistence?.checkpointRuns ?? new MemoryConversationCheckpointRuns();
    const conversationId = options.conversationId ?? persistence?.conversationForTranscript(transcript.id)?.id ?? transcript.id;
    const checkpointObservation = new CheckpointObservation(conversationId, checkpointRuns);
    let additionalObservation = options.checkpointObservation;
    const observeCheckpoint = (fact: CheckpointFact) => {
      checkpointObservation.observe(fact);
      const additional = additionalObservation;
      if (!additional) return;
      try {
        const returned: unknown = additional.observe(fact);
        if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned).catch(() => undefined);
          throw new TypeError('Checkpoint observation must be synchronous');
        }
      } catch (error) {
        additionalObservation = undefined;
        if (additional.failure === 'propagate') throw error;
      }
    };
    const runtime = bindConversation(definition, { transcript, memories, selectionUsage, files: options.files }, interactions, { observations: [recording], changes, checkpoints: { store: checkpoints, observation: { observe: observeCheckpoint, failure: options.checkpointObservation?.failure ?? 'isolate' } }, checkpointRuns, conversationId });
    async function recover(rootContextId: string, controls: InvocationControls = {}) {
      if (closed) throw new RuntimeError('SERVICE_CLOSED', '服务已关闭。');
      if (runtime.running || interactions.active) throw new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
      const run = checkpointRuns.read(conversationId, rootContextId);
      if (!run) throw new RuntimeError('CHECKPOINT_NOT_FOUND', '未找到该对话的恢复依据。');
      if (run.configuration.customDecision || definition.customDecision || run.configuration.files !== definition.filesEnabled || run.configuration.fileScope !== (definition.filesEnabled ? options.files?.checkpointScope : undefined) || run.configuration.maxDecisionSteps !== definition.executionDefinition.maxDecisionSteps) throw new RuntimeError('CHECKPOINT_CONFIGURATION_CHANGED', '恢复所需的对话声明配置不同，或使用了尚无恢复契约的自定义决策。');
      const executionHead = checkpoints.read(run.executionContextId);
      validateConversationCheckpointHeads(run, checkpoints.read(rootContextId), executionHead);
      const validateContent = executionHead?.delivery?.status === 'succeeded' ? validateConversationCheckpointDeliveryContent : validateConversationCheckpointContent;
      validateContent(run, transcript, memories, checkpoints);
      validateConversationCheckpointReceipt(run, transcript, executionHead);
      return runtime.resume(rootContextId, { ...controls, settings: run.settings, checkpointRun: run });
    }
    content.observe(recording);
    // Fresh in-memory input is a real append after observation binds; restored content stays silent.
    if (!options.content && !persistence) transcript.append(...messages);
    let closed = false;
    function close(): void {
      if (closed) return;
      if (runtime.running) throw new Error('Cannot close an environment with an active invocation');
      if (interactions.active) throw new Error('Cannot close an environment with active external interactions');
      interactions.close();
      checkpointObservation.close();
      closed = true;
      try {
        persistence?.sealRecording(recorder.id, recorder.revision);
      } finally {
        transcripts.close();
        consumer.close();
        if (!options.shared) persistence?.close();
      }
    }
    return { transcript, memories, selectionUsage, files: options.files, model, interactions, book, clock, recorder, recording, runtime, changes, definition, consumer, recordSource, transcripts, recordingArchives, persistence, checkpoints, checkpointRuns, checkpointObservation, recover, close };
  } catch (error) {
    recordSource.invalidate(error);
    if (!options.content) {
      content.transcripts.close();
      consumer.close();
    }
    if (recordingOpened) persistence?.invalidateRecording(recorder.id);
    throw error;
  }
}
