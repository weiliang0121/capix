import { ExecutionContext } from '../execution.js';
import type { ResourceBindings } from '../../resource/bindings.js';
import type { RuntimeContext } from '../runtime.js';
import type { RuntimeContextBuilder } from './runtime.js';

/** Constructs this Runtime's contexts from already established per-call conditions. */
export class ExecutionContextBuilder {
  constructor(private readonly runtimeContextBuilder: RuntimeContextBuilder) {}
  create<Input, Output, Resources extends object = object>(parentContext: RuntimeContext, input: Input, resources?: ResourceBindings<Resources>): ExecutionContext<Input, Output, Resources> {
    this.check(parentContext);
    return new ExecutionContext(input, { signal: parentContext.signal }, this, resources, parentContext);
  }
  check(parentContext: RuntimeContext): void {
    this.runtimeContextBuilder.requireActive(parentContext);
  }
  requireActive(context: ExecutionContext): void {
    context.requireActive();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
