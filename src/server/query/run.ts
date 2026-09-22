import { MessageRef } from '../transcript/ref.js';
import type { ModelSettings } from '../../shared/types.js';
import type { RuntimeSnapshot } from '../../shared/records.js';
import type { ModelProvider } from '../provider.js';
import { Clock } from '../runtime/clock.js';
import { RecordBook, RecordIndex, type OperationRecord, type AttemptRecord } from '../records/index.js';
import { RuntimeRecorder } from '../records/recorder.js';
import { Runtime } from '../runtime/runtime.js';
import { QueryExecution } from './execution.js';

/** Request assembly and observation response. Work composition belongs to QueryExecution. */
export async function runQuery(query: MessageRef, settings: ModelSettings, provider: ModelProvider, publish: (snapshot: RuntimeSnapshot) => void = () => {}, signal = new AbortController().signal): Promise<RuntimeSnapshot> {
  if (!(query instanceof MessageRef) || query.read().role !== 'user') throw new TypeError('Execution requires a user query reference');
  let latest: RuntimeSnapshot | undefined;
  const recorder = new RuntimeRecorder(new RecordBook(), new RecordIndex<OperationRecord>((record) => record.executionId), new RecordIndex<AttemptRecord>((record) => record.operationId), new Clock(), (snapshot) => {
    latest = snapshot;
    publish(snapshot);
  });
  const execution = new QueryExecution(new Runtime(recorder), provider);
  try {
    await execution.call(query, { settings, signal, transcript: query.transcript });
  } catch (error) {
    // Return a recorded work failure; an incomplete observation is not a completed response.
    if (latest?.execution.status !== 'failed' || latest.events.at(-1)?.callId !== latest.execution.id || latest.events.at(-1)?.type !== 'throw') throw error;
  }
  if (!latest || latest.execution.status === 'running') throw new Error('Execution observation is incomplete');
  return latest;
}
