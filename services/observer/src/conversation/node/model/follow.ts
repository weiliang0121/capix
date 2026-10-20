import { isEqual } from 'es-toolkit/predicate';
import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ModelResource } from '../../model/resources.js';
import type { ModelInteractionReader, ModelInteractionRef, ModelInteractionExpectation } from '../../model/interactions.js';
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
      resume: { requires: { modelReader: ModelResource.read.request() }, execute: (work) => this.receive(work) },
    });
    this.resultPoint = checkpointPoint<'node', FollowModelInput, ModelOutput>()({ name: 'result', state: modelFeedbackCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });

    this.setDefinition({ name: 'followModel', label: '等待模型反馈', source: 'services/observer/src/conversation/node/model/follow.ts · FollowModel', callee: 'model-interaction', observation: [invocationRecording()], checkpoint: { key: 'observer.follow-model', version: 1, input: followInputCodec, output: modelFeedbackCodec, points: [this.waitingPoint, this.resultPoint] }, run: { requires: { modelReader: ModelResource.read.request() }, execute: this.execute.bind(this) } });
  }

  private execute(work: NodeWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    work.checkpoint?.save(this.waitingPoint, work.input, {});
    return this.receive(work);
  }
  private async receive(work: NodeWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    const output = await work.resources.modelReader.result(work.input, { signal: work.signal, expected: work.input.expected });
    work.checkpoint?.save(this.resultPoint, output, {});
    return output;
  }
}
