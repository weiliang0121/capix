import { pick } from 'es-toolkit/object';
import type { OperationRecord as OperationData, OperationValue } from '../../../shared/records.js';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export type OperationRecordDefinition = Omit<OperationData, 'id' | 'value' | 'status'>;
export class OperationRecord extends InvocationRecord<OperationValue> implements OperationData {
  readonly contextId: string;
  readonly executionId: string;
  readonly operationInstanceId: string;
  readonly parentOperationId?: string;
  readonly operation: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;
  constructor(definition: OperationRecordDefinition, input: unknown) {
    super(snapshotValue({ input, processes: [] }));
    this.contextId = definition.contextId;
    this.executionId = definition.executionId;
    this.operationInstanceId = definition.operationInstanceId;
    this.parentOperationId = definition.parentOperationId;
    this.operation = definition.operation;
    this.label = definition.label;
    this.source = definition.source;
    this.caller = definition.caller;
    this.callee = definition.callee;
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
