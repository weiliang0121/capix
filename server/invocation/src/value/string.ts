import { isString } from 'es-toolkit/predicate';

export const nonBlankStringPattern = /\S/;

/** Validate text without trimming or otherwise changing its content. */
export function isNonBlankString(value: unknown): value is string {
  return isString(value) && nonBlankStringPattern.test(value);
}
