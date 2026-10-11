import { isPlainObject } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import type { MemoryResultSource } from '@capix/protocol';
import type { Transcript } from '../transcript/transcript.js';
import { isNonBlankString } from '../value/string.js';

/** Validate and freeze the built-in memory carrier. Producers establish the receipt's truth. */
export function prepareMemoryResultSources(transcript: Transcript, sources: readonly MemoryResultSource[] | undefined): readonly MemoryResultSource[] | undefined {
  if (sources === undefined) return undefined;
  if (!isArray(sources)) throw new TypeError('Memory result sources must be an array');
  const ids = new Set<string>();
  const prepared = sources.map((source) => {
    if (!isPlainObject(source) || source.kind !== 'file-created' || !isNonBlankString(source.id) || ids.has(source.id)) throw new TypeError('Memory result source requires a known kind and unique identity');
    ids.add(source.id);
    if (transcript.ref(source.answerIndex).read().role !== 'assistant') throw new TypeError('Memory result source must locate an assistant answer');
    const receipt = source.receipt;
    if (!isPlainObject(receipt) || !isNonBlankString(receipt.path) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.digest)) throw new TypeError('Memory result source requires a valid file creation receipt');
    return Object.freeze({ id: source.id, kind: source.kind, answerIndex: source.answerIndex, receipt: Object.freeze({ path: receipt.path, bytes: receipt.bytes, digest: receipt.digest }) });
  });
  return prepared.length ? Object.freeze(prepared) : undefined;
}
