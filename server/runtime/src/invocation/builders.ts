import { RuntimeContextBuilder } from '../context/runtime/builder.js';
import { ExecutionContextBuilder } from '../context/execution/builder.js';
import { OperationContextBuilder } from '../context/operation/builder.js';
import { AttemptContextBuilder } from '../context/attempt/builder.js';
import type { InvocationCapabilities } from './capabilities.js';
import { RuntimeInvocationBuilder } from './runtime/builder.js';
import { ExecutionInvocationBuilder } from './execution/builder.js';
import { OperationInvocationBuilder } from './operation/builder.js';
import { AttemptInvocationBuilder } from './attempt/builder.js';

/** Assemble one R's reusable construction chain without retaining any call state. */
export function createInvocationBuilders(capabilities: InvocationCapabilities = {}) {
  const runtimeContext = new RuntimeContextBuilder();
  const executionContext = new ExecutionContextBuilder(runtimeContext);
  const operationContext = new OperationContextBuilder(executionContext);
  const attemptContext = new AttemptContextBuilder(operationContext);
  return {
    runtime: new RuntimeInvocationBuilder(runtimeContext, capabilities),
    execution: new ExecutionInvocationBuilder(executionContext, capabilities),
    operation: new OperationInvocationBuilder(operationContext, capabilities),
    attempt: new AttemptInvocationBuilder(attemptContext, capabilities),
  };
}
