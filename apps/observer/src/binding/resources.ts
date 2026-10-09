import type { RuntimeSnapshot } from '@capix-observer/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';

/** Application resource contracts are interpreted here, never in React or the receiver. */
export function executionResources(snapshot: RuntimeSnapshot) {
  const available = snapshot.resources.filter((fact) => fact.parentId === snapshot.execution.id && fact.phase === 'available');
  const settings = available.find((fact) => fact.access === 'model-settings.snapshot')?.value;
  const value = available.find((fact) => fact.access === 'transcript.fixedRange')?.value;
  const transcriptRange = isPlainObject(value) && isString(value.transcriptId) && isNumber(value.start) && isNumber(value.end) ? { transcriptId: value.transcriptId, start: value.start, end: value.end, ...(isNumber(value.revision) ? { revision: value.revision } : {}) } : undefined;
  return { settings, transcriptRange };
}
