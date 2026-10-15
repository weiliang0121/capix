import { RuntimeContextBuilder } from '../../context/builders/runtime.js';
import { ExecutionContextBuilder } from '../../context/builders/execution.js';
import { OperationContextBuilder } from '../../context/builders/operation.js';
import { AttemptContextBuilder } from '../../context/builders/attempt.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { RuntimeInvocationBuilder } from './runtime.js';
import { ExecutionInvocationBuilder } from './execution.js';
import { OperationInvocationBuilder } from './operation.js';
import { AttemptInvocationBuilder } from './attempt.js';

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
