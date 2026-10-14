import { isEqual } from 'es-toolkit/predicate';
import { decisionInputCodec, decisionCodec, childWaitingCodec, originalCheckpoint, waitingChild, acceptedChild } from '../operations/checkpoint.js';
import { OperationDefinition, type ChildBindings, type InvocationWorkView, type InvocationCheckpointDefinition, type OperationContextView } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>>;

  constructor(options: { readonly files: boolean }) {
    super();
    this.understandingDefinition = options.files ? new UnderstandRequestDefinition({ files: true }) : undefined;
    this.children = Object.freeze(this.understandingDefinition ? [this.understandingDefinition] : []);
    this.checkpoint = {
      key: `observer.default-decision.${options.files ? 'files' : 'chat'}`,
      version: 1,
      input: decisionInputCodec,
      output: decisionCodec,
      points: {
        understandingWaiting: {
          state: childWaitingCodec,
          check: (frame, state) => {
            originalCheckpoint(frame);
            waitingChild(frame, state, 'understanding', this.understandingDefinition?.checkpoint);
            if (frame.children.length !== 1) throw new Error('Decision checkpoint has unexpected child calls');
          },
          resume: {
            requires: {},
            uses: this.children,
            execute: async (_context, invocation, children, state: { childId: string }) => {
              if (!this.understandingDefinition) throw new Error('Understanding is unavailable');
              const child = children.get(this.understandingDefinition).resume(invocation, state.childId);
              await child.run();
              const result = await children.accept(child, decisionFromProposal);
              invocation.checkpoint?.save('result', result);
              return result;
            },
          },
        },
        result: {
          state: decisionCodec,
          check: (frame, result) => {
            originalCheckpoint(frame);
            if (frame.children.length) {
              const child = acceptedChild(frame.children[0]);
              if (frame.children.length !== 1 || child.key !== 'understanding' || !isEqual(child.state.reception.output, result)) throw new Error('Decision checkpoint differs from accepted proposal');
            }
          },
          resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: ConversationDecision) => result },
        },
      },
    };
    this.run = { requires: this.understandingDefinition ? UnderstandRequestDefinition.requires : {}, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>, invocation: InvocationWorkView<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>>, children: ChildBindings): Promise<ConversationDecision> {
    const result = await this.decide(context, invocation, children);
    invocation.checkpoint?.save('result', result);
    return result;
  }

  private async decide(context: OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>, invocation: InvocationWorkView<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision, DecisionResources>>, children: ChildBindings): Promise<ConversationDecision> {
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
    invocation.checkpoint?.save('understandingWaiting', { childId: understanding.context.id });
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
