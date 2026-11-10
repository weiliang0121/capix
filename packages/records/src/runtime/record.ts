import type { RuntimeCallRecord as RuntimeCallData, RuntimeCallValue } from '@weiliang0121/capix-protocol';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

/** One R call. Its recording installation root is the direct parent. */
export class RuntimeCallRecord extends InvocationRecord<RuntimeCallValue> implements RuntimeCallData {
  override readonly kind = 'runtime-call' as const;

  constructor(
    readonly contextId: string,
    readonly runtimeInstanceId: string,
    value: Omit<RuntimeCallValue, 'processes' | 'relationChanges'>,
    parentId: string,
  ) {
    super(snapshotValue({ ...value, processes: [], relationChanges: [] }), parentId);
    Object.freeze(this);
  }

  override toJSON(): RuntimeCallData {
    return { ...super.toJSON(), contextId: this.contextId, runtimeInstanceId: this.runtimeInstanceId, status: this.status };
  }
}
