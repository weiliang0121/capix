import type { BaseRecord } from '../record.js';
import { removeRegistration } from '../tree/access.js';

/** Owns record instances; knows no record kinds, lifecycle or execution functions. */
export class RecordBook {
  readonly #records = new Map<string, BaseRecord<unknown>>();
  add<R extends BaseRecord<unknown>>(record: R): R {
    if (this.#records.has(record.id)) throw new Error('Record ID already exists');
    this.#records.set(record.id, record);
    return record;
  }
  /** Undo only the instance added by the failed registration. */
  [removeRegistration](record: BaseRecord<unknown>): void {
    if (this.#records.get(record.id) === record) this.#records.delete(record.id);
  }
  get(id: string): BaseRecord<unknown> | undefined {
    return this.#records.get(id);
  }
  values(): IterableIterator<BaseRecord<unknown>> {
    return this.#records.values();
  }
}
