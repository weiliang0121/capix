import type { Recorder } from '../recorder.js';
import type { CallRecord } from './record.js';

/** Result registration is shared by concrete record writers, not by invocation execution. */
export class InvocationRecordHelper {
  static finish(recorder: Recorder, record: CallRecord, apply: (record: CallRecord) => void): void {
    recorder.update(record, apply, (record) => ({ kind: 'finished', id: record.id, status: record.status as 'succeeded' | 'failed', result: { ...(Object.hasOwn(record.value, 'output') ? { output: record.value.output } : {}), ...(Object.hasOwn(record.value, 'resultOf') ? { resultOf: record.value.resultOf } : {}), ...(record.value.error ? { error: record.value.error } : {}), ...(record.value.failure ? { failure: record.value.failure } : {}) } }));
  }
}
