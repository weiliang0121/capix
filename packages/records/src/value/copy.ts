import { isFunction, isNull } from 'es-toolkit/predicate';
import { isArray, isObject } from 'es-toolkit/compat';

/** Copy record content without retaining live entity references. */
export function copyContent<Content>(value: Content): Content {
  return copyValue(value, new Set()) as Content;
}

function copyValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'symbol' || isFunction(value)) {
    if (typeof DOMException === 'function') throw new DOMException('Record content cannot contain symbols or functions', 'DataCloneError');
    const error = new Error('Record content cannot contain symbols or functions');
    error.name = 'DataCloneError';
    throw error;
  }
  if (!isObject(value)) return value;
  if (ancestors.has(value)) throw new TypeError('Record content must not be cyclic');
  if (!isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && !isNull(Object.getPrototypeOf(value))) throw new TypeError('Record content must use plain objects and arrays');
  ancestors.add(value);
  try {
    return isArray(value) ? value.map((entry) => copyValue(entry, ancestors)) : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyValue(entry, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
}
