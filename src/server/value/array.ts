import { isArray } from 'es-toolkit/compat';
export function isNonEmptyArray(value: unknown): value is [unknown, ...unknown[]] {
  return isArray(value) && value.length > 0;
}

/** Empty arrays are unique; object elements are compared by identity. */
export function hasUniqueItems(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}
