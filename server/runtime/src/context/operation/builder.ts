import type { ExecutionContext } from '../execution.js';
import { OperationContext } from '../operation.js';
import type { ExecutionContextBuilder } from '../execution/builder.js';

export class OperationContextBuilder {
  constructor(private readonly executions: ExecutionContextBuilder) {}

  create<I, O>(execution: ExecutionContext, input: I, parent?: OperationContext): OperationContext<I, O> {
    this.check(execution, parent);
    return new OperationContext(execution, input);
  }

  check(execution: ExecutionContext, parent?: OperationContext): void {
    this.executions.requireActive(execution);
    if (parent) {
      this.requireActive(parent);
      if (parent.executionContext !== execution) throw new Error('Parent operation belongs to another execution');
    }
  }

  requireActive(context: OperationContext): void {
    context.requireRunning();
    this.executions.requireActive(context.executionContext);
  }
}
