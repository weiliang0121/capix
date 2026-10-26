import { randomUUID } from 'node:crypto';
import type { RecordKind, BaseRecord as RecordData } from '@capix/protocol';
import { restoreContent, sealHistorical } from './restoration/access.js';

/** Identity, direct ownership and body. Snapshot policy belongs to concrete records. */
export abstract class BaseRecord<Value> implements RecordData<Value> {
  readonly kind: RecordKind = 'custom';
  #id: string = randomUUID();
  #historical = false;
  #value: Value;
  readonly #parentId?: string;
  constructor(value: Value, parentId?: string) {
    this.#parentId = parentId;
    this.#value = value;
  }
  get id(): string {
    return this.#id;
  }
  /** Loaded observation facts have no corresponding live invocation to mutate them. */
  get historical(): boolean {
    return this.#historical;
  }
  get parentId(): string | undefined {
    return this.#parentId;
  }
  get value(): Value {
    return this.#value;
  }
  protected replaceValue(value: Value) {
    this.requireWritable();
    this.#value = value;
  }
  protected requireWritable(): void {
    if (this.#historical) throw new Error('Historical record is read-only');
  }
  [restoreContent](id: string, value: Value): void {
    this.requireWritable();
    this.#id = id;
    this.#value = value;
  }
  [sealHistorical](): void {
    this.#historical = true;
    Object.freeze(this);
  }
  toJSON(): RecordData<Value> {
    return { id: this.id, ...(this.parentId ? { parentId: this.parentId } : {}), value: this.value };
  }
}
