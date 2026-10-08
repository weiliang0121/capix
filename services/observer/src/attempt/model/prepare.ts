import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix-observer/runtime';
import type { ModelRequestResources } from '../../observer/resources.js';
import { AttemptDefinition, type AttemptContext } from '@capix-observer/runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequest<I, R extends ModelRequestResources = ModelRequestResources> extends AttemptDefinition<I, ModelRequest, R> {
  readonly requires: ResourceRequirements<R>;
  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

  readonly name = 'prepareModelRequest';
  readonly label = '准备模型请求';
  readonly source = 'services/observer/src/attempt/model/prepare.ts · PrepareModelRequest';
  readonly callee = 'processing';

  constructor(
    private readonly createRequest: (input: I, resources: R) => ModelRequest,
    requires: ResourceRequirements<R> = PrepareModelRequest.requires as ResourceRequirements<R>,
  ) {
    super();
    this.requires = requires;
  }

  execute(context: AttemptContext<I, ModelRequest, R>): ModelRequest {
    const resources = context.resources.values;
    const request = this.createRequest(context.currentInput, resources);
    checkCapacity(request, resources.settings);
    return request;
  }
}
