import type { SourceIdentity, SourceIndex, SourceInspection, SourceSnapshot, SourceStamp, SyncViewSource, ViewKey } from './source.js';
import { checkIdentity, checkKey, checkStamp, conflict, data, object, sameStamp, synchronous } from './value.js';

/** Detached, recursively readonly view data; this is not runtime Stable evidence or a codec. */
export type ViewSourceData<Value> = unknown extends Value ? unknown : Value extends (...args: never[]) => unknown ? never : Value extends readonly unknown[] ? { readonly [Key in keyof Value]: ViewSourceData<Value[Key]> } : Value extends object ? { readonly [Key in keyof Value]: ViewSourceData<Value[Key]> } : Value extends undefined | null | boolean | number | string ? Value : never;

/** Callbacks own membership and scope validation, and must throw RangeError for absent keys. */
export interface ViewSourceOptions<Key extends ViewKey, Summary, Value> extends SourceIdentity {
  /** Covers every observable source change; a version must never be reused. */
  version(): string;
  /** Complete directory for this fixed scope. */
  keys(): readonly Key[];
  inspect(key: Key): Summary & ViewSourceData<Summary>;
  read(key: Key): Value & ViewSourceData<Value>;
}

/** An optional synchronous adapter over author-owned data, with no storage or access lifecycle. */
export function createViewSource<Key extends ViewKey, Summary, Value>(options: ViewSourceOptions<Key, Summary, Value>): SyncViewSource<Key, ViewSourceData<Summary>, ViewSourceData<Value>> & SourceIdentity {
  object(options);
  const identity = data({ id: options.id, scope: options.scope });
  checkIdentity(identity);
  const versionMethod = options.version;
  const keysMethod = options.keys;
  const inspectMethod = options.inspect;
  const readMethod = options.read;
  if (typeof versionMethod !== 'function' || typeof keysMethod !== 'function' || typeof inspectMethod !== 'function' || typeof readMethod !== 'function') throw new TypeError('Invalid view source callbacks');
  const version = versionMethod.bind(options);
  const keys = keysMethod.bind(options);
  const inspect = inspectMethod.bind(options);
  const read = readMethod.bind(options);
  const current = (): SourceStamp => {
    const stamp = data({ ...identity, version: synchronous(version(), 'Source version') });
    checkStamp(stamp);
    return stamp;
  };
  let reading = false;
  const access = <Input, Result>(prepare: () => Input, operation: (stamp: SourceStamp, input: Input) => Result): Result => {
    if (reading) conflict('View source access cannot reenter');
    reading = true;
    try {
      const input = prepare();
      const stamp = current();
      const result = operation(stamp, input);
      if (!sameStamp(stamp, current())) conflict('View source version has changed');
      return result;
    } finally {
      reading = false;
    }
  };
  const selected = (value: readonly Key[]): readonly Key[] => {
    const accepted = data(value);
    if (!Array.isArray(accepted)) throw new TypeError('View source keys must be an array');
    const seen = new Set<ViewKey>();
    for (const key of accepted) {
      checkKey(key);
      if (seen.has(key)) throw new TypeError('View source keys must be unique');
      seen.add(key);
    }
    return accepted;
  };
  const expectedStamp = (value: SourceStamp): SourceStamp => {
    const accepted = data(value);
    checkStamp(accepted);
    return accepted;
  };
  const summaries = (selected: readonly Key[]) => Object.freeze(selected.map((key) => Object.freeze({ key, summary: data(synchronous(inspect(key), 'Source summary')) as ViewSourceData<Summary> })));
  return Object.freeze({
    ...identity,
    index: (): SourceIndex<Key, ViewSourceData<Summary>> =>
      access(
        () => undefined,
        (stamp) => Object.freeze({ stamp, entries: summaries(selected(synchronous(keys(), 'Source keys'))) }),
      ),
    inspect: (requested: readonly Key[]): SourceInspection<Key, ViewSourceData<Summary>> =>
      access(
        () => selected(requested),
        (stamp, input) => Object.freeze({ stamp, entries: summaries(input) }),
      ),
    read: (requested: readonly Key[], expected: SourceStamp): SourceSnapshot<Key, ViewSourceData<Value>> =>
      access(
        () => ({ keys: selected(requested), expected: expectedStamp(expected) }),
        (stamp, input) => {
          if (!sameStamp(stamp, input.expected)) conflict('View source version has changed');
          const entries = input.keys.map((key) => Object.freeze({ key, value: data(synchronous(read(key), 'Source value')) as ViewSourceData<Value> }));
          return Object.freeze({ stamp, entries: Object.freeze(entries) });
        },
      ),
    check: (expected: SourceStamp): boolean =>
      access(
        () => expectedStamp(expected),
        (stamp, input) => sameStamp(stamp, input),
      ),
  });
}
