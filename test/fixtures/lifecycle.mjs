import { Invocation, writeRecord, ExecutionContext, OperationContext, AttemptContext, ExecutionRecordHelper, OperationRecordHelper, AttemptRecordHelper } from '@capix-observer/runtime';

// Manual context boundaries for record tests; actual work always uses production Invocation.
export function lifecycleFor(runtime) {
  const recording = runtime.recording;
  return {
    execution(request) {
      return invocationLifecycle(() => new ExecutionContext(request.input, request), recording ? ExecutionRecordHelper.recording(recording) : undefined);
    },
    operation(execution, operation, input, parent) {
      return invocationLifecycle(
        () => {
          execution.requireRunning();
          parent?.requireRunning();
          if (parent && parent.executionContext !== execution) throw new Error('Parent operation belongs to another execution');
          return new OperationContext(execution, input);
        },
        recording ? OperationRecordHelper.recording(recording, operation, parent) : undefined,
      );
    },
    attempt(operation, attempt, input) {
      return invocationLifecycle(
        () => {
          operation.requireRunning();
          operation.executionContext.requireRunning();
          return new AttemptContext(operation, input);
        },
        recording ? AttemptRecordHelper.recording(recording, attempt) : undefined,
      );
    },
  };
}

function invocationLifecycle(prepare, recording) {
  return {
    prepare,
    recording,
    begin() {
      const context = prepare();
      try {
        writeRecord(() => recording?.begin(context));
      } catch (error) {
        context.fail(error);
        throw error;
      }
      return context;
    },
    succeed(context, output) {
      context.complete(output);
      writeRecord(() => recording?.finish(context));
    },
    fail(context, error) {
      context.fail(error);
      writeRecord(() => recording?.finish(context));
    },
  };
}

export function invoke(lifecycle, execute) {
  return new Invocation(lifecycle.prepare, { execute, maxRounds: 1 }, new AbortController().signal, lifecycle.recording).run();
}
