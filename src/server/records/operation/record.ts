import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { OperationRecord as OperationData, OperationValue } from '../../../shared/records.js';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export type OperationRecordDefinition = Omit<OperationData, 'id' | 'value' | 'status'>;
export class OperationRecord extends RuntimeRecord<OperationValue> implements OperationData {
  #status: OperationData['status'] = 'running';
  get status(): OperationData['status'] {
    return this.#status;
  }
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
    super(snapshotValue({ input }));
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
  private requireRunning() {
    if (this.#status !== 'running') throw new Error('Record has already ended');
  }
  complete(output: unknown) {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, output: snapshotValue(output) }));
    this.#status = 'succeeded';
  }
  fail(error: RuntimeErrorValue) {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, error: snapshotValue(error) }));
    this.#status = 'failed';
  }
  override toJSON(): OperationData {
    return {
      ...super.toJSON(),
      status: this.status,
      contextId: this.contextId,
      executionId: this.executionId,
      operationInstanceId: this.operationInstanceId,
      ...(this.parentOperationId ? { parentOperationId: this.parentOperationId } : {}),
      operation: this.operation,
      label: this.label,
      source: this.source,
      caller: this.caller,
      callee: this.callee,
    };
  }
}
