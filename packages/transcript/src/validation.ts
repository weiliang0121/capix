import { isArray, isObjectLike } from 'es-toolkit/compat';
import { isString } from 'es-toolkit/predicate';

/** Object-shaped value, not necessarily a plain object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !isArray(value);
}

/** Validate text without trimming or otherwise changing its content. */
export function isNonBlankString(value: unknown): value is string {
  return isString(value) && /\S/.test(value);
}
