import { isObjectLike } from '../../value/object.js';
import { isArray, isFinite } from 'es-toolkit/compat';
import { isBoolean, isNull, isString } from 'es-toolkit/predicate';
import { MessageRef, TranscriptRangeRef } from '../../transcript/ref.js';

/** Check record content policy without changing the value; this does not validate business contracts. */
export function assertRecordContent(value: unknown): void {
  checkContent(value, new Set<object>());
}

function checkContent(value: unknown, ancestors: Set<object>): void {
  if (value instanceof MessageRef || value instanceof TranscriptRangeRef) return;
  if (isNull(value) || isString(value) || isBoolean(value)) return;
  if (isFinite(value)) return;
  if (!isObjectLike(value)) throw new TypeError('Unsupported record content');
  if (ancestors.has(value)) throw new TypeError('Record content must not be cyclic');
  if (!isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && !isNull(Object.getPrototypeOf(value))) throw new TypeError('Record content must use plain objects and arrays');

  ancestors.add(value);
  try {
    for (const item of Object.values(value)) checkContent(item, ancestors);
  } finally {
    ancestors.delete(value);
  }
}
