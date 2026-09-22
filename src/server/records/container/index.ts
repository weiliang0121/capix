import type { RuntimeRecord } from '../../../shared/records.js';

/** Derived lookup data only. Call add again to index a record's changed key. */
export class RecordIndex<R extends RuntimeRecord<unknown>> {
  readonly #idsByKey = new Map<string, Set<string>>();
  readonly #keyById = new Map<string, string>();

  constructor(private readonly selector: (record: R) => string) {}

  add(record: R): void {
    // Evaluate before changing either map; a failed selector leaves the index intact.
    const key = this.selector(record);
    if (this.#keyById.get(record.id) === key) return;
    this.remove(record.id);
    let ids = this.#idsByKey.get(key);
    if (!ids) {
      ids = new Set();
      this.#idsByKey.set(key, ids);
    }
    ids.add(record.id);
    this.#keyById.set(record.id, key);
  }

  get(key: string): readonly string[] {
    return [...(this.#idsByKey.get(key) ?? [])];
  }

  remove(recordId: string): boolean {
    const key = this.#keyById.get(recordId);
    if (key === undefined) return false;
    const ids = this.#idsByKey.get(key)!;
    ids.delete(recordId);
    if (ids.size === 0) this.#idsByKey.delete(key);
    this.#keyById.delete(recordId);
    return true;
  }
}
