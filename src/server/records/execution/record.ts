import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { ExecutionRecord as ExecutionData, ExecutionValue } from '../../../shared/records.js';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export class ExecutionRecord extends RuntimeRecord<ExecutionValue> implements ExecutionData {
  #status: ExecutionData['status'] = 'running';
  get status(): ExecutionData['status'] {
    return this.#status;
  }
  constructor(
    readonly contextId: string,
    value: ExecutionValue,
  ) {
    super(snapshotValue(value));
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
  override toJSON(): ExecutionData {
    return { ...super.toJSON(), contextId: this.contextId, status: this.status };
  }
}
