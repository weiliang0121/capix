import type { RuntimeSnapshot } from '@capix-observer/protocol';
import type { InvocationRecordHelper } from '@capix-observer/runtime';

import { InvocationBoundaryRecord, ExecutionRecord, OperationRecord, AttemptRecord, ExecutionRecordHelper } from '@capix-observer/runtime';

import type { ObserverExecutionOptions, ObserverRuntime } from './binding.js';

/** Observe one invocation by Context identity, independent of its input value. */
export async function observeExecution(runtime: ObserverRuntime, recording: InvocationRecordHelper, input: unknown, options: ObserverExecutionOptions, publish: (snapshot: RuntimeSnapshot) => void = () => {}): Promise<RuntimeSnapshot> {
  let contextId: string | undefined;
  let latest: RuntimeSnapshot | undefined;
  const unsubscribe = subscribeExecutions(recording, (snapshot) => {
    if (snapshot.execution.contextId !== contextId) return;
    latest = snapshot;
    publish(snapshot);
  });
  try {
    try {
      await runtime.run(input, options, {
        started: (context) => {
          contextId = context.id;
        },
      });
    } catch (error) {
      if (latest?.execution.status !== 'failed' || latest.events.at(-1)?.callId !== latest.execution.id || latest.events.at(-1)?.value.type !== 'throw') throw error;
    }
    if (!latest || latest.execution.status === 'running') throw new Error('Execution observation is incomplete');
    return latest;
  } finally {
    unsubscribe();
  }
}

/** Observer projection: boundary events and running call updates retain the existing snapshot cadence. */
export function subscribeExecutions(recording: InvocationRecordHelper, publish: (snapshot: RuntimeSnapshot) => void): () => void {
  return recording.recorder.subscribe((record, change) => {
    let executionId: string;
    if (record instanceof InvocationBoundaryRecord) executionId = record.executionId;
    else if (change === 'update' && (record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord) && record.status === 'running') executionId = recording.executionId(record);
    else return;
    // A shared Recorder may contain another Runtime's calls; this projection owns only this scope.
    if (recording.recorder.tree.root(executionId) !== recording.root) return;
    publish(ExecutionRecordHelper.snapshot(recording.recorder, executionId));
  });
}
