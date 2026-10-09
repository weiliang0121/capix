import { RuntimeContext, type RuntimeCallOptions, type RuntimeExecutionBindings } from '../runtime.js';
import type { ResourceBindings } from '../../resource/bindings.js';

/** Construct fresh R call state without owning Runtime occupancy or referenced entities. */
export class RuntimeContextBuilder {
  create<I, O, R extends object>(input: I, options: RuntimeCallOptions, resources: ResourceBindings<R>, executions?: RuntimeExecutionBindings): RuntimeContext<I, O, R> {
    return new RuntimeContext(input, options, this, resources, executions);
  }
  requireActive(context: RuntimeContext): void {
    context.requireActive();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
