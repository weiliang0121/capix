import { z } from 'zod';
import { checkpointCodec } from '../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';
import { decisionInputCodec, decisionCodec } from '../group/checkpoint.js';
import { Group, checkpointPoint, childReference, type GroupWork } from '@capix/structure';
import type { ModelCallResources } from '../resources.js';
import { UnderstandRequest } from '../group/request/understand.js';
import type { RequestProposal } from '../group/request/output.js';
import type { ConversationDecision, ConversationDecisionInput } from './types.js';

type DecisionResources = ModelCallResources | Record<string, never>;

/** Known deliveries choose the next step directly; only an unresolved request needs a model. */
export class DefaultConversationDecision extends Group<ConversationDecisionInput, ConversationDecision, DecisionResources> {
  readonly understanding?: UnderstandRequest;

  readonly resultPoint;
  readonly understandingPoint;

  constructor(options: { readonly files: boolean }) {
    super();

    this.understanding = options.files ? new UnderstandRequest({ files: true }) : undefined;
    if (this.understanding) this.add(this.understanding);
    const resultPoint = checkpointPoint<'group', ConversationDecisionInput, ConversationDecision>()({
      name: 'result',
      state: decisionCodec,
      references: {},
      check: (result, facts) => {
        if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input)) throw new Error('Decision checkpoint changed its input');
        const calls = facts.children.values();
        if (calls.length) {
          const child = calls[0]!;
          if (!this.understanding || calls.length !== 1 || child.key !== 'understanding' || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(child.reception.value, result)) throw new Error('Decision checkpoint differs from accepted proposal');
          facts.children.require(this.understanding, child.ref);
        }
      },
      resume: { run: (_work, result) => result },
    });
    this.resultPoint = resultPoint;
    const understanding = this.understanding;
    this.understandingPoint = understanding
      ? checkpointPoint<'group', ConversationDecisionInput, ConversationDecision>()({
          name: 'understandingWaiting',
          state: checkpointCodec(z.null()),
          references: { understanding: childReference(understanding) },
          check: (_state, facts) => {
            const child = facts.references.understanding;
            if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || facts.children.values().length !== 1 || child.key !== 'understanding' || child.returned || child.reception.status !== 'pending') throw new Error('Decision checkpoint must identify its waiting understanding');
          },
          resume: {
            uses: [understanding],
            run: async (work, _state, saved) => {
              const child = work.children.resume(saved.understanding);

              const result = await child.invoke({ result: { succeeded: decisionFromProposal } });
              work.checkpoint?.({ point: resultPoint, state: result, refs: {} });
              return result;
            },
          },
        })
      : undefined;

    this.name = 'conversationDecision';
    this.label = '决定下一步';
    this.source = 'services/observer/src/conversation/decision/default.ts · DefaultConversationDecision';
    this.deps = this.understanding ? UnderstandRequest.deps : {};
    this.run = this.execute.bind(this);
    this.checkpoint = { key: `observer.default-decision.${options.files ? 'files' : 'chat'}`, version: 3, input: decisionInputCodec, output: decisionCodec, points: [...(this.understandingPoint ? [this.understandingPoint] : []), resultPoint] };
  }

  private async execute(work: GroupWork<ConversationDecisionInput, ConversationDecision, DecisionResources>): Promise<ConversationDecision> {
    const result = await this.decide(work);
    work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
    return result;
  }

  private async decide(work: GroupWork<ConversationDecisionInput, ConversationDecision, DecisionResources>): Promise<ConversationDecision> {
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
    if (!this.understanding) {
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
    const understanding = work.children.create(this.understanding, request, { key: 'understanding' });
    if (!this.understandingPoint) throw new Error('Understanding checkpoint is unavailable');
    work.checkpoint?.({ point: this.understandingPoint, state: null, refs: { understanding: understanding.ref } });

    return understanding.invoke({ result: { succeeded: decisionFromProposal } });
  }
}

function decisionFromProposal(proposal: RequestProposal): ConversationDecision {
  if (proposal.kind === 'file') return { kind: 'invoke', capability: 'checkFile', arguments: { task: proposal.task, instruction: proposal.instruction } };
  if (proposal.kind === 'reply') return { kind: 'invoke', capability: 'answer', arguments: {} };
  if (proposal.kind === 'clarify') return { kind: 'finish', conclusion: { kind: 'clarify', question: proposal.question } };
  return { kind: 'finish', conclusion: { kind: 'unsupported', explanation: proposal.explanation } };
}
