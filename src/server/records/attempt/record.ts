import { pick } from 'es-toolkit/object';
import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { AttemptRecord as AttemptData, AttemptValue } from '../../../shared/records.js';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export type AttemptDefinition = Omit<AttemptData, 'id' | 'value' | 'status'>;

/** Records one named action invocation. Its owner supplies execution and operation instance identity. */
export class AttemptRecord extends RuntimeRecord<AttemptValue> implements AttemptData {
  #status: AttemptData['status'] = 'running';
  get status(): AttemptData['status'] {
    return this.#status;
  }
  readonly contextId: string;
  readonly operationId: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;

  constructor(definition: AttemptDefinition, input: unknown) {
    super(snapshotValue({ input }));
    this.contextId = definition.contextId;
    this.operationId = definition.operationId;
    this.name = definition.name;
    this.label = definition.label;
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
      ...pick(this, ['contextId', 'operationId', 'name', 'label', 'source', 'caller', 'callee']),
    };
  }
}
