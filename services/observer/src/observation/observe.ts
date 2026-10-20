import type { ExecutionRecordSnapshot } from '@capix/protocol';
import type { RecordingInstallation } from '@capix/server-runtime/recording';

import { InvocationBoundaryRecord } from '@capix/server-runtime/recording';
import { callRecord, isTaskRecord, recordSubtree, taskSnapshot } from './calls.js';

import type { Driver } from '@capix/server-runtime';
import type { ConversationRunOptions, ConversationScene } from '../conversation/binding.js';

/** Observe one invocation by Context identity, independent of its input value. */
export async function observeExecution(driver: Driver, scene: ConversationScene, recording: RecordingInstallation, input: unknown, options: ConversationRunOptions, publish: (snapshot: ExecutionRecordSnapshot) => void = () => {}): Promise<ExecutionRecordSnapshot> {
  let contextId: string | undefined;
  let latest: ExecutionRecordSnapshot | undefined;
  const unsubscribe = subscribeExecutions(recording, (snapshot) => {
    if (snapshot.execution.contextId !== contextId) return;
    latest = snapshot;
    publish(snapshot);
  });
  try {
    try {
      await driver.run(scene, input, {
        ...options,
        executionCallbacks: {
          started: (context) => {
            contextId = context.id;
          },
        },
      });
    } catch (error) {
      if (latest?.execution.status !== 'failed' || !latest.boundaries.some((event) => event.callId === latest!.execution.id && event.value.type === 'throw')) throw error;
    }
    if (!latest || latest.execution.status === 'running') throw new Error('Execution observation is incomplete');
    return taskSnapshot(recording.recorder.book, latest.execution.id);
  } finally {
    unsubscribe();
  }
}

/** Observer projection: boundary events and running call updates retain the existing snapshot cadence. */
export function subscribeExecutions(recording: RecordingInstallation, publish: (snapshot: ExecutionRecordSnapshot) => void): () => void {
  return recording.recorder.subscribe((record, change) => {
    const call = callRecord(record);
    if (!(record instanceof InvocationBoundaryRecord) && !(change === 'update' && call?.status === 'running')) return;
    const owner = record instanceof InvocationBoundaryRecord ? recording.recorder.book.get(record.callId) : record;
    if (!owner) return;
    const book = recording.recorder.book;
    const ids = new Set(
      recordSubtree(book, owner)
        .filter(isTaskRecord)
        .map((record) => record.id),
    );
    const visited = new Set<string>();
    let ancestor = owner.parentId ? book.get(owner.parentId) : undefined;
    while (ancestor) {
      if (visited.has(ancestor.id)) throw new Error('Recorded task ancestry contains a cycle');
      visited.add(ancestor.id);
      if (isTaskRecord(ancestor)) ids.add(ancestor.id);
      ancestor = ancestor.parentId ? book.get(ancestor.parentId) : undefined;
    }
    // Ancestor delivery changes refresh its real task descendants, including post-task scene acceptance.
    for (const id of ids) {
      if (recording.recorder.tree.root(id) !== recording.root) continue;
      publish(taskSnapshot(recording.recorder.book, id));
    }
  });
}
