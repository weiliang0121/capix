import type { ResourceBindings } from '../../resource/bindings.js';
import { AttemptContext } from '../attempt.js';
import type { OperationContext } from '../operation.js';
import type { OperationContextBuilder } from '../operation/builder.js';

export class AttemptContextBuilder {
  constructor(private readonly operations: OperationContextBuilder) {}

  create<I, O, R extends object = object>(operation: OperationContext, input: I, resources?: ResourceBindings<R>): AttemptContext<I, O, R> {
    this.check(operation);
    return new AttemptContext(operation, input, resources);
  }

  check(operation: OperationContext): void {
    this.operations.requireActive(operation);
  }
}
