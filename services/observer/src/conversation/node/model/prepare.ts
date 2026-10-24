import { modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource } from '../../model/resources.js';
import type { ResourceRequirements } from '@capix/server-runtime';
import type { ModelRequestResources } from '../../resources.js';
import { Node, checkpointPoint, cloneCheckpointValue, type CheckpointValue } from '@capix/server-runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequest<Input, Resources extends ModelRequestResources = ModelRequestResources> extends Node<Input, ModelRequest, Resources> {
  static readonly deps = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

  constructor(createRequest: (input: Input, resources: Resources) => ModelRequest, deps: ResourceRequirements<Resources> = PrepareModelRequest.deps as ResourceRequirements<Resources>, description: InvocationRecordDescription<Input, ModelRequest> = {}) {
    const resultPoint = checkpointPoint<'node', Input, ModelRequest>()({ name: 'result', state: modelRequestCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, output) => output } });
    super({
      observation: [invocationRecording(description)],
      deps,
      run(work) {
        const request = createRequest(work.input, work.resources);
        checkCapacity(request, work.resources.settings);
        work.checkpoint?.({ point: resultPoint, state: request, refs: {} });
        return request;
      },
      checkpoint: { key: 'observer.prepare-model-request', version: 1, input: { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Input }, output: modelRequestCodec, points: [resultPoint] },
      name: 'prepareModelRequest',
      label: '准备模型请求',
      source: 'services/observer/src/conversation/node/model/prepare.ts · PrepareModelRequest',
      callee: 'processing',
    });
  }
}
