import { pick } from 'es-toolkit/object';
import type { OperationRecord as OperationData, InvocationValue } from '../data/index.js';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export type OperationRecordOptions = Omit<OperationData, 'id' | 'value' | 'status' | 'parentId' | 'childIds'>;
export class OperationRecord extends InvocationRecord<InvocationValue> implements OperationData {
  override readonly kind = 'operation' as const;
  readonly contextId: string;
  readonly executionId: string;
  readonly operationInstanceId: string;
  readonly parentOperationId?: string;
  readonly operation: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;
  constructor(options: OperationRecordOptions, input: unknown) {
    super(snapshotValue({ input, processes: [], relationChanges: [] }), options.parentOperationId ?? options.executionId);
    this.contextId = options.contextId;
    this.executionId = options.executionId;
    this.operationInstanceId = options.operationInstanceId;
    this.parentOperationId = options.parentOperationId;
    this.operation = options.operation;
    this.label = options.label;
    this.source = options.source;
    this.caller = options.caller;
    this.callee = options.callee;
    Object.freeze(this);
  }
  override toJSON(): OperationData {
    return {
      ...super.toJSON(),
      status: this.status,
      ...pick(this, ['contextId', 'executionId', 'operationInstanceId', 'operation', 'label', 'source', 'caller', 'callee']),
      ...(this.parentOperationId ? { parentOperationId: this.parentOperationId } : {}),
    };
  }
}
