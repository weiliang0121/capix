import { isFunction } from 'es-toolkit/predicate';
import type { Message, RuntimeSnapshot } from '@capix-observer/protocol';
import type { ExecutionOptions, RuntimeRecorder } from '@capix-observer/runtime';

import type { ObserverExecution } from './execution.js';

/** Observe one invocation by Context identity, independent of its input value. */
export async function observeExecution(execution: ObserverExecution, recorder: RuntimeRecorder, input: Readonly<Message> | (() => Readonly<Message>), options: ExecutionOptions, publish: (snapshot: RuntimeSnapshot) => void = () => {}): Promise<RuntimeSnapshot> {
  let contextId: string | undefined;
  let latest: RuntimeSnapshot | undefined;
  const unsubscribe = recorder.subscribe((snapshot) => {
    if (snapshot.execution.contextId !== contextId) return;
    latest = snapshot;
    publish(snapshot);
  });
  try {
    try {
      await execution.submit(isFunction(input) ? input : () => input, options, (context) => {
        contextId = context.id;
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
