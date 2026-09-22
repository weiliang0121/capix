import { MessageRef, TranscriptRangeRef } from '../../transcript/ref.js';

/** Check record content policy without changing the value; this does not validate business contracts. */
export function assertRecordContent(value: unknown): void {
  checkContent(value, new Set<object>());
}

function checkContent(value: unknown, ancestors: Set<object>): void {
  if (value instanceof MessageRef || value instanceof TranscriptRangeRef) return;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Unsupported record content');
  if (ancestors.has(value)) throw new TypeError('Record content must not be cyclic');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Record content must use plain objects and arrays');

  ancestors.add(value);
  try {
    for (const item of Object.values(value)) checkContent(item, ancestors);
  } finally {
    ancestors.delete(value);
  }
}
