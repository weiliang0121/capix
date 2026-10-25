import { modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix/resources';
import type { ModelRequestResources } from '../../resources.js';
import { cloneCheckpointValue } from '@capix/server-runtime';
import { Node, checkpointPoint, type CheckpointValue } from '@capix/structure';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequest<Input, Resources extends ModelRequestResources = ModelRequestResources> extends Node<Input, ModelRequest, Resources> {
  static readonly deps = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

  constructor(createRequest: (input: Input, resources: Resources) => ModelRequest, deps: ResourceRequirements<Resources> = PrepareModelRequest.deps as ResourceRequirements<Resources>) {
    const resultPoint = checkpointPoint<'node', Input, ModelRequest>()({ name: 'result', state: modelRequestCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, output) => output } });
    super();
    this.deps = deps;
    this.run = (work) => {
      const request = createRequest(work.input, work.resources);
      checkCapacity(request, work.resources.settings);
      work.checkpoint?.({ point: resultPoint, state: request, refs: {} });
      return request;
    };
    this.checkpoint = { key: 'observer.prepare-model-request', version: 1, input: { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Input }, output: modelRequestCodec, points: [resultPoint] };
    this.name = 'prepareModelRequest';
    this.label = '准备模型请求';
    this.source = 'services/observer/src/conversation/node/model/prepare.ts · PrepareModelRequest';
  }
}
