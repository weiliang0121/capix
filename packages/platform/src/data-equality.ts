import { isOpaqueObject } from './inspection.js';

/** Compare acyclic data trees used in fixed model arguments, exchange records and receipts. */
export function equalData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  // A schema can produce a live object while checking it against the fixed argument.
  if (isOpaqueObject(left) || isOpaqueObject(right)) return false;
  const prototype = Object.getPrototypeOf(left);
  if (prototype !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length || prototype !== Array.prototype) return false;
  } else if (Array.isArray(right) || (prototype !== Object.prototype && prototype !== null)) return false;
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Reflect.ownKeys(right).length) return false;
  for (const key of keys) {
    if (Array.isArray(left) && key === 'length') continue;
    if (typeof key !== 'string') return false;
    const a = Object.getOwnPropertyDescriptor(left, key)!;
    const b = Object.getOwnPropertyDescriptor(right, key);
    if (!b || !a.enumerable || !b.enumerable || !('value' in a) || !('value' in b) || !equalData(a.value, b.value)) return false;
  }
  return true;
}
