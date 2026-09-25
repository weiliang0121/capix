import type { InvocationLifecycle } from '../invocation/lifecycle.js';
import { RuntimeContext } from '../context/context.js';
import { ExecutionContext, type ExecutionOptions } from '../context/execution.js';
import { OperationContext } from '../context/operation.js';
import { AttemptContext } from '../context/attempt.js';
import type { Attempt } from '../attempt/attempt.js';
import type { Operation } from '../operations/operation.js';
import type { RuntimeRecorder } from '../records/recorder.js';
import { cycle, type InvocationWork } from '../invocation/cycle.js';
import { writeRecord } from '../records/error.js';

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

  operation<I, O>(execution: ExecutionContext, operation: Operation<I, O>, input: I, parent?: OperationContext): InvocationLifecycle<OperationContext<I, O>, O> {
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

  attempt<I, O>(operation: OperationContext, attempt: Attempt<I, O>, input: I): InvocationLifecycle<AttemptContext<I, O>, O> {
    return this.lifecycle<I, O, AttemptContext<I, O>>(
      () => {
        operation.executionContext.requireRunning();
        return new AttemptContext<I, O>(operation, input);
      },
      operation,
      (context) => this.recorder?.beginAttempt(context, attempt),
    );
  }

  run<I, O, C extends ExecutionContext<I, O> | OperationContext<I, O> | AttemptContext<I, O>>(context: C, work: InvocationWork<C, I, O>): Promise<O> {
    const execution = this.getExecutionContext(context);
    return cycle(context, work, execution.signal, (process) => writeRecord(() => this.recorder?.process(context, process)));
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
          writeRecord(() => recordStart(context));
        } catch (error) {
          context.fail(error);
          throw error;
        }
        return context;
      },
      succeed: (context, output) => {
        context.complete(output);
        writeRecord(() => this.recorder?.finish(context));
      },
      fail: (context, error) => {
        context.fail(error);
        writeRecord(() => this.recorder?.finish(context));
      },
    };
  }
}
