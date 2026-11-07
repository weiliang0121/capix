import { randomUUID } from 'node:crypto';
import type { CheckpointReference, CheckpointSelectionChange, CheckpointSelectionReference, CheckpointSelectionSnapshot } from '@capix/checkpoint';
import type { InvocationCheckpointOccurrence, InvocationCheckpointSelection } from './contract.js';

interface Entry {
  readonly id: string;
  readonly reference: CheckpointReference;
  readonly token: InvocationCheckpointOccurrence;
  order?: number;
  before?: Entry;
  after?: Entry;
  present: boolean;
}

/** Selection bookkeeping belongs to the checkpoint activity, never to a business relation. */
export class CheckpointSelectionState {
  readonly handle: InvocationCheckpointSelection;
  readonly id: string;
  readonly position: number;
  #revision: number;
  #nextOrder: number;
  #length = 0;
  #first?: Entry;
  #last?: Entry;
  #cursor?: { readonly index: number; readonly entry: Entry };
  readonly #tokens = new WeakMap<object, Entry>();
  readonly #appended = new Map<string, Entry>();
  readonly #removed = new Map<string, Entry>();
  #reset: boolean;

  constructor(
    position: number,
    private readonly access: (mutating: boolean) => void,
    private readonly authenticate: (reference: CheckpointReference, position: number) => CheckpointReference,
    private readonly reject: (error: unknown) => void,
    saved?: CheckpointSelectionSnapshot | CheckpointSelectionReference,
    reset = false,
  ) {
    this.position = position;
    this.id = saved?.id ?? randomUUID();
    this.#revision = saved?.revision ?? 0;
    this.#nextOrder = saved && 'nextOrder' in saved ? saved.nextOrder : 0;
    this.#reset = reset;
    if (saved && 'occurrences' in saved && !reset) for (const occurrence of saved.occurrences) this.appendEntry(occurrence.id, occurrence.reference).order = occurrence.order;
    const self = this;
    this.handle = Object.freeze({
      get length() {
        access(false);
        return self.#length;
      },
      at(index: number) {
        access(false);
        return self.entryAt(index)?.reference;
      },
      occurrenceAt(index: number) {
        access(false);
        return self.entryAt(index)?.token;
      },
      add(reference: CheckpointReference) {
        access(true);
        const fixed = authenticate(reference, position);
        return self.append(fixed);
      },
      remove(token: InvocationCheckpointOccurrence) {
        access(true);
        const entry = token && typeof token === 'object' ? self.#tokens.get(token) : undefined;
        if (!entry || !entry.present) {
          const error = new Error('Checkpoint occurrence does not belong to this active selection');
          self.reject(error);
          throw error;
        }
        if (!self.#appended.delete(entry.id)) self.#removed.set(entry.id, entry);
        if (entry.before) entry.before.after = entry.after;
        else self.#first = entry.after;
        if (entry.after) entry.after.before = entry.before;
        else self.#last = entry.before;
        entry.present = false;
        entry.before = undefined;
        entry.after = undefined;
        self.#length--;
        self.#cursor = undefined;
      },
      *[Symbol.iterator]() {
        access(false);
        for (let entry = self.#first; entry; entry = entry.after) {
          access(false);
          yield entry.reference;
        }
      },
    });
  }

  /** Import is explicit and pays for its full array; trusted restore uses saved occurrences instead. */
  import(references: readonly CheckpointReference[]): void {
    for (const reference of references) this.append(this.authenticate(reference, this.position));
  }

  private append(reference: CheckpointReference): InvocationCheckpointOccurrence {
    const entry = this.appendEntry(randomUUID(), reference);
    this.#appended.set(entry.id, entry);
    return entry.token;
  }

  private appendEntry(id: string, reference: CheckpointReference): Entry {
    const token = Object.freeze({}) as InvocationCheckpointOccurrence;
    const entry: Entry = { id, reference, token, present: true, before: this.#last };
    if (this.#last) this.#last.after = entry;
    else this.#first = entry;
    this.#last = entry;
    this.#tokens.set(token, entry);
    this.#length++;
    return entry;
  }

  private entryAt(index: number): Entry | undefined {
    index = Number(index);
    if (Number.isNaN(index)) index = 0;
    index = Math.trunc(index);
    if (index < 0) index += this.#length;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#length) return undefined;
    // Endpoints are O(1), sequential reads are O(total entries). Arbitrary jumps
    // traverse only the nearer endpoint or the previous read position.
    let current = index <= this.#length - 1 - index ? { index: 0, entry: this.#first! } : { index: this.#length - 1, entry: this.#last! };
    if (this.#cursor && Math.abs(this.#cursor.index - index) < Math.abs(current.index - index)) current = this.#cursor;
    let entry = current.entry;
    let at = current.index;
    while (at < index) {
      entry = entry.after!;
      at++;
    }
    while (at > index) {
      entry = entry.before!;
      at--;
    }
    this.#cursor = { index, entry };
    return entry;
  }

  pending(): Readonly<{ reference: CheckpointSelectionReference; change?: CheckpointSelectionChange; acknowledge(): void }> {
    const changed = this.#revision === 0 || this.#reset || this.#appended.size !== 0 || this.#removed.size !== 0;
    const revision = this.#revision + (changed ? 1 : 0);
    const target = Object.freeze({ position: this.position });
    const reference = Object.freeze({ id: this.id, revision, target });
    const appended = [...this.#appended.values()];
    const change = changed ? Object.freeze({ id: this.id, target, expectedRevision: this.#revision, ...(this.#reset ? { reset: true as const } : {}), append: Object.freeze(appended.map((entry) => Object.freeze({ id: entry.id, reference: entry.reference }))), remove: Object.freeze(Array.from(this.#removed.values(), (entry) => Object.freeze({ id: entry.id, order: entry.order!, reference: entry.reference }))) }) : undefined;
    return Object.freeze({
      reference,
      ...(change ? { change } : {}),
      acknowledge: () => {
        this.#revision = revision;
        this.#reset = false;
        for (const entry of appended) entry.order = this.#nextOrder++;
        this.#appended.clear();
        this.#removed.clear();
      },
    });
  }

  /** A real Array view preserves existing author queries without copying all occurrences. */
  view(requireCut: () => void): readonly CheckpointReference[] {
    const target: CheckpointReference[] = [];
    const immutable = () => {
      throw new TypeError('Checkpoint references are readonly');
    };
    const index = (key: PropertyKey) => (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : undefined);
    return new Proxy(target, {
      get: (_target, key, receiver) => {
        requireCut();
        const at = index(key);
        if (at !== undefined) return this.entryAt(at)?.reference;
        if (key === 'length') return this.#length;
        if (key === Symbol.iterator)
          return function* (this: CheckpointSelectionState) {
            for (let entry = this.#first; entry; entry = entry.after) {
              requireCut();
              yield entry.reference;
            }
          }.bind(this);
        return Reflect.get(target, key, receiver);
      },
      has: (_target, key) => {
        requireCut();
        const at = index(key);
        return at === undefined ? Reflect.has(target, key) : at < this.#length;
      },
      ownKeys: () => {
        requireCut();
        return [...Array.from({ length: this.#length }, (_, i) => String(i)), 'length'];
      },
      getOwnPropertyDescriptor: (_target, key) => {
        requireCut();
        if (key === 'length') return { ...Reflect.getOwnPropertyDescriptor(target, 'length')!, value: this.#length };
        const at = index(key);
        if (at === undefined) return Reflect.getOwnPropertyDescriptor(target, key);
        const entry = this.entryAt(at);
        return entry ? { value: entry.reference, enumerable: true, configurable: true, writable: false } : undefined;
      },
      set: immutable,
      defineProperty: immutable,
      deleteProperty: immutable,
      setPrototypeOf: immutable,
      preventExtensions: immutable,
    });
  }
}
