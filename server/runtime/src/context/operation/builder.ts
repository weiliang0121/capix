import type { ResourceBindings } from '../../resource/bindings.js';
import type { ExecutionContext } from '../execution.js';
import { OperationContext } from '../operation.js';
import type { ExecutionContextBuilder } from '../execution/builder.js';

export class OperationContextBuilder {
  constructor(private readonly executions: ExecutionContextBuilder) {}

  create<I, O, R extends object = object>(parent: ExecutionContext | OperationContext, input: I, resources?: ResourceBindings<R>): OperationContext<I, O, R> {
    this.check(parent);
    return new OperationContext(parent, input, resources);
  }

  check(parent: ExecutionContext | OperationContext): void {
    if (parent instanceof OperationContext) this.requireActive(parent);
    else this.executions.requireActive(parent);
  }

  requireActive(context: OperationContext): void {
    context.requireActive();
    if (!context.belongsTo(this.executions)) throw new Error('Call belongs to another Runtime');
  }
}
