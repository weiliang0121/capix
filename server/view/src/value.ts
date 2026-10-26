import { types } from 'node:util';
import { RuntimeError } from '@capix/contracts';
import type { SourceIdentity, SourceStamp, ViewKey } from './source.js';

export function conflict(message: string): never {
  throw new RuntimeError('VIEW_CONFLICT', message);
}

/** Values crossing the view boundary are passive data, never late-reading accessors or handles. */
export function data<Value>(value: Value): Value {
  const visiting = new Set<object>();
  const copy = (input: unknown): unknown => {
    if (input === null || input === undefined || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || types.isProxy(input)) throw new TypeError('View content must be passive data');
    if (visiting.has(input)) throw new TypeError('View content cannot contain cycles');
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError('View content cannot contain live objects');
    visiting.add(input);
    try {
      const result: Record<string, unknown> | unknown[] = array ? [] : {};
      let reusable = Object.isFrozen(input);
      for (const key of Reflect.ownKeys(input)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new TypeError('View content cannot contain symbol fields');
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('View content must use enumerable data fields');
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (input as unknown[]).length)) throw new TypeError('View arrays cannot contain named fields');
        const copied = copy(descriptor.value);
        if (copied !== descriptor.value) reusable = false;
        Object.defineProperty(result, key, { value: copied, enumerable: true, configurable: true, writable: true });
      }
      if (array && Object.keys(input).length !== (input as unknown[]).length) throw new TypeError('View arrays must be dense');
      return reusable ? input : Object.freeze(result);
    } finally {
      visiting.delete(input);
    }
  };
  return copy(value) as Value;
}

export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid view object');
}
export function exactKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError('View fields do not match the contract');
}
export function checkIdentity(value: unknown): asserts value is SourceIdentity {
  object(value);
  if (typeof value.id !== 'string' || !/\S/.test(value.id) || typeof value.scope !== 'string' || !/\S/.test(value.scope)) throw new TypeError('Invalid view source identity');
}
export function checkStamp(value: unknown): asserts value is SourceStamp {
  checkIdentity(value);
  exactKeys(value, ['id', 'scope', 'version']);
  if (typeof (value as SourceStamp).version !== 'string' || !(value as SourceStamp).version.length) throw new TypeError('Invalid view source version');
}
export function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.id === right.id && left.scope === right.scope;
}
export function sameStamp(left: SourceStamp, right: SourceStamp): boolean {
  return sameIdentity(left, right) && left.version === right.version;
}
export function checkKey(key: unknown): asserts key is ViewKey {
  if (typeof key === 'string' && key.length > 0) return;
  if (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0) return;
  throw new TypeError('View keys must be nonempty strings or nonnegative safe integers');
}
export function synchronous<Value>(value: Value, label: string): Exclude<Value, PromiseLike<unknown>> {
  if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value as Exclude<Value, PromiseLike<unknown>>;
}
