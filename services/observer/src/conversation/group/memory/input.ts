import { randomUUID } from 'node:crypto';
import type { FileReceipt, MemoryResultSource } from '@capix/protocol';
import type { AnswerMessageContext } from '../../node/context/assemble.js';
import type { Memory } from '@capix/server-runtime/content';

export interface MemoryInput {
  readonly currentIndexes: readonly number[];
  readonly messages: AnswerMessageContext['selectedMessages'];
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
  readonly results?: readonly MemoryResultSource[];
}

/** Selected evidence is available to extraction; it is not a claim of actual generation use. */
export function prepareMemoryInput(current: AnswerMessageContext['selectedMessages'][number], response: AnswerMessageContext['selectedMessages'][number], history: AnswerMessageContext['selectedMessages'], memories: MemoryInput['memories'], options: { readonly saved?: FileReceipt } = {}): MemoryInput {
  const messages = [...history.filter((item) => item.index !== current.index), current, response];
  const results: readonly MemoryResultSource[] | undefined = options.saved ? Object.freeze([Object.freeze({ id: randomUUID(), kind: 'file-created' as const, answerIndex: response.index, receipt: Object.freeze({ path: options.saved.path, bytes: options.saved.bytes, digest: options.saved.digest }) })]) : undefined;
  return { currentIndexes: [current.index, response.index], messages, memories, ...(results ? { results } : {}) };
}
