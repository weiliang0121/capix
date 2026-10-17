import { z } from 'zod';
import { checkpointCodec } from '../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';
import { decisionInputCodec, decisionCodec } from '../operations/checkpoint.js';
import { OperationDefinition, checkpointPoint, childReference, type OperationWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
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
  readonly resultPoint;
  readonly understandingPoint;
  readonly checkpoint: InvocationCheckpointDefinition<ConversationDecisionInput, ConversationDecision, 'operation'>;

  constructor(options: { readonly files: boolean }) {
    super();
    this.understandingDefinition = options.files ? new UnderstandRequestDefinition({ files: true }) : undefined;
    this.children = Object.freeze(this.understandingDefinition ? [this.understandingDefinition] : []);
    const resultPoint = checkpointPoint<'operation', ConversationDecisionInput, ConversationDecision>()({
      name: 'result',
      state: decisionCodec,
      references: {},
      check: (result, facts) => {
        if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input)) throw new Error('Decision checkpoint changed its input');
        const calls = facts.children.values();
        if (calls.length) {
          const child = calls[0]!;
          if (!this.understandingDefinition || calls.length !== 1 || child.key !== 'understanding' || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(child.reception.value, result)) throw new Error('Decision checkpoint differs from accepted proposal');
          facts.children.require(this.understandingDefinition, child.ref);
        }
      },
      resume: { execute: (_work, result) => result },
    });
    this.resultPoint = resultPoint;
    const understanding = this.understandingDefinition;
    this.understandingPoint = understanding
      ? checkpointPoint<'operation', ConversationDecisionInput, ConversationDecision>()({
          name: 'understandingWaiting',
          state: checkpointCodec(z.null()),
          references: { understanding: childReference(understanding) },
          check: (_state, facts) => {
            const child = facts.references.understanding;
            if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || facts.children.values().length !== 1 || child.key !== 'understanding' || child.returned || child.reception.status !== 'pending') throw new Error('Decision checkpoint must identify its waiting understanding');
          },
          resume: {
            uses: [understanding],
            execute: async (work, _state, saved) => {
              const child = work.children.resume(saved.understanding);
              await child.run();
              const result = await child.accept(decisionFromProposal);
              work.checkpoint?.save(resultPoint, result, {});
              return result;
            },
          },
        })
      : undefined;
    this.checkpoint = { key: `observer.default-decision.${options.files ? 'files' : 'chat'}`, version: 2, input: decisionInputCodec, output: decisionCodec, points: [...(this.understandingPoint ? [this.understandingPoint] : []), resultPoint] };
    this.run = { requires: this.understandingDefinition ? UnderstandRequestDefinition.requires : {}, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(work: OperationWork<ConversationDecisionInput, ConversationDecision, DecisionResources>): Promise<ConversationDecision> {
    const result = await this.decide(work);
    work.checkpoint?.save(this.resultPoint, result, {});
    return result;
  }

  private async decide(work: OperationWork<ConversationDecisionInput, ConversationDecision, DecisionResources>): Promise<ConversationDecision> {
    const input = work.input;
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
    const understanding = work.children.create(this.understandingDefinition, request, { key: 'understanding' });
    if (!this.understandingPoint) throw new Error('Understanding checkpoint is unavailable');
    work.checkpoint?.save(this.understandingPoint, null, { understanding: understanding.ref });
    await understanding.run();
    return understanding.accept(decisionFromProposal);
  }
}

function decisionFromProposal(proposal: RequestProposal): ConversationDecision {
  if (proposal.kind === 'file') return { kind: 'invoke', capability: 'checkFile', arguments: { task: proposal.task, instruction: proposal.instruction } };
  if (proposal.kind === 'reply') return { kind: 'invoke', capability: 'answer', arguments: {} };
  if (proposal.kind === 'clarify') return { kind: 'finish', conclusion: { kind: 'clarify', question: proposal.question } };
  return { kind: 'finish', conclusion: { kind: 'unsupported', explanation: proposal.explanation } };
}
