import { Invocation, writeRecord, ExecutionContext, OperationContext, AttemptContext } from '@capix-observer/runtime';

// Explicit low-level fixture for recorder tests; production E/O/A create their own Invocations.
export function lifecycleFor(runtime) {
  const recorder = runtime.recorder;
  return {
    execution(request) {
      return invocationLifecycle(
        () => new ExecutionContext(request.input, request),
        recorder,
        (context) => recorder?.beginExecution(context),
      );
    },
    operation(execution, operation, input, parent) {
      return invocationLifecycle(
        () => {
          execution.requireRunning();
          parent?.requireRunning();
          if (parent && parent.executionContext !== execution) throw new Error('Parent operation belongs to another execution');
          return new OperationContext(execution, input);
        },
        recorder,
        (context) => recorder?.beginOperation(context, operation, parent),
      );
    },
    attempt(operation, attempt, input) {
      return invocationLifecycle(
        () => {
          operation.requireRunning();
          operation.executionContext.requireRunning();
          return new AttemptContext(operation, input);
        },
        recorder,
        (context) => recorder?.beginAttempt(context, attempt),
      );
    },
  };
}

function invocationLifecycle(prepare, recorder, register) {
  return {
    prepare,
    recorder,
    register,
    begin() {
      const context = prepare();
      try {
        writeRecord(() => register(context));
      } catch (error) {
        context.fail(error);
        throw error;
      }
      return context;
    },
    succeed(context, output) {
      context.complete(output);
      writeRecord(() => recorder?.finish(context));
    },
    fail(context, error) {
      context.fail(error);
      writeRecord(() => recorder?.finish(context));
    },
  };
}

// Tests that execute work use the production Invocation, including its process records.
export function invoke(lifecycle, execute) {
  return new Invocation(lifecycle.prepare, { execute, maxRounds: 1 }, new AbortController().signal, lifecycle.recorder, lifecycle.register).run();
}
