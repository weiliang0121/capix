import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { type CheckpointStore } from '@weiliang0121/capix-checkpoint';
import type { Transcript } from '@weiliang0121/capix-transcript';
import type { Memories } from '@weiliang0121/capix-memory';
import type { WorkspaceFiles } from '../../files/index.js';
import type { ConversationScene } from '../scene.js';
import { validateConversationCheckpointContent, validateConversationCheckpointDeliveryContent, validateConversationCheckpointReceipt, validateConversationCheckpointHeads, type ConversationCheckpointRun } from '../checkpoints.js';

export function conversationCheckpointConfiguration(definition: ConversationScene, files?: WorkspaceFiles): ConversationCheckpointRun['configuration'] {
  return Object.freeze({ files: definition.filesEnabled, ...(definition.filesEnabled ? { fileScope: files?.checkpointScope } : {}), maxDecisionSteps: definition.maxDecisionSteps, customDecision: definition.customDecision, customMaintenance: definition.customMaintenance });
}

/** Shared checks run at host admission and again when the kernel binds restoration resources. */
export function validateConversationCheckpointRestoration(run: ConversationCheckpointRun, basis: { configuration: ConversationCheckpointRun['configuration']; transcript: Transcript; memories: Memories; checkpoints: CheckpointStore }): void {
  if (basis.configuration.customDecision || basis.configuration.customMaintenance || !isEqual(basis.configuration, run.configuration)) throw new RuntimeError('CHECKPOINT_CONFIGURATION_CHANGED', '恢复所需的对话声明配置不同，或使用了尚无稳定恢复契约的自定义决策或内容维护策略。');
  const execution = basis.checkpoints.read(run.executionContextId);
  validateConversationCheckpointHeads(run, basis.checkpoints.read(run.rootContextId), execution, basis.transcript);
  const validateContent = execution?.delivery?.status === 'succeeded' ? validateConversationCheckpointDeliveryContent : validateConversationCheckpointContent;
  validateContent(run, basis.transcript, basis.memories, basis.checkpoints);
  validateConversationCheckpointReceipt(run, basis.transcript, execution);
}
