import { decisionInputCodec, checkLeafResult } from '../group/checkpoint.js';
import { Group, cloneCheckpointValue, type CheckpointCodec, checkpointPoint, type GroupWork } from '@capix/server-runtime';
import type { ConversationDecision, ConversationDecisionInput } from './types.js';

// The E acceptance contract, not this optional persistence port, decides whether a proposal is executable.
const proposalCodec: CheckpointCodec<ConversationDecision> = { encode: cloneCheckpointValue, decode: (value) => cloneCheckpointValue(value) as unknown as ConversationDecision };

/** A deterministic policy uses the same child delivery contract as a model-backed decision. */
export class FunctionConversationDecision extends Group<ConversationDecisionInput, ConversationDecision> {
  readonly resultPoint;

  constructor(decide: (input: ConversationDecisionInput, signal: AbortSignal) => ConversationDecision | Promise<ConversationDecision>) {
    super();

    this.resultPoint = checkpointPoint<'group', ConversationDecisionInput, ConversationDecision>()({ name: 'result', state: proposalCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, result) => result } });

    this.name = 'conversationDecision';
    this.label = '决定下一步';
    this.source = 'services/observer/src/conversation/decision/function.ts · FunctionConversationDecision';
    this.deps = {};
    this.run = async (work: GroupWork<ConversationDecisionInput, ConversationDecision>) => {
      const result = await decide(work.input, work.signal);
      work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
      return result;
    };
    this.checkpoint = {
      key: 'observer.function-decision',
      version: 3,
      input: decisionInputCodec,
      output: proposalCodec,
      points: [this.resultPoint],
    };
  }
}
