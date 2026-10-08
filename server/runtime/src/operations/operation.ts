import { randomUUID } from 'node:crypto';
import type { Invocation } from '../invocation/invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { OperationInvocationBuilder, OperationInvocationRequest } from '../invocation/operation/builder.js';
import type { OperationDescription } from '../records/operation/helper.js';

type Request<I, O, R extends object> = Omit<OperationInvocationRequest<I, O, R>, 'description'> & { description: Omit<OperationDescription, 'id'> };

/** Stable runtime identity and construction; contains no business definition or resource source. */
export class Operation<I, O, R extends object = object> {
  readonly id = randomUUID();
  constructor(private readonly invocations: OperationInvocationBuilder) {}
  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, request: Request<I, O, R>) {
    return this.invocations.create<I, O, R>(parent, { ...request, description: { ...request.description, id: this.id } });
  }
}
