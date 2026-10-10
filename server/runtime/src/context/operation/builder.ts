import type { ResourceBindings } from '../../resource/bindings.js';
import type { ExecutionContext } from '../execution.js';
import { OperationContext } from '../operation.js';
import type { ExecutionContextBuilder } from '../execution/builder.js';

export class OperationContextBuilder {
  constructor(private readonly executionContextBuilder: ExecutionContextBuilder) {}

  create<Input, Output, Resources extends object = object>(parentContext: ExecutionContext | OperationContext, input: Input, resources?: ResourceBindings<Resources>): OperationContext<Input, Output, Resources> {
    this.check(parentContext);
    return new OperationContext(parentContext, input, resources);
  }

  check(parentContext: ExecutionContext | OperationContext): void {
    if (parentContext instanceof OperationContext) this.requireActive(parentContext);
    else this.executionContextBuilder.requireActive(parentContext);
  }

  requireActive(context: OperationContext): void {
    context.requireActive();
    if (!context.belongsTo(this.executionContextBuilder)) throw new Error('Call belongs to another Runtime');
  }
}
