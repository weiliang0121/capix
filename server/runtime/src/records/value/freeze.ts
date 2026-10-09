import { isObjectLike } from '../../value/object.js';

/** Freeze already checked, acyclic plain content in place. Does not copy or enforce record policy. */
export function freezeContent<T>(value: T): T {
  if (isObjectLike(value)) {
    for (const item of Object.values(value)) freezeContent(item);
    Object.freeze(value);
  }
  return value;
}
