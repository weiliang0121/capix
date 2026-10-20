import { modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix/server-runtime';
import type { ModelRequestResources } from '../../resources.js';
import { NodeDefinition, checkpointPoint, cloneCheckpointValue, type CheckpointValue, type InvocationCheckpointDefinition, type NodeWork } from '@capix/server-runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequestDefinition<Input, Resources extends ModelRequestResources = ModelRequestResources> extends NodeDefinition<Input, ModelRequest, Resources> {
  readonly observation;
  readonly run;
  private readonly resultPoint = checkpointPoint<'node', Input, ModelRequest>()({ name: 'result', state: modelRequestCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, output) => output } });
  readonly checkpoint: InvocationCheckpointDefinition<Input, ModelRequest, 'node'> = { key: 'observer.prepare-model-request', version: 1, input: { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Input }, output: modelRequestCodec, points: [this.resultPoint] };
  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

  readonly name = 'prepareModelRequest';
  readonly label = '准备模型请求';
  readonly source = 'services/observer/src/conversation/node/model/prepare.ts · PrepareModelRequestDefinition';
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

  private execute(work: NodeWork<Input, ModelRequest, Resources>): ModelRequest {
    const resources = work.resources;
    const request = this.createRequest(work.input, resources);
    checkCapacity(request, resources.settings);
    work.checkpoint?.save(this.resultPoint, request, {});
    return request;
  }
}
