import { randomUUID } from 'node:crypto';
import type { RecordKind, BaseRecord as RecordData } from '@capix/protocol';

/** Identity, direct ownership and body. Snapshot policy belongs to concrete records. */
export abstract class BaseRecord<Value> implements RecordData<Value> {
  readonly kind: RecordKind = 'custom';
  readonly id = randomUUID();
  #value: Value;
  readonly #parentId?: string;
  constructor(value: Value, parentId?: string) {
    this.#parentId = parentId;
    this.#value = value;
  }
  get parentId(): string | undefined {
    return this.#parentId;
  }
  get value(): Value {
    return this.#value;
  }
  protected replaceValue(value: Value) {
    this.#value = value;
  }
  toJSON(): RecordData<Value> {
    return { id: this.id, ...(this.parentId ? { parentId: this.parentId } : {}), value: this.value };
  }
}
