import type { InteractionChannel } from '@capix/interaction';
import type { ModelRequest, ModelReply } from '@capix/model-provider';
import { ModelExchangeResource, type ModelExchanges } from '@capix/model-exchanges';
import { Resources } from '@capix/server-runtime';
import { ToolModelResource, type ToolInteractionRecovery } from './model.js';
import { ToolLoop } from './loop.js';
import type { ToolRequestInspection } from './budget.js';

/** The host owns the entities and channel; capture reconstructs only original input. */
export function registerToolLoopResources(resources: Resources, loop: ToolLoop, exchanges: ModelExchanges, channel: InteractionChannel<ModelRequest, ModelReply, string>, recovery?: ToolInteractionRecovery, inspection?: ToolRequestInspection): void {
  if (loop.recoverable && (!recovery || typeof recovery.read !== 'function')) throw new TypeError('Recoverable ToolLoop requires an interaction recovery reader');
  const fixedRecovery = recovery ? Object.freeze({ read: recovery.read.bind(recovery) }) : undefined;
  const fixedInspection = inspection ? Object.freeze({ inspectRequest: inspection.inspectRequest.bind(inspection) }) : undefined;
  resources
    .capture(loop, (input) => {
      const checked = loop.checkInput(input);
      if (checked.collection !== undefined && checked.collection !== exchanges.id) throw new Error('ToolLoop collection differs from its fixed resource');
      return loop.input(checked.request, checked.scope, checked.collection);
    })
    .register(ModelExchangeResource, (input) => ({ exchanges, scope: input.scope }))
    .register(ToolModelResource, (input) => ({ channel, exchanges, input, catalog: loop.catalog, recovery: fixedRecovery, inspection: fixedInspection }));
}
