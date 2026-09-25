import { randomUUID } from 'node:crypto';
import type { RuntimeRecord as RecordData } from '@capix-observer/protocol';

/** Identity and body only. Snapshot policy belongs to concrete records. */
export class RuntimeRecord<T> implements RecordData<T> {
  readonly id = randomUUID();
  #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  get value(): T {
    return this.#value;
  }
  protected replaceValue(value: T) {
    this.#value = value;
  }
  toJSON(): RecordData<T> {
    return { id: this.id, value: this.value };
  }
}
