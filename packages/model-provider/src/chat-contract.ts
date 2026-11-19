import type { ReplyFields } from './native-reply.js';
import type { ModelReply } from './types.js';
import { shape } from './value.js';

export function terminationKind(reason: string): ModelReply['termination']['kind'] {
  return reason === 'stop' || reason === 'tool_calls' ? 'completed' : reason === 'content_filter' ? 'refused' : 'incomplete';
}

export function checkChatReply(native: Record<string, unknown>, { output, termination, usage }: ReplyFields, calls: number): void {
  shape(native, ['format', 'version'], ['reasoningContent']);
  if ('reasoningContent' in native && typeof native.reasoningContent !== 'string') throw new TypeError('Invalid Chat Completions reasoning');
  if (usage?.promptCacheWriteTokens !== undefined) throw new TypeError('Invalid Chat Completions usage counts');
  const textCount = output.length - calls;
  if (textCount > 1 || (textCount === 1 && output[0]?.kind !== 'text')) throw new TypeError('Unsupported Chat Completions output order');
  const { kind, reason } = termination;
  if (kind !== terminationKind(reason) || (reason === 'tool_calls' && !calls) || (reason === 'stop' && calls)) throw new TypeError('Model termination disagrees with Chat Completions output');
}
