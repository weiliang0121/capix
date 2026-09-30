import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { Invocation } from '../invocation/invocation.js';
import { InvocationBehavior } from '../invocation/behavior.js';
import type { AttemptContext } from '../context/attempt.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';

/** The leaf execution boundary. Internal work uses ordinary functions, not child attempts. */
export abstract class Attempt<I, O> extends InvocationBehavior<I, O, AttemptContext<I, O>> {
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;

  constructor(private readonly invocations: AttemptInvocationBuilder) {
    super();
  }

  create(parent: Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    return this.invocations.create<I, O>(parent, { input, description: this, work: this.work, key: options.key });
  }

  async call(parent: Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
