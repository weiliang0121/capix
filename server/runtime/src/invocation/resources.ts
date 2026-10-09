import type { InvocationContext } from '../context/context.js';
import type { ResourceBindings } from '../resource/bindings.js';
import type { InvocationRecordHelper } from '../records/invocation/helper.js';
import type { Invocation } from './invocation.js';

/** Supply capture is shared; call provenance and endpoint realization are not. */
export function attachInvocationResources<I, O, C extends InvocationContext<I, O>>(invocation: Invocation<I, O, C>, resources: ResourceBindings, recording?: InvocationRecordHelper): void {
  resources.attach({
    contextId: invocation.context.id,
    validate: () => {
      invocation.requireHealthy();
      invocation.context.requireRunning();
      if ('requireActive' in invocation.context) (invocation.context as { requireActive(): void }).requireActive();
    },
    source: () => invocation.source,
    error: (error, allowException) => invocation.reject(error, allowException),
    recording: recording
      ? {
          recorder: recording.recorder,
          parentId: () => {
            const record = invocation.record;
            if (!record) throw new Error('Resource recording requires an established call record');
            return record.id;
          },
        }
      : undefined,
  });
}
