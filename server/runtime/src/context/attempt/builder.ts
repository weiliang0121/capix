import type { ResourceBindings } from '../../resource/bindings.js';
import { AttemptContext } from '../attempt.js';
import type { OperationContext } from '../operation.js';
import type { OperationContextBuilder } from '../operation/builder.js';

export class AttemptContextBuilder {
  constructor(private readonly operationContextBuilder: OperationContextBuilder) {}

  create<Input, Output, Resources extends object = object>(parentContext: OperationContext, input: Input, resources?: ResourceBindings<Resources>): AttemptContext<Input, Output, Resources> {
    this.check(parentContext);
    return new AttemptContext(parentContext, input, resources);
  }

  check(parentContext: OperationContext): void {
    this.operationContextBuilder.requireActive(parentContext);
  }
}
