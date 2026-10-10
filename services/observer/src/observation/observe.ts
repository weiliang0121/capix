import type { ExecutionRecordSnapshot } from '@capix/protocol';
import type { RecordingInstallation } from '@capix/server-runtime/recording';

import { InvocationBoundaryRecord, ExecutionRecord, OperationRecord, AttemptRecord, ExecutionRecordHelper } from '@capix/server-runtime/recording';

import type { ConversationRunOptions, BoundConversationRuntime } from '../conversation/binding.js';

/** Observe one invocation by Context identity, independent of its input value. */
export async function observeExecution(runtime: BoundConversationRuntime, recording: RecordingInstallation, input: unknown, options: ConversationRunOptions, publish: (snapshot: ExecutionRecordSnapshot) => void = () => {}): Promise<ExecutionRecordSnapshot> {
  let contextId: string | undefined;
  let latest: ExecutionRecordSnapshot | undefined;
  const unsubscribe = subscribeExecutions(recording, (snapshot) => {
    if (snapshot.execution.contextId !== contextId) return;
    latest = snapshot;
    publish(snapshot);
  });
  try {
    try {
      await runtime.run(input, {
        ...options,
        executionCallbacks: {
          started: (context) => {
            contextId = context.id;
          },
        },
      });
    } catch (error) {
      if (latest?.execution.status !== 'failed' || latest.events.at(-1)?.callId !== latest.execution.id || latest.events.at(-1)?.value.type !== 'throw') throw error;
    }
    if (!latest || latest.execution.status === 'running') throw new Error('Execution observation is incomplete');
    return ExecutionRecordHelper.snapshot(recording.recorder, latest.execution.id);
  } finally {
    unsubscribe();
  }
}

/** Observer projection: boundary events and running call updates retain the existing snapshot cadence. */
export function subscribeExecutions(recording: RecordingInstallation, publish: (snapshot: ExecutionRecordSnapshot) => void): () => void {
  return recording.recorder.subscribe((record, change) => {
    let executionId: string | undefined;
    if (record instanceof InvocationBoundaryRecord) executionId = record.executionId;
    else if (change === 'update' && (record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord) && record.status === 'running') executionId = record instanceof ExecutionRecord ? record.id : record instanceof OperationRecord ? record.executionId : (recording.recorder.book.get(record.operationId) as OperationRecord).executionId;
    else return;
    // A shared Recorder may contain another Runtime's calls; this projection owns only this scope.
    if (!executionId || recording.recorder.tree.root(executionId) !== recording.root) return;
    publish(ExecutionRecordHelper.snapshot(recording.recorder, executionId));
  });
}
