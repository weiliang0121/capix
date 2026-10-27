import type { Runner, CallableInvocationCallbacks } from '@capix/server-runtime';
import type { InvocationControls, InvocationProgress } from '@capix/invocation';
import type { CheckpointStore } from '@capix/checkpoint';
import type { ProgressChannel } from '@capix/changes';
import type { Transcript } from '@capix/transcript';
import type { Memories } from '@capix/memory';
import type { MessageUsage } from '@capix/measurement';
import type { ModelSettings, GenerationOutput } from '@capix/protocol';
import type { ConversationScene } from '../scene.js';
import type { ConversationProgress } from '../progress.js';
import type { AcceptedConversationInput } from '../accept.js';
import type { WorkspaceFiles, FileProgress } from '../../files/index.js';
import type { ActiveView } from '@capix/observer-content';
import type { AnswerProgress } from '../group/answer/stream.js';
import type { ConversationCheckpointRun, ConversationCheckpointRuns } from '../checkpoints.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  /** Host-only fixed construction basis; this does not replay submission notifications. */
  checkpointRun?: ConversationCheckpointRun;
  /** One passive channel for this submission. Reusing it explicitly shares its failure state. */
  progress?: ProgressChannel<ConversationProgress>;
  /** Optional passive call metadata; a failed activity consumer does not disable content progress. */
  activity?: ProgressChannel<InvocationProgress>;
  fileProgress?: ProgressChannel<FileProgress>;
  answerProgress?: ProgressChannel<AnswerProgress>;
  executionCallbacks?: CallableInvocationCallbacks<AcceptedConversationInput, GenerationOutput, object>;
}

export interface ConversationEntities {
  active: ActiveView;
  transcript: Transcript;
  memories: Memories;
  messageUsage: MessageUsage;
  files?: WorkspaceFiles;
}

/** Service restoration association uses the same store installed by its Runner. */
export interface ConversationCheckpointOptions {
  checkpoints?: CheckpointStore;
  checkpointRuns?: ConversationCheckpointRuns;
  conversationId?: string;
}

export type ConversationRunner = Runner<ConversationScene, ConversationRunOptions>;
