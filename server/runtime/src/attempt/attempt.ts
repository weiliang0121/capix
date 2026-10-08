import type { Invocation } from '../invocation/invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptInvocationBuilder, AttemptInvocationRequest } from '../invocation/attempt/builder.js';

/** Fixed leaf structure; a binding supplies this call's content and requirements. */
export class Attempt<I, O, R extends object = object> {
  constructor(private readonly invocations: AttemptInvocationBuilder) {}
  create(parent: Invocation<unknown, unknown, OperationContext>, request: AttemptInvocationRequest<I, O, R>) {
    return this.invocations.create<I, O, R>(parent, request);
  }
}
