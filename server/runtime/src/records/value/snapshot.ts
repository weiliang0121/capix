import { copyContent } from './copy.js';
import { assertRecordContent } from './check.js';
import { freezeContent } from './freeze.js';

/** Snapshot policy applies to the clone; source objects are neither validated nor frozen here. */
export function snapshotValue<Content>(value: Content): Content {
  const copy = copyContent(value);
  assertRecordContent(copy);
  return freezeContent(copy);
}
