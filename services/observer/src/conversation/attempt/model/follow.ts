import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ModelResource } from '../../model/resources.js';
import type { ModelInteractionReader, ModelInteractionRef } from '../../model/interactions.js';
import type { ModelOutput } from '../../model/types.js';

interface FollowModelResources {
  readonly modelReader: ModelInteractionReader;
}

/** No creator resource: this A can only receive the existing exchange's retained feedback. */
export class FollowModelDefinition extends AttemptDefinition<ModelInteractionRef, ModelOutput, FollowModelResources> {
  readonly name = 'followModel';
  readonly label = '等待模型反馈';
  readonly source = 'services/observer/src/conversation/attempt/model/follow.ts · FollowModelDefinition';
  readonly callee = 'model-interaction';
  readonly observation = [invocationRecording()];
  readonly run = { requires: { modelReader: ModelResource.read.request() }, execute: this.execute.bind(this) };

  private execute(context: AttemptContextView<ModelInteractionRef, ModelOutput, FollowModelResources>): Promise<ModelOutput> {
    return context.resources.values.modelReader.result(context.currentInput, { signal: context.signal });
  }
}
