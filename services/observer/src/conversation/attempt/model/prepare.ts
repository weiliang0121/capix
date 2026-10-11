import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix/server-runtime';
import type { ModelRequestResources } from '../../resources.js';
import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequestDefinition<Input, Resources extends ModelRequestResources = ModelRequestResources> extends AttemptDefinition<Input, ModelRequest, Resources> {
  readonly observation;
  readonly run;
  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

  readonly name = 'prepareModelRequest';
  readonly label = '准备模型请求';
  readonly source = 'services/observer/src/conversation/attempt/model/prepare.ts · PrepareModelRequestDefinition';
  readonly callee = 'processing';

  constructor(
    private readonly createRequest: (input: Input, resources: Resources) => ModelRequest,
    requires: ResourceRequirements<Resources> = PrepareModelRequestDefinition.requires as ResourceRequirements<Resources>,
    description: InvocationRecordDescription<Input, ModelRequest> = {},
  ) {
    super();
    this.observation = [invocationRecording(description)];
    this.run = { requires, execute: this.execute.bind(this) };
  }

  private execute(context: AttemptContextView<Input, ModelRequest, Resources>): ModelRequest {
    const resources = context.resources.values;
    const request = this.createRequest(context.currentInput, resources);
    checkCapacity(request, resources.settings);
    return request;
  }
}
