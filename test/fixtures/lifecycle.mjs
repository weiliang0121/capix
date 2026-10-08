import { contextWithSource, captureSource } from './observer.mjs';
import { Invocation, InvocationChildren, writeRecord, ExecutionContext, OperationContext, AttemptContext, ExecutionRecordHelper, OperationRecordHelper, AttemptRecordHelper } from '@capix-observer/runtime';

// Test-only lookup for legacy manual-boundary fixtures, never part of the runtime.
const calls = new WeakMap();
const origins = new WeakMap();
export function rememberCall(invocation) {
  calls.set(invocation.context, invocation);
  return invocation;
}
export function callFor(context) {
  const invocation = calls.get(context);
  if (!invocation) throw new Error('Test fixture has not captured this invocation');
  return invocation;
}
export function recordFor(context) {
  return callFor(context).record;
}

// Manual context boundaries for record tests; actual work always uses production Invocation.
export function lifecycleFor(runtime) {
  const recording = runtime.recording;
  return {
    execution(request) {
      return invocationLifecycle(() => contextWithSource(request.input, request), recording ? ExecutionRecordHelper.recording(recording, captureSource(request)) : undefined);
    },
    operation(execution, operation, input, parent) {
      if (parent && origins.get(parent) !== execution) throw new Error('Parent operation belongs to another execution');
      return invocationLifecycle(
        () => {
          execution.requireRunning();
          parent?.requireRunning();
          const context = new OperationContext(parent ?? execution, input);
          origins.set(context, execution);
          return context;
        },
        recording ? OperationRecordHelper.recording(recording, operation, callFor(parent ?? execution)) : undefined,
      );
    },
    attempt(operation, attempt, input) {
      return invocationLifecycle(
        () => {
          operation.requireActive();
          return new AttemptContext(operation, input);
        },
        recording ? AttemptRecordHelper.recording(recording, attempt, callFor(operation)) : undefined,
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
        const invocation = rememberCall({ context, children: new InvocationChildren(context), record: undefined });
        writeRecord(() =>
          recording?.begin(context, (record) => {
            invocation.record = record;
          }),
        );
      } catch (error) {
        context.fail(error);
        throw error;
      }
      return context;
    },
    succeed(context, output) {
      context.complete(output);
      writeRecord(() => recording?.finish(context, recordFor(context)));
    },
    fail(context, error) {
      context.fail(error);
      writeRecord(() => recording?.finish(context, recordFor(context)));
    },
  };
}

export async function invoke(lifecycle, execute) {
  return rememberCall(new Invocation({ context: lifecycle.prepare(), work: { execute, maxRounds: 1 }, signal: new AbortController().signal, recording: lifecycle.recording })).run();
}
