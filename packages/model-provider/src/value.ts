import { isProxy } from 'node:util/types';

export const valueLimit = 2 * 1024 * 1024;
export const toolLimit = 32;

/** Validate and count encoded JSON bytes without cloning or evaluating accessors. */
export function requireJson(value: unknown): number {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (size: number) => {
    bytes += size;
    if (bytes > valueLimit) throw new TypeError('Model value exceeds byte limit');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) throw new TypeError('Model value exceeds structural limits');
    if (item === null || typeof item === 'boolean') {
      add(item === null ? 4 : item ? 4 : 5);
      return;
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > valueLimit) throw new TypeError('Model value exceeds byte limit');
      add(Buffer.byteLength(JSON.stringify(item)));
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(Buffer.byteLength(JSON.stringify(item)));
      return;
    }
    if (typeof item !== 'object' || isProxy(item) || ancestors.has(item)) throw new TypeError('Model value must be acyclic JSON');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Model value must contain plain objects');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== item.length + 1) throw new TypeError('Model arrays must be dense');
    const length = keys.length - (array ? 1 : 0);
    add(2 + Math.max(0, length - 1)); // Brackets/braces and separators.
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('Model value cannot contain symbol fields');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Model value cannot contain accessors or hidden fields');
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) throw new TypeError('Model arrays cannot have extra fields');
      if (!array) add(Buffer.byteLength(JSON.stringify(key)) + 1);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return bytes;
}

/** Only already validated fresh protocol values are passed here. */
export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError('Model value has unsupported or missing fields');
}
export function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new TypeError('Model identity is invalid');
}
export function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
