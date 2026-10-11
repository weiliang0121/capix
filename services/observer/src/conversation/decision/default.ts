import { OperationDefinition, type ChildBindings, type InvocationView, type OperationContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { ConversationResources } from '../resources.js';
import { UnderstandRequestDefinition } from '../operations/request/understand.js';
import type { RequestProposal } from '../operations/request/output.js';
import type { ConversationDecision, ConversationDecisionInput } from './types.js';

type DecisionResources = ConversationResources | Record<string, never>;

/** Known deliveries choose the next step directly; only an unresolved request needs a model. */
export class DefaultConversationDecisionDefinition extends OperationDefinition<ConversationDecisionInput, ConversationDecision, DecisionResources> {
  readonly name = 'conversationDecision';
  readonly label = '决定下一步';
  readonly source = 'services/observer/src/conversation/decision/default.ts · DefaultConversationDecisionDefinition';
  readonly observation = [invocationRecording()];
  readonly understandingDefinition?: UnderstandRequestDefinition;
  readonly children;
  readonly run;

  constructor(options: { readonly files: boolean }) {
    super();
    this.understandingDefinition = options.files ? new UnderstandRequestDefinition({ files: true }) : undefined;
    this.children = Object.freeze(this.understandingDefinition ? [this.understandingDefinition] : []);
    this.run = { requires: this.understandingDefinition ? UnderstandRequestDefinition.requires : {}, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>, invocation: InvocationView<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>>, children: ChildBindings): Promise<ConversationDecision> {
    const input = context.currentInput;
    const progress = input.progress;
    if (progress.answer) {
      if (progress.answer.kind === 'answer' && progress.file?.task.output && !progress.saved) return { kind: 'invoke', capability: 'save', arguments: {} };
      return { kind: 'finish', conclusion: { kind: 'settled' } };
    }
    const check = input.latest?.capability === 'checkFile' ? input.latest.output : undefined;
    if (check?.kind === 'needs-input') return { kind: 'finish', conclusion: { kind: 'clarify', question: check.question } };
    const feedback = input.feedback ?? (check?.kind === 'revise' ? { code: check.reason, message: check.feedback } : undefined);
    if (progress.file && !feedback) return { kind: 'invoke', capability: progress.file.task.sourcePath ? 'document' : 'answer', arguments: {} };
    if (!this.understandingDefinition) {
      if (input.request.fileTask) return { kind: 'finish', conclusion: { kind: 'unsupported', explanation: '当前服务未启用工作目录文件处理，无法执行本次文件操作。' } };
      return { kind: 'invoke', capability: 'answer', arguments: {} };
    }
    if (input.request.fileTask && !feedback) return { kind: 'invoke', capability: 'checkFile', arguments: { task: input.request.fileTask, instruction: input.request.message.content } };
    const request = {
      ...input.request,
      available: input.available,
      ...(feedback ? { feedback } : {}),
      progress: { ...(progress.file ? { file: progress.file.task } : {}), ...(progress.saved ? { saved: { path: progress.saved.path } } : {}) },
    };
    const understanding = children.get(this.understandingDefinition).create(invocation, request, { key: 'understanding' });
    await understanding.run();
    return children.accept(understanding, (proposal) => decisionFromProposal(proposal));
  }
}

function decisionFromProposal(proposal: RequestProposal): ConversationDecision {
  if (proposal.kind === 'file') return { kind: 'invoke', capability: 'checkFile', arguments: { task: proposal.task, instruction: proposal.instruction } };
  if (proposal.kind === 'reply') return { kind: 'invoke', capability: 'answer', arguments: {} };
  if (proposal.kind === 'clarify') return { kind: 'finish', conclusion: { kind: 'clarify', question: proposal.question } };
  return { kind: 'finish', conclusion: { kind: 'unsupported', explanation: proposal.explanation } };
}
