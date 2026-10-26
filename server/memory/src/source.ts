import { isPlainObject } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import type { MemoryResultSource } from '@capix/protocol';
import type { Transcript } from '@capix/transcript';
import { isNonBlankString } from './validation.js';

/** Validate and freeze the built-in memory carrier. Producers establish the receipt's truth. */
export function prepareMemoryResultSources(transcript: Transcript, sources: readonly MemoryResultSource[] | undefined): readonly MemoryResultSource[] | undefined {
  if (sources === undefined) return undefined;
  if (!isArray(sources)) throw new TypeError('Memory result sources must be an array');
  const ids = new Set<string>();
  const prepared = Array.from(sources, (source) => {
    if (!isPlainObject(source)) throw new TypeError('Memory result source requires a known kind and unique identity');
    const id = source.id;
    const kind = source.kind;
    const answerIndex = source.answerIndex;
    if (kind !== 'file-created' || !isNonBlankString(id) || ids.has(id)) throw new TypeError('Memory result source requires a known kind and unique identity');
    ids.add(id);
    if (transcript.ref(answerIndex).read().role !== 'assistant') throw new TypeError('Memory result source must locate an assistant answer');
    const receipt = source.receipt;
    if (!isPlainObject(receipt)) throw new TypeError('Memory result source requires a valid file creation receipt');
    const path = receipt.path;
    const bytes = receipt.bytes;
    const digest = receipt.digest;
    if (!isNonBlankString(path) || !Number.isSafeInteger(bytes) || bytes < 0 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError('Memory result source requires a valid file creation receipt');
    return Object.freeze({ id, kind, answerIndex, receipt: Object.freeze({ path, bytes, digest }) });
  });
  return prepared.length ? Object.freeze(prepared) : undefined;
}
