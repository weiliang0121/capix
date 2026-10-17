import type { ChangeCapture, InvocationControls, ExecutionInvocationCallbacks, ObservationInstallation, ProgressChannel, InvocationProgress, CheckpointInstallation } from '@capix/server-runtime';
import type { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { ModelSettings, InvocationEvent, GenerationOutput } from '@capix/protocol';
import type { ConversationExecutionResources } from '../resources.js';
import type { ConversationProgress } from '../progress.js';
import type { AcceptedConversationInput } from '../accept.js';
import type { WorkspaceFiles, FileProgress } from '../../files/index.js';
import type { AnswerProgress } from '../operations/answer/stream.js';
import type { ConversationCheckpointRun, ConversationCheckpointRuns } from '../checkpoints.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  /** Host-only fixed construction basis; this does not replay submission notifications. */
  checkpointRun?: ConversationCheckpointRun;
  /** One passive channel for this submission. Reusing it explicitly shares its failure state. */
  progress?: ProgressChannel<ConversationProgress>;
  /** Optional passive REOA metadata; a failed activity consumer does not disable content progress. */
  activity?: ProgressChannel<InvocationProgress>;
  fileProgress?: ProgressChannel<FileProgress>;
  answerProgress?: ProgressChannel<AnswerProgress>;
  executionCallbacks?: ExecutionInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>;
}

export interface ConversationEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
  files?: WorkspaceFiles;
}

/** Fixed optional capabilities of the conversation binding, not options for one submission. */
export interface ConversationBindingOptions {
  observations?: readonly ObservationInstallation[];
  changes?: ChangeCapture<InvocationEvent>;
  checkpoints?: CheckpointInstallation;
  checkpointRuns?: ConversationCheckpointRuns;
  conversationId?: string;
}
