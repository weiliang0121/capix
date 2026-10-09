import { ExecutionContext } from '../execution.js';
import type { ResourceBindings } from '../../resource/bindings.js';
import type { RuntimeContext } from '../runtime.js';
import type { RuntimeContextBuilder } from '../runtime/builder.js';

/** Constructs this Runtime's contexts from already established per-call conditions. */
export class ExecutionContextBuilder {
  constructor(private readonly runtimes: RuntimeContextBuilder) {}
  create<I, O, R extends object = object>(parent: RuntimeContext, input: I, resources?: ResourceBindings<R>): ExecutionContext<I, O, R> {
    this.check(parent);
    return new ExecutionContext(input, { signal: parent.signal }, this, resources, parent);
  }
  check(parent: RuntimeContext): void {
    this.runtimes.requireActive(parent);
  }
  requireActive(context: ExecutionContext): void {
    context.requireActive();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
