import { AttemptContext } from '../attempt.js';
import type { OperationContext } from '../operation.js';
import type { OperationContextBuilder } from '../operation/builder.js';

export class AttemptContextBuilder {
  constructor(private readonly operations: OperationContextBuilder) {}

  create<I, O>(operation: OperationContext, input: I): AttemptContext<I, O> {
    this.check(operation);
    return new AttemptContext(operation, input);
  }

  check(operation: OperationContext): void {
    this.operations.requireActive(operation);
  }
}
