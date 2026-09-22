import { MessageRef, TranscriptRangeRef } from '../../transcript/ref.js';

/** Copy ordinary content; immutable message references keep their runtime identity. */
export function copyContent<T>(value: T): T {
  return copyValue(value, new Set()) as T;
}

function copyValue(value: unknown, ancestors: Set<object>): unknown {
  if (value instanceof MessageRef || value instanceof TranscriptRangeRef) return value;
  if (!value || typeof value !== 'object') return structuredClone(value);
  if (ancestors.has(value)) throw new TypeError('Record content must not be cyclic');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return structuredClone(value);
  ancestors.add(value);
  try {
    return Array.isArray(value) ? value.map((entry) => copyValue(entry, ancestors)) : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyValue(entry, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
}
