import type { ExecutionInvocationBuilder, ExecutionInvocationRequest } from '../invocation/execution/builder.js';

/** Fixed execution structure; binding supplies content, environment, and per-call controls. */
export class Execution<I, O, R extends object = object> {
  constructor(private readonly invocations: ExecutionInvocationBuilder) {}
  submit(accept: () => I, request: ExecutionInvocationRequest<I, O, R>): Promise<O> {
    return this.invocations.submit(accept, request);
  }
}
