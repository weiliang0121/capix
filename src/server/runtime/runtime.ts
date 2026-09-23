import type { InvocationLifecycle } from '../invocation/lifecycle.js';
import { RuntimeContext } from '../context/context.js';
import { ExecutionContext, type ExecutionOptions } from '../context/execution.js';
import { OperationContext } from '../context/operation.js';
import { AttemptContext, type AttemptPhase } from '../context/attempt.js';
import type { Operation } from '../operations/operation.js';
import type { RuntimeRecorder } from '../records/recorder.js';

/** Coordinates invocation boundaries; Contexts directly hold their required parent references. */
export class Runtime {
  constructor(readonly recorder?: RuntimeRecorder) {}

  execution<I, O>(request: ExecutionOptions & { input: I }, started?: (context: ExecutionContext<I, O>) => void): InvocationLifecycle<ExecutionContext<I, O>, O> {
    return this.lifecycle<I, O, ExecutionContext<I, O>>(
      () => new ExecutionContext(request.input, request),
      undefined,
      (context) => {
        started?.(context);
        this.recorder?.beginExecution(context);
      },
    );
  }

  operation<I, B, C, O>(execution: ExecutionContext, operation: Operation<I, B, C, O>, input: I, parent?: OperationContext): InvocationLifecycle<OperationContext<I, O>, O> {
    return this.lifecycle<I, O, OperationContext<I, O>>(
      () => {
        execution.requireRunning();
        if (parent && parent.executionContext !== execution) throw new Error('Parent operation belongs to another execution');
        return new OperationContext<I, O>(execution, input);
      },
      parent ?? execution,
      (context) => this.recorder?.beginOperation(context, operation, parent),
    );
  }

  attempt<I, O>(operation: OperationContext, phase: AttemptPhase, input: I, source: string, callee: string): InvocationLifecycle<AttemptContext<I, O>, O> {
    return this.lifecycle<I, O, AttemptContext<I, O>>(
      () => {
        operation.executionContext.requireRunning();
        return new AttemptContext<I, O>(operation, phase, input);
      },
      operation,
      (context) => this.recorder?.beginAttempt(context, source, callee),
    );
  }

  /** Read existing Context references; no registration or record lookup is required. */
  getExecutionContext(context: ExecutionContext | OperationContext | AttemptContext): ExecutionContext {
    if (context instanceof ExecutionContext) return context;
    if (context instanceof OperationContext) return context.executionContext;
    return context.operationContext.executionContext;
  }

  getOperationContext(context: AttemptContext): OperationContext {
    return context.operationContext;
  }

  private lifecycle<I, O, C extends RuntimeContext<I, O>>(create: () => C, parent: RuntimeContext | undefined, recordStart: (context: C) => void): InvocationLifecycle<C, O> {
    return {
      begin: () => {
        parent?.requireRunning();
        const context = create();
        try {
          recordStart(context);
        } catch (error) {
          context.fail(error);
          throw error;
        }
        return context;
      },
      succeed: (context, output) => {
        context.complete(output);
        this.recorder?.finish(context);
      },
      fail: (context, error) => {
        context.fail(error);
        this.recorder?.finish(context);
      },
    };
  }
}
