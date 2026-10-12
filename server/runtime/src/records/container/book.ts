import type { BaseRecord } from '../record.js';
import { removeRegistration } from '../tree/access.js';
import type { RecordEntry } from '@capix/protocol';
import { isPlainObject } from 'es-toolkit/predicate';
import { snapshotValue } from '../value/snapshot.js';
import { restoreEntry } from '../restoration/entry.js';
import { checkRestoredTree } from '../restoration/tree.js';
import { sealHistorical } from '../restoration/access.js';

export interface RecordBookState {
  readonly entries: readonly RecordEntry[];
}

/** Owns record instances; knows no record kinds, lifecycle or execution functions. */
export class RecordBook {
  readonly #records = new Map<string, BaseRecord<unknown>>();
  /** Restores immutable historical carriers without registration notifications or fresh facts. */
  static restore(state: RecordBookState): RecordBook {
    if (!isPlainObject(state) || !Array.isArray(state.entries) || Object.keys(state).length !== 1) throw new Error('Invalid stored record book');
    const captured = snapshotValue(state);
    const book = new RecordBook();
    for (const entry of captured.entries) book.add(restoreEntry(entry));
    checkRestoredTree(book);
    for (const record of book.values()) record[sealHistorical]();
    return book;
  }
  exportState(): RecordBookState {
    return snapshotValue({ entries: [...this.#records.values()].map((record) => ({ kind: record.kind, data: record.toJSON() })) });
  }
  add<RecordType extends BaseRecord<unknown>>(record: RecordType): RecordType {
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
