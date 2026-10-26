import { isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';

/** Validate content without trimming or otherwise changing it. */
export function isNonBlankString(value: unknown): value is string {
  return isString(value) && /\S/.test(value);
}

export function isNonEmptyArray(value: unknown): value is [unknown, ...unknown[]] {
  return isArray(value) && value.length > 0;
}

/** Empty arrays are unique; object elements are compared by identity. */
export function hasUniqueItems(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

/** Object-shaped content does not need to have a plain-object prototype. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArray(value);
}
