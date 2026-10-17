import { isEqual } from 'es-toolkit/predicate';
import { AttemptDefinition, checkpointPoint, type AttemptWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ModelResource } from '../../model/resources.js';
import type { ModelInteractionReader, ModelInteractionRef, ModelInteractionExpectation } from '../../model/interactions.js';
import type { ModelOutput } from '../../model/types.js';
import { followInputCodec, modelFeedbackCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../operations/checkpoint.js';

interface FollowModelResources {
  readonly modelReader: ModelInteractionReader;
}
export interface FollowModelInput extends ModelInteractionRef {
  readonly expected: ModelInteractionExpectation;
}

/** No creator resource: this A can only receive the existing exchange's retained feedback. */
export class FollowModelDefinition extends AttemptDefinition<FollowModelInput, ModelOutput, FollowModelResources> {
  readonly name = 'followModel';
  readonly label = '等待模型反馈';
  readonly source = 'services/observer/src/conversation/attempt/model/follow.ts · FollowModelDefinition';
  readonly callee = 'model-interaction';
  readonly observation = [invocationRecording()];
  private readonly waitingPoint = checkpointPoint<'attempt', FollowModelInput, ModelOutput>()({
    name: 'waiting',
    state: followInputCodec,
    references: {},
    check: (state, facts) => {
      checkLeafResult(facts);
      if (!isEqual(facts.input, state)) throw new Error('Follow checkpoint changed interaction');
    },
    resume: { requires: { modelReader: ModelResource.read.request() }, execute: (work) => this.receive(work) },
  });
  private readonly resultPoint = checkpointPoint<'attempt', FollowModelInput, ModelOutput>()({ name: 'result', state: modelFeedbackCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  readonly checkpoint: InvocationCheckpointDefinition<FollowModelInput, ModelOutput, 'attempt'> = { key: 'observer.follow-model', version: 1, input: followInputCodec, output: modelFeedbackCodec, points: [this.waitingPoint, this.resultPoint] };
  readonly run = { requires: { modelReader: ModelResource.read.request() }, execute: this.execute.bind(this) };

  private execute(work: AttemptWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    work.checkpoint?.save(this.waitingPoint, work.input, {});
    return this.receive(work);
  }
  private async receive(work: AttemptWork<FollowModelInput, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    const output = await work.resources.modelReader.result(work.input, { signal: work.signal, expected: work.input.expected });
    work.checkpoint?.save(this.resultPoint, output, {});
    return output;
  }
}
