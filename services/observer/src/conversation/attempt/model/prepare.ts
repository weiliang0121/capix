import { modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../operations/checkpoint.js';
import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix/server-runtime';
import type { ModelRequestResources } from '../../resources.js';
import { AttemptDefinition, cloneCheckpointValue, type CheckpointValue, type InvocationWorkView, type InvocationCheckpointDefinition, type AttemptContextView } from '@capix/server-runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequestDefinition<Input, Resources extends ModelRequestResources = ModelRequestResources> extends AttemptDefinition<Input, ModelRequest, Resources> {
  readonly observation;
  readonly run;
  readonly checkpoint: InvocationCheckpointDefinition<Input, ModelRequest, AttemptContextView<Input, ModelRequest, Resources>> = {
    key: 'observer.prepare-model-request',
    version: 1,
    input: { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Input },
    output: modelRequestCodec,
    points: { result: { state: modelRequestCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: ModelRequest) => output } } },
  };
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

  private execute(context: AttemptContextView<Input, ModelRequest, Resources>, invocation: InvocationWorkView<Input, ModelRequest, AttemptContextView<Input, ModelRequest, Resources>>): ModelRequest {
    const resources = context.resources.values;
    const request = this.createRequest(context.currentInput, resources);
    checkCapacity(request, resources.settings);
    invocation.checkpoint?.save('result', request);
    return request;
  }
}
