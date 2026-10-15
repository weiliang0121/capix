import { RuntimeContext, type ExecutionBindingResolver } from '../runtime.js';
import type { InvocationControls } from '../context.js';
import type { ResourceBindings } from '../../resource/bindings.js';

/** Construct fresh R call state without owning Runtime occupancy or referenced entities. */
export class RuntimeContextBuilder {
  create<Input, Output, Resources extends object>(input: Input, controls: InvocationControls, resources: ResourceBindings<Resources>, executionBindings?: ExecutionBindingResolver): RuntimeContext<Input, Output, Resources> {
    return new RuntimeContext(input, controls, this, resources, executionBindings);
  }
  requireActive(context: RuntimeContext): void {
    context.requireActive();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
