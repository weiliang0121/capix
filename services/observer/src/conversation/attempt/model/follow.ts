import { isEqual } from 'es-toolkit/predicate';
import { AttemptDefinition, type InvocationWorkView, type InvocationCheckpointDefinition, type AttemptContextView } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<FollowModelInput, ModelOutput, AttemptContextView<FollowModelInput, ModelOutput, FollowModelResources>> = {
    key: 'observer.follow-model',
    version: 1,
    input: followInputCodec,
    output: modelFeedbackCodec,
    points: {
      waiting: {
        state: followInputCodec,
        check: (frame, state) => {
          checkLeafResult(frame);
          if (!isEqual(frame.currentInput, state)) throw new Error('Follow checkpoint changed interaction');
        },
        resume: { requires: { modelReader: ModelResource.read.request() }, uses: [], execute: (context, invocation) => this.receive(context, invocation) },
      },
      result: { state: modelFeedbackCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: ModelOutput) => output } },
    },
  };
  readonly run = { requires: { modelReader: ModelResource.read.request() }, execute: this.execute.bind(this) };

  private execute(context: AttemptContextView<FollowModelInput, ModelOutput, FollowModelResources>, invocation: InvocationWorkView<FollowModelInput, ModelOutput, AttemptContextView<FollowModelInput, ModelOutput, FollowModelResources>>): Promise<ModelOutput> {
    invocation.checkpoint?.save('waiting', context.currentInput);
    return this.receive(context, invocation);
  }
  private async receive(context: AttemptContextView<FollowModelInput, ModelOutput, FollowModelResources>, invocation: InvocationWorkView<FollowModelInput, ModelOutput, AttemptContextView<FollowModelInput, ModelOutput, FollowModelResources>>): Promise<ModelOutput> {
    const output = await context.resources.values.modelReader.result(context.currentInput, { signal: context.signal, expected: context.currentInput.expected });
    invocation.checkpoint?.save('result', output);
    return output;
  }
}
