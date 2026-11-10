import { isArray, isObjectLike as toolkitIsObjectLike } from 'es-toolkit/compat';

/** The library checks non-null objects, but its declaration only returns boolean. */
export const isObjectLike = toolkitIsObjectLike as (value: unknown) => value is object;

/** Object-shaped value, not necessarily a plain object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !isArray(value);
}
