import { isProxy } from 'node:util/types';

export const valueLimit = 2 * 1024 * 1024;
// Aggregate snapshots can contain several independently bounded requests/replies.
// This is not an increased acceptance limit for any single external value.
export const collectionLimit = 32 * 1024 * 1024;

/** Bounded JSON values only. This experiment never serializes live runtime objects. */
export function fixed(value, limit = valueLimit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Tool fixture byte limit must be a positive integer');
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 100_000 || depth > 64) throw new TypeError('Tool fixture value exceeds structural limits');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > limit) throw new TypeError('Tool fixture value exceeds byte limit');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || isProxy(item) || ancestors.has(item)) throw new TypeError('Tool fixture requires acyclic JSON values');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Tool fixture requires plain values');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Tool fixture does not support symbol fields');
    const result = array ? [] : {};
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Tool fixture does not accept accessors or hidden fields');
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) throw new TypeError('Tool fixture array has extra fields');
      bytes += Buffer.byteLength(key);
      if (bytes > limit) throw new TypeError('Tool fixture value exceeds byte limit');
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: false, configurable: false });
    }
    if (array && Object.keys(descriptors).length !== item.length + 1) throw new TypeError('Tool fixture does not accept sparse arrays');
    ancestors.delete(item);
    return Object.freeze(result);
  }
  const captured = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(captured)) > limit) throw new TypeError('Tool fixture value exceeds byte limit');
  return captured;
}

/** Stable JSON representation; array order and all Schema constraints remain intact. */
export function canonical(value, limit = valueLimit) {
  const captured = fixed(value, limit);
  const encode = (item) =>
    Array.isArray(item)
      ? `[${item.map(encode).join(',')}]`
      : item !== null && typeof item === 'object'
        ? `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
            .join(',')}}`
        : JSON.stringify(item);
  return encode(captured);
}
