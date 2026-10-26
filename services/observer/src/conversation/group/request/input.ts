import type { Message, FileTask } from '@capix/protocol';
import type { Memory } from '@capix/memory';
import type { AnswerMessageContext } from '../../node/context/assemble.js';
import { activeHistorySchema } from '../checkpoint.js';

export interface RequestUnderstandingInput {
  readonly message: Readonly<Message>;
  readonly history: AnswerMessageContext['selectedMessages'];
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
  readonly fileTask?: FileTask;
  readonly available?: readonly { readonly name: string; readonly description: string; readonly arguments: Readonly<Record<string, unknown>> }[];
  readonly feedback?: { readonly code: string; readonly message: string };
  readonly progress?: { readonly file?: FileTask; readonly saved?: { readonly path: string } };
}

/** The parent supplies the complete fixed active material; no implicit history expansion. */
export function understandingHistory(input: RequestUnderstandingInput) {
  return activeHistorySchema.parse(input.history).map(({ index, message }) => Object.freeze({ index, ...message }));
}
