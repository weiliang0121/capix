import type { ExecutionRecord as ExecutionData, ExecutionValue } from '@capix-observer/protocol';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export class ExecutionRecord extends InvocationRecord<ExecutionValue> implements ExecutionData {
  override readonly kind = 'execution' as const;
  constructor(
    readonly contextId: string,
    value: Omit<ExecutionValue, 'processes'>,
    parentId: string,
  ) {
    super(snapshotValue({ ...value, processes: [] }), parentId);
    Object.freeze(this);
  }
  override toJSON(): ExecutionData {
    return { ...super.toJSON(), contextId: this.contextId, status: this.status };
  }
}
