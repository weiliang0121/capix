import type { RuntimeRecord } from '../record.js';

/** Owns record instances; knows no record kinds, lifecycle or execution functions. */
export class RecordBook {
  readonly #records = new Map<string, RuntimeRecord<unknown>>();
  add<R extends RuntimeRecord<unknown>>(record: R): R {
    if (this.#records.has(record.id)) throw new Error('Record ID already exists');
    this.#records.set(record.id, record);
    return record;
  }
  get(id: string): RuntimeRecord<unknown> | undefined {
    return this.#records.get(id);
  }
  values(): IterableIterator<RuntimeRecord<unknown>> {
    return this.#records.values();
  }
}
