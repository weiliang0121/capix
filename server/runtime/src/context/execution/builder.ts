import { ExecutionContext, type ExecutionOptions } from '../execution.js';
import type { ResourceBindings } from '../../resource/bindings.js';

/** Constructs this Runtime's contexts from already established per-call conditions. */
export class ExecutionContextBuilder {
  create<I, O, R extends object = object>(input: I, options: ExecutionOptions, resources?: ResourceBindings<R>): ExecutionContext<I, O, R> {
    return new ExecutionContext(input, options, this, resources);
  }
  requireActive(context: ExecutionContext): void {
    context.requireRunning();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
