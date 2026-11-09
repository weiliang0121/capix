import type { MemoryResultSource } from '@weiliang0121/capix-protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';

/** Call inputs are open record bodies; only recognized result sources enter the memory view. */
export function projectMemoryResults(value: unknown): readonly MemoryResultSource[] | undefined {
  if (!isArray(value)) return undefined;
  return value.flatMap((source): MemoryResultSource[] => {
    if (!isPlainObject(source) || source.kind !== 'file-created' || !isString(source.id) || !source.id || !isNumber(source.answerIndex) || !Number.isSafeInteger(source.answerIndex) || source.answerIndex < 0) return [];
    const receipt = source.receipt;
    if (!isPlainObject(receipt) || !isString(receipt.path) || !receipt.path || !isNumber(receipt.bytes) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || !isString(receipt.digest) || !/^[a-f0-9]{64}$/u.test(receipt.digest)) return [];
    return [{ id: source.id, kind: 'file-created', answerIndex: source.answerIndex, receipt: { path: receipt.path, bytes: receipt.bytes, digest: receipt.digest } }];
  });
}
