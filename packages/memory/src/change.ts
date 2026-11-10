import type { MemoryContent, MemoryResultSource } from '@weiliang0121/capix-protocol';
import type { Transcript } from '@weiliang0121/capix-transcript';
import { isEqual } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import { Memory } from './memory.js';
import { prepareMemoryResultSources } from './source.js';
import { hasUniqueItems, isNonBlankString, isNonEmptyArray, isObject } from './validation.js';

/** A proposed change. It becomes a record only after application succeeds. */
export type MemoryChange = {
  readonly change: string;
  readonly sourceIndexes: readonly number[];
  readonly sourceResults?: readonly MemoryResultSource[];
  readonly result: MemoryContent;
} & ({ readonly action: 'create'; readonly memoryId: null } | { readonly action: 'update'; readonly memoryId: string });

/** Package-private value admission; collection target checks remain with Memories. */
export function prepareMemoryChanges(transcript: Transcript, changes: readonly MemoryChange[]): readonly MemoryChange[] {
  if (!isArray(changes)) throw new TypeError('Memory changes must be an array');
  return Object.freeze(Array.from(changes, (change) => prepareMemoryChange(transcript, change)));
}

function prepareMemoryChange(transcript: Transcript, value: MemoryChange): MemoryChange {
  if (!isObject(value)) throw new TypeError('Memory change requires an explanation and unique evidence');
  const action = value.action;
  const memoryId = value.memoryId;
  const change = value.change;
  const evidence = value.sourceIndexes;
  if (!isNonBlankString(change) || !isNonEmptyArray(evidence)) throw new TypeError('Memory change requires an explanation and unique evidence');
  const sourceIndexes = Object.freeze([...evidence]);
  if (!isNonEmptyArray(sourceIndexes) || !hasUniqueItems(sourceIndexes)) throw new TypeError('Memory change requires an explanation and unique evidence');
  for (const index of sourceIndexes) transcript.ref(index);
  const sourceResults = prepareMemoryResultSources(transcript, value.sourceResults);
  const result = Memory.prepare(transcript, value.result);
  if (!sourceIndexes.every((index) => result.sourceIndexes.includes(index))) throw new Error('Memory result must include change evidence');
  if (sourceResults?.some((source) => !result.sourceResults?.some((candidate) => isEqual(source, candidate)))) throw new Error('Memory result must include the unchanged result sources of this change');
  if (action === 'create') {
    if (memoryId !== null) throw new Error('Creating memory cannot specify an existing identity');
    return Object.freeze({ action, memoryId, change, sourceIndexes, ...(sourceResults ? { sourceResults } : {}), result });
  }
  if (action !== 'update') throw new Error('Unknown memory change action');
  if (!isNonBlankString(memoryId)) throw new TypeError('Memory update requires an identity');
  return Object.freeze({ action, memoryId, change, sourceIndexes, ...(sourceResults ? { sourceResults } : {}), result });
}
