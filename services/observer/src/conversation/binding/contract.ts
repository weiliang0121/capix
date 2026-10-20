import type { InvocationControls, CallableInvocationCallbacks, ProgressChannel, InvocationProgress } from '@capix/server-runtime';
import type { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import type { ModelSettings, GenerationOutput } from '@capix/protocol';
import type { ConversationTaskResources } from '../resources.js';
import type { ConversationProgress } from '../progress.js';
import type { AcceptedConversationInput } from '../accept.js';
import type { WorkspaceFiles, FileProgress } from '../../files/index.js';
import type { ActiveContent } from '../content/active.js';
import type { AnswerProgress } from '../group/answer/stream.js';
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
  executionCallbacks?: CallableInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationTaskResources>;
}

export interface ConversationEntities {
  active: ActiveContent;
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
  files?: WorkspaceFiles;
}

/** Service restoration association; the store comes from the installed Driver. */
export interface ConversationBindingOptions {
  checkpointRuns?: ConversationCheckpointRuns;
  conversationId?: string;
}
