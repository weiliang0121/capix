import { isProxy } from 'node:util/types';
import { isArray } from 'es-toolkit/compat';

const limits = Object.freeze({ depth: 64, values: 100_000, characters: 16 * 1024 * 1024 });

/** Fixed interaction data is JSON-shaped. No getters, live entities, or recording conversion. */
export function captureInteractionValue<T>(value: T): T {
  let values = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): unknown => {
    values += 1;
    if (depth > limits.depth || values > limits.values) throw new TypeError('Interaction data exceeds its structural limit');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current === 'string') {
      characters += current.length;
      if (characters > limits.characters) throw new TypeError('Interaction data exceeds its text limit');
      return current;
    }
    if (typeof current !== 'object' || isProxy(current)) throw new TypeError('Interaction data must contain only JSON values');
    // Generic plain-object predicates can read Symbol.toStringTag. Inspect structural identity only.
    const prototype = Object.getPrototypeOf(current);
    if (!isArray(current) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Interaction data must contain only JSON values');
    if (ancestors.has(current)) throw new TypeError('Interaction data must not contain cycles');
    ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (isArray(current)) {
        const result: unknown[] = [];
        const keys = Reflect.ownKeys(descriptors);
        if (keys.length !== current.length + 1) throw new TypeError('Interaction arrays must be dense and contain only indexed values');
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Interaction data must not contain accessors or missing array values');
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key as string]!;
        if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Interaction data must contain only enumerable data properties');
        characters += key.length;
        if (characters > limits.characters) throw new TypeError('Interaction data exceeds its text limit');
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0) as T;
}

/** Both arguments have already passed capture; key insertion order is not data identity. */
export function sameInteractionValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (isArray(left) !== isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && sameInteractionValue(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Check an identity field without changing the original text. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}
