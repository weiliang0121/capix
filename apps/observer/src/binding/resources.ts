import type { ExecutionRecordSnapshot } from '@capix/protocol';
import { isEqual } from 'es-toolkit';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';

export type ExecutionSettingsState = 'available' | 'unavailable' | 'multiple' | 'inconsistent';

/** Application resource contracts are interpreted here, never in React or the receiver. */
export function executionResources(snapshot: ExecutionRecordSnapshot) {
  const available = snapshot.resources.filter((fact) => fact.parentId === snapshot.execution.id && fact.phase === 'available');
  const value = available.find((fact) => fact.access === 'transcript.fixedRange')?.value;
  const transcriptRange = isPlainObject(value) && isString(value.transcriptId) && isNumber(value.start) && isNumber(value.end) ? { transcriptId: value.transcriptId, start: value.start, end: value.end, ...(isNumber(value.revision) ? { revision: value.revision } : {}) } : undefined;
  return { ...executionSettings(snapshot), transcriptRange };
}

/** Forwarding supply is not E access. Interpret only actual accesses in this E's recorded subtree. */
function executionSettings(snapshot: ExecutionRecordSnapshot): { settings: unknown; settingsState: ExecutionSettingsState } {
  const owners = new Set([snapshot.execution.id, ...snapshot.operations.map((call) => call.id), ...snapshot.attempts.map((call) => call.id)]);
  const supplies = new Map<string, unknown>();
  for (const fact of snapshot.resources) {
    if (!owners.has(fact.parentId) || fact.phase !== 'available' || fact.access !== 'model-settings.snapshot') continue;
    if (supplies.has(fact.supplyId) && !isEqual(supplies.get(fact.supplyId), fact.value)) return { settings: undefined, settingsState: 'inconsistent' };
    supplies.set(fact.supplyId, fact.value);
  }
  if (supplies.size === 0) return { settings: undefined, settingsState: 'unavailable' };
  if (supplies.size > 1) return { settings: undefined, settingsState: 'multiple' };
  return { settings: supplies.values().next().value, settingsState: 'available' };
}
