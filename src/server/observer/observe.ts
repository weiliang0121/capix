import type { MessageRef } from '../transcript/ref.js';
import type { ExecutionOptions } from '../context/execution.js';
import type { RuntimeSnapshot } from '../../shared/records.js';
import type { RuntimeRecorder } from '../records/recorder.js';
import type { ObserverExecution } from './execution.js';

/** Observe a newly accepted input reference. Each submission has its own reference. */
export async function observeExecution(execution: ObserverExecution, recorder: RuntimeRecorder, input: MessageRef, options: ExecutionOptions, publish: (snapshot: RuntimeSnapshot) => void = () => {}): Promise<RuntimeSnapshot> {
  let latest: RuntimeSnapshot | undefined;
  const unsubscribe = recorder.subscribe((snapshot) => {
    if (snapshot.execution.value.input !== input) return;
    latest = snapshot;
    publish(snapshot);
  });
  try {
    try {
      await execution.call(input, options);
    } catch (error) {
      if (latest?.execution.status !== 'failed' || latest.events.at(-1)?.callId !== latest.execution.id || latest.events.at(-1)?.value.type !== 'throw') throw error;
    }
    if (!latest || latest.execution.status === 'running') throw new Error('Execution observation is incomplete');
    return latest;
  } finally {
    unsubscribe();
  }
}
