import { type Stable, RuntimeError } from '@weiliang0121/capix-contracts';
import type { SyncViewSource } from '@weiliang0121/capix-view';
import type { Memories } from './memories.js';
import type { MemoryItem } from './memory.js';

type MemoryViewContract<Metadata> = SyncViewSource<string, undefined, Stable<MemoryItem<Metadata>>>;
type SourceStamp = Parameters<MemoryViewContract<never>['read']>[1];

/** A complete directory of one memory collection, or of an explicitly fixed ordered subset. */
export class MemoryViewSource<Metadata = never> implements MemoryViewContract<Metadata> {
  readonly id: string;
  readonly scope: string;
  readonly #memories: Memories<Metadata>;
  readonly #keys?: readonly string[];
  readonly #allowed?: ReadonlySet<string>;

  constructor(memories: Memories<Metadata>, keys?: readonly string[]) {
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

  index(): ReturnType<MemoryViewContract<Metadata>['index']> {
    const stamp = this.stamp();
    const keys = this.#keys ?? this.#memories.values().map((memory) => memory.id);
    const entries = Object.freeze(keys.map((key) => Object.freeze({ key, summary: this.summary(key) })));
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  inspect(keys: readonly string[]): ReturnType<MemoryViewContract<Metadata>['inspect']> {
    const stamp = this.stamp();
    const selected = this.acceptKeys(keys);
    const entries = Object.freeze(
      selected.map((key) => {
        if (this.#allowed && !this.#allowed.has(key)) throw new RangeError('Memory is outside the view source scope');
        return Object.freeze({ key, summary: this.summary(key) });
      }),
    );
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  read(keys: readonly string[], expected: SourceStamp): ReturnType<MemoryViewContract<Metadata>['read']> {
    const basis = Object.freeze({ id: expected.id, scope: expected.scope, version: expected.version });
    this.requireCurrent(basis);
    const selected = this.acceptKeys(keys);
    const entries = Object.freeze(
      selected.map((key) => {
        if (this.#allowed && !this.#allowed.has(key)) throw new RangeError('Memory is outside the view source scope');
        return Object.freeze({ key, value: this.requireMemory(key) });
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

  private summary(key: string): undefined {
    this.requireMemory(key);
    return undefined;
  }

  private requireMemory(key: string): Stable<MemoryItem<Metadata>> {
    const memory = this.#memories.read(key);
    if (!memory) throw new RangeError('Memory view member does not exist');
    return Object.freeze({ id: memory.id, value: memory.value });
  }
}
