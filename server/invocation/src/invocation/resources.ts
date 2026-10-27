import { InvocationResources } from './resource-access.js';
import type { InvocationContext } from '../context/context.js';
import type { ResourceFailurePolicy } from '@capix/resources';
import { isProtectedOperationFailure } from '../operation/failure.js';
import { RuntimeErrorHelper } from '@capix/diagnostics';
import { isInvocationCancelled } from './cancellation.js';
import type { Invocation } from './invocation.js';

export const invocationResourceFailures: ResourceFailurePolicy = Object.freeze({
  isProtected: isProtectedOperationFailure,
  isCancellation: isInvocationCancelled,
  describe: RuntimeErrorHelper.format,
});

/** Supply capture is shared; call provenance and endpoint realization are not. */
export function attachInvocationResources<Input, Output, Context extends InvocationContext<Input, Output> & { readonly signal: AbortSignal }>(invocation: Invocation<Input, Output, Context>, resources: InvocationResources): void {
  resources.attach({
    contextId: invocation.context.id,
    failures: invocationResourceFailures,
    signal: invocation.context.signal,
    round: () => invocation.context.progress.round,
    reception: () => invocation.children.reception,
    nextSequence: () => invocation.nextResourceSequence(),
    validate: () => invocation.requireActive(),
    observation: invocation.observation?.resource,
    transcript: invocation.observation?.transcript,
    memory: invocation.observation?.memory,
    error: (error, allowException) => invocation.reject(error, allowException),
  });
}
