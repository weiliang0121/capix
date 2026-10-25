import type { ModelInteractionReader } from '../../model/resources.js';
import { isEqual } from 'es-toolkit/predicate';
import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import { ModelResource } from '../../model/resources.js';
import type { ModelInteractionRef, ModelInteractionExpectation } from '../../model/interactions.js';
import type { ModelOutput } from '../../model/types.js';
import { followInputCodec, modelFeedbackCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';

interface FollowModelResources {
  readonly modelReader: ModelInteractionReader;
}
export interface FollowModelInput extends ModelInteractionRef {
  readonly expected: ModelInteractionExpectation;
}

/** No creator resource: this A can only receive the existing exchange's retained feedback. */
export class FollowModel extends Node<FollowModelInput, ModelOutput, FollowModelResources> {
  private readonly waitingPoint;
  private readonly resultPoint;

  constructor() {
    super();

    this.waitingPoint = checkpointPoint<'node', FollowModelInput, ModelOutput>()({
      name: 'waiting',
      state: followInputCodec,
      references: {},
      check: (state, facts) => {
        checkLeafResult(facts);
        if (!isEqual(facts.input, state)) throw new Error('Follow checkpoint changed interaction');
      },
      resume: { deps: { modelReader: ModelResource.read.request() }, run: (work) => this.receive(work) },
    });
    this.resultPoint = checkpointPoint<'node', FollowModelInput, ModelOutput>()({ name: 'result', state: modelFeedbackCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, result) => result } });

    this.name = 'followModel';
    this.label = '等待模型反馈';
    this.source = 'services/observer/src/conversation/node/model/follow.ts · FollowModel';
    this.checkpoint = { key: 'observer.follow-model', version: 1, input: followInputCodec, output: modelFeedbackCodec, points: [this.waitingPoint, this.resultPoint] };
    this.deps = { modelReader: ModelResource.read.request() };
    this.run = this.execute.bind(this);
  }

  private execute(work: NodeWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    work.checkpoint?.({ point: this.waitingPoint, state: work.input, refs: {} });
    return this.receive(work);
  }
  private async receive(work: NodeWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    const output = await work.resources.modelReader.result(work.input, { expected: work.input.expected });
    work.checkpoint?.({ point: this.resultPoint, state: output, refs: {} });
    return output;
  }
}
