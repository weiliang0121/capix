import { RuntimeError } from '@capix/contracts';
import type { SyncViewSource } from '@capix/view';
import type { Memories } from './memories.js';
import type { Memory } from './memory.js';
import type { MemoryState } from './persistence.js';

export interface MemoryViewSummary {
  readonly topic: string;
}

type MemoryViewContract = SyncViewSource<string, MemoryViewSummary, MemoryState>;
type SourceStamp = Parameters<MemoryViewContract['read']>[1];

/** A complete directory of one memory collection, or of an explicitly fixed ordered subset. */
export class MemoryViewSource implements MemoryViewContract {
  readonly id: string;
  readonly scope: string;
  readonly #memories: Memories;
  readonly #keys?: readonly string[];
  readonly #allowed?: ReadonlySet<string>;

  constructor(memories: Memories, keys?: readonly string[]) {
    this.#memories = memories;
    this.id = memories.id;
    if (keys !== undefined) {
      this.#keys = this.acceptKeys(keys);
      for (const key of this.#keys) this.requireMemory(key);
      this.#allowed = new Set(this.#keys);
    }
    this.scope = this.#keys === undefined ? 'whole' : `keys:${JSON.stringify(this.#keys)}`;
    Object.freeze(this);
  }

  index(): ReturnType<MemoryViewContract['index']> {
    const stamp = this.stamp();
    const keys = this.#keys ?? this.#memories.values().map((memory) => memory.id);
    const entries = Object.freeze(keys.map((key) => Object.freeze({ key, summary: Object.freeze({ topic: this.requireMemory(key).topic }) })));
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  read(keys: readonly string[], expected: SourceStamp): ReturnType<MemoryViewContract['read']> {
    const basis = Object.freeze({ id: expected.id, scope: expected.scope, version: expected.version });
    this.requireCurrent(basis);
    const selected = this.acceptKeys(keys);
    const entries = Object.freeze(
      selected.map((key) => {
        if (this.#allowed && !this.#allowed.has(key)) throw new RangeError('Memory is outside the view source scope');
        return Object.freeze({ key, value: Object.freeze(this.requireMemory(key).toJSON()) });
      }),
    );
    this.requireCurrent(basis);
    return Object.freeze({ stamp: this.stamp(), entries });
  }

  check(expected: SourceStamp): boolean {
    return expected?.id === this.id && expected.scope === this.scope && expected.version === String(this.#memories.sequence);
  }

  private stamp(): SourceStamp {
    return Object.freeze({ id: this.id, scope: this.scope, version: String(this.#memories.sequence) });
  }

  private requireCurrent(expected: SourceStamp): void {
    if (!this.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Memory view source has changed');
  }

  private acceptKeys(keys: readonly string[]): readonly string[] {
    if (!Array.isArray(keys)) throw new TypeError('Memory view keys must be an array');
    const accepted = Array.from(keys);
    if (accepted.some((key) => typeof key !== 'string' || !key) || new Set(accepted).size !== accepted.length) throw new TypeError('Memory view requires unique nonempty string keys');
    return Object.freeze(accepted);
  }

  private requireMemory(key: string): Memory {
    const memory = this.#memories.get(key);
    if (!memory) throw new RangeError('Memory view member does not exist');
    return memory;
  }
}
