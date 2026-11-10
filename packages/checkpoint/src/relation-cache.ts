import type { CheckpointStoredChild } from './incremental.js';
import { decodeCheckpointRecord } from './storage-record.js';

export interface CheckpointRelationRow {
  readonly child_id: unknown;
  readonly ordinal: unknown;
  readonly body: unknown;
}

type Entry = {
  readonly owner: string;
  readonly id: string;
  readonly ordinal: unknown;
  readonly body: string;
  readonly value: CheckpointStoredChild;
  readonly bytes: number;
};

/**
 * Derived parsing evidence for one Store/connection. Callers must provide the
 * freshly read SQL row on every use; this is not evidence that a row still exists.
 * Limits charge retained encoded material, not exact JavaScript heap usage.
 */
export class CheckpointRelationCache {
  readonly #owners = new Map<string, Map<string, Entry>>();
  readonly #recent = new Map<Entry, true>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {}) {
    this.#maxEntries = limits.maxEntries ?? 4096;
    this.#maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 0 || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 0) throw new TypeError('Invalid checkpoint relation cache limits');
  }

  decode(owner: string, id: string, row: CheckpointRelationRow | undefined): CheckpointStoredChild | undefined {
    const previous = this.#owners.get(owner)?.get(id);
    if (!row) {
      if (previous) this.#remove(previous);
      return undefined;
    }
    if (row.child_id === id && previous && row.ordinal === previous.ordinal && row.body === previous.body) {
      this.#recent.delete(previous);
      this.#recent.set(previous, true);
      return previous.value;
    }
    if (previous) this.#remove(previous);
    if (row.child_id !== id || typeof row.body !== 'string') throw new Error('Invalid checkpoint relation row');
    const value = decodeCheckpointRecord<CheckpointStoredChild>('child', row.body);
    if (value.child.identity.contextId !== row.child_id || value.child.order !== row.ordinal) throw new Error('Checkpoint relation row identity differs');
    const bytes = 64 + 2 * (owner.length + id.length + row.body.length);
    if (!this.#maxEntries || bytes > this.#maxBytes) return value;
    while (this.#recent.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes) this.#remove(this.#recent.keys().next().value!);
    const entry: Entry = { owner, id, ordinal: row.ordinal, body: row.body, value, bytes };
    let entries = this.#owners.get(owner);
    if (!entries) this.#owners.set(owner, (entries = new Map()));
    entries.set(id, entry);
    this.#recent.set(entry, true);
    this.#bytes += bytes;
    return value;
  }

  forget(owner: string): void {
    const entries = this.#owners.get(owner);
    if (entries) for (const entry of entries.values()) this.#remove(entry);
  }

  clear(): void {
    this.#owners.clear();
    this.#recent.clear();
    this.#bytes = 0;
  }

  #remove(entry: Entry): void {
    const entries = this.#owners.get(entry.owner)!;
    entries.delete(entry.id);
    if (!entries.size) this.#owners.delete(entry.owner);
    this.#recent.delete(entry);
    this.#bytes -= entry.bytes;
  }
}
