import { isArray, isFinite, isObject } from 'es-toolkit/compat';
import { isBoolean, isFunction, isNull, isString } from 'es-toolkit/predicate';

/** Check record content policy without changing the value; this does not validate business contracts. */
export function assertRecordContent(value: unknown): void {
  checkContent(value, new Set<object>());
}

function checkContent(value: unknown, ancestors: Set<object>): void {
  if (isNull(value) || isString(value) || isBoolean(value)) return;
  if (isFinite(value)) return;
  if (!isObject(value) || isFunction(value)) throw new TypeError('Unsupported record content');
  if (ancestors.has(value)) throw new TypeError('Record content must not be cyclic');
  if (!isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && !isNull(Object.getPrototypeOf(value))) throw new TypeError('Record content must use plain objects and arrays');

  ancestors.add(value);
  try {
    for (const item of Object.values(value)) checkContent(item, ancestors);
  } finally {
    ancestors.delete(value);
  }
}
