import type { InvocationContext } from '../context/context.js';
import type { ResourceBindings } from '../resource/bindings.js';
import type { Invocation } from './invocation.js';

/** Supply capture is shared; call provenance and endpoint realization are not. */
export function attachInvocationResources<Input, Output, Context extends InvocationContext<Input, Output>>(invocation: Invocation<Input, Output, Context>, resources: ResourceBindings): void {
  resources.attach({
    contextId: invocation.context.id,
    nextSequence: () => invocation.nextResourceSequence(),
    validate: () => {
      invocation.requireHealthy();
      invocation.context.requireRunning();
      if ('requireActive' in invocation.context) (invocation.context as { requireActive(): void }).requireActive();
    },
    observation: invocation.observation?.resource,
    transcript: invocation.observation?.transcript,
    memory: invocation.observation?.memory,
    error: (error, allowException) => invocation.reject(error, allowException),
  });
}
