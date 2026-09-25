import type { ExecutionRecord as ExecutionData, ExecutionValue } from '../../../shared/records.js';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export class ExecutionRecord extends InvocationRecord<ExecutionValue> implements ExecutionData {
  constructor(
    readonly contextId: string,
    value: Omit<ExecutionValue, 'processes'>,
  ) {
    super(snapshotValue({ ...value, processes: [] }));
    Object.freeze(this);
  }
  override toJSON(): ExecutionData {
    return { ...super.toJSON(), contextId: this.contextId, status: this.status };
  }
}
