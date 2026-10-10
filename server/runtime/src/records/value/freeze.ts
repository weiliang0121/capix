import { isObjectLike } from '../../value/object.js';

/** Freeze already checked, acyclic plain content in place. Does not copy or enforce record policy. */
export function freezeContent<Content>(value: Content): Content {
  if (isObjectLike(value)) {
    for (const item of Object.values(value)) freezeContent(item);
    Object.freeze(value);
  }
  return value;
}
