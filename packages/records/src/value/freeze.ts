import { isObject } from 'es-toolkit/compat';
import { isFunction } from 'es-toolkit/predicate';

/** Freeze already checked, acyclic plain content in place. Does not copy or enforce record policy. */
export function freezeContent<Content>(value: Content): Content {
  if (isObject(value) && !isFunction(value)) {
    for (const item of Object.values(value)) freezeContent(item);
    Object.freeze(value);
  }
  return value;
}
