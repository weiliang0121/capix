import { randomUUID } from 'node:crypto';
import type { BaseRecord as RecordData } from '@capix-observer/protocol';

/** Identity, direct ownership and body. Snapshot policy belongs to concrete records. */
export abstract class BaseRecord<T> implements RecordData<T> {
  readonly id = randomUUID();
  #value: T;
  readonly #parentId?: string;
  constructor(value: T, parentId?: string) {
    this.#parentId = parentId;
    this.#value = value;
  }
  get parentId(): string | undefined {
    return this.#parentId;
  }
  get value(): T {
    return this.#value;
  }
  protected replaceValue(value: T) {
    this.#value = value;
  }
  toJSON(): RecordData<T> {
    return { id: this.id, ...(this.parentId ? { parentId: this.parentId } : {}), value: this.value };
  }
}
