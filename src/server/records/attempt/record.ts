import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { AttemptRecord as AttemptData, AttemptValue } from '../../../shared/records.js';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export type AttemptDefinition = Omit<AttemptData, 'id' | 'value' | 'status'>;

/** Records one phase invocation. Its owner supplies execution and operation instance identity. */
export class AttemptRecord extends RuntimeRecord<AttemptValue> implements AttemptData {
  #status: AttemptData['status'] = 'running';
  get status(): AttemptData['status'] {
    return this.#status;
  }
  readonly contextId: string;
  readonly operationId: string;
  readonly phase: AttemptData['phase'];
  readonly source: string;
  readonly caller: string;
  readonly callee: string;

  constructor(definition: AttemptDefinition, input: unknown) {
    super(snapshotValue({ input }));
    this.contextId = definition.contextId;
    this.operationId = definition.operationId;
    this.phase = definition.phase;
    this.source = definition.source;
    this.caller = definition.caller;
    this.callee = definition.callee;
    Object.freeze(this);
  }

  complete(output: unknown): void {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, output: snapshotValue(output) }));
    this.#status = 'succeeded';
  }

  fail(error: RuntimeErrorValue): void {
    this.requireRunning();
    this.replaceValue(Object.freeze({ ...this.value, error: snapshotValue(error) }));
    this.#status = 'failed';
  }

  private requireRunning(): void {
    if (this.#status !== 'running') throw new Error('Record has already ended');
  }

  override toJSON(): AttemptData {
    return {
      ...super.toJSON(),
      status: this.status,
      contextId: this.contextId,
      operationId: this.operationId,
      phase: this.phase,
      source: this.source,
      caller: this.caller,
      callee: this.callee,
    };
  }
}
