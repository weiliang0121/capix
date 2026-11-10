import { stableValue, type CheckpointValue } from '@weiliang0121/capix-contracts';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';

/** Default codec for uncontracted data facts. Explicit codecs keep their own wire shape. */
export function encodeCheckpointData(value: unknown): CheckpointValue {
  const fixed = stableValue(value);
  let tagged = fixed !== null && typeof fixed === 'object' && !Array.isArray(fixed) && Reflect.get(fixed, 'format') === 'capix.invocation.data@1';
  const encode = (entry: unknown): CheckpointValue => {
    if (entry === undefined) {
      tagged = true;
      return '~u';
    }
    if (typeof entry === 'number' && Object.is(entry, -0)) return '~0';
    if (typeof entry === 'string') return entry.startsWith('~') ? `~${entry}` : entry;
    if (Array.isArray(entry)) return entry.map(encode);
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, encode(child)]));
    return entry as CheckpointValue;
  };
  const encoded = encode(fixed);
  return cloneCheckpointValue(tagged ? { format: 'capix.invocation.data@1', value: encoded } : fixed);
}

export function decodeCheckpointData(value: CheckpointValue): unknown {
  const record = value as Readonly<Record<string, CheckpointValue>>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || record.format !== 'capix.invocation.data@1' || !Object.hasOwn(value, 'value') || Object.keys(value).length !== 2) return stableValue<unknown>(value);
  const decode = (entry: CheckpointValue): unknown => {
    if (entry === '~u') return undefined;
    if (entry === '~0') return -0;
    if (typeof entry === 'string' && entry.startsWith('~~')) return entry.slice(1);
    if (typeof entry === 'string' && entry.startsWith('~')) throw new Error('Invalid invocation data escape');
    if (Array.isArray(entry)) return entry.map(decode);
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, decode(child)]));
    return entry;
  };
  return stableValue(decode(record.value!));
}

/** A synchronous check cannot publish a head before an asynchronous rejection. */
export function runCheckpointCheck(check: () => unknown): void {
  const result = check();
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error('Checkpoint check must complete synchronously');
  }
}

/** Compare data contents, including missing/undefined and -0, not record prototypes or DAG identity. */
export function checkpointDataEqual(left: unknown, right: unknown): boolean {
  const pairs = new WeakMap<object, WeakSet<object>>();
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    let seen = pairs.get(a);
    if (seen?.has(b)) return true;
    seen ??= new WeakSet();
    pairs.set(a, seen);
    seen.add(b);
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((key) => Object.hasOwn(b, key) && equal(Reflect.get(a, key), Reflect.get(b, key)));
  };
  return equal(left, right);
}
