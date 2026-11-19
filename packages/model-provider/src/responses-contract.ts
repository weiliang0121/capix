import type { ReplyFields } from './native-reply.js';
import { identity, record, shape } from './value.js';

function checkItemStatus(status: unknown, completed: boolean): void {
  if (status === 'completed' || (!completed && (status === 'in_progress' || status === 'incomplete'))) return;
  throw new TypeError('Invalid Responses item status for this reply');
}

function textParts(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The layout refers to each public output exactly once in original wire order. */
export function checkResponsesReply(native: Record<string, unknown>, { id, output, termination, usage }: ReplyFields): void {
  shape(native, ['format', 'version', 'bindingId', 'model', 'continuation', 'previousResponseId', 'prefixSha256', 'items']);
  for (const field of [native.bindingId, native.model]) {
    identity(field);
    if (!field.trim()) throw new TypeError('Empty Responses binding');
  }
  if (native.continuation !== 'previous-response-id' && native.continuation !== 'replay') throw new TypeError('Invalid Responses continuation mode');
  if (native.previousResponseId !== null) {
    identity(native.previousResponseId);
    if (native.continuation !== 'previous-response-id' || native.previousResponseId === id) throw new TypeError('Invalid Responses predecessor');
  }
  if (typeof native.prefixSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(native.prefixSha256)) throw new TypeError('Invalid Responses prefix digest');
  if (!Array.isArray(native.items)) throw new TypeError('Invalid Responses item layout');
  const ids = new Set<string>();
  let next = 0;
  let refused = false;
  const completed = termination.kind !== 'incomplete';
  for (const item of native.items) {
    if (!record(item)) throw new TypeError('Invalid Responses output item');
    identity(item.id);
    if (ids.has(item.id)) throw new TypeError('Duplicate Responses item id');
    ids.add(item.id);
    switch (item.kind) {
      case 'message':
        shape(item, ['kind', 'id', 'status', 'content'], ['phase']);
        checkItemStatus(item.status, completed);
        if (item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer') throw new TypeError('Invalid Responses message phase');
        if (!Array.isArray(item.content)) throw new TypeError('Invalid Responses message content');
        for (const part of item.content) {
          if (record(part) && part.kind === 'refusal') {
            shape(part, ['kind', 'refusal']);
            if (typeof part.refusal !== 'string') throw new TypeError('Invalid Responses refusal');
            refused = true;
          } else {
            shape(part, ['kind', 'index']);
            if (part.kind !== 'output_text' || part.index !== next || output[next]?.kind !== 'text') throw new TypeError('Invalid Responses text reference');
            next++;
          }
        }
        break;
      case 'function_call':
        shape(item, ['kind', 'id', 'index'], ['status']);
        if (item.status !== undefined) checkItemStatus(item.status, completed);
        if (item.index !== next || output[next]?.kind !== 'tool-call') throw new TypeError('Invalid Responses call reference');
        next++;
        break;
      case 'reasoning':
        shape(item, ['kind', 'id', 'summary'], ['status', 'content', 'encryptedContent']);
        if (item.status !== undefined) checkItemStatus(item.status, completed);
        if (!textParts(item.summary) || (item.content !== undefined && !textParts(item.content)) || (item.encryptedContent !== undefined && (typeof item.encryptedContent !== 'string' || !item.encryptedContent.trim()))) throw new TypeError('Invalid Responses reasoning material');
        break;
      default:
        throw new TypeError('Unsupported Responses item');
    }
  }
  if (next !== output.length) throw new TypeError('Incomplete Responses output layout');
  if (completed && (termination.kind !== (refused ? 'refused' : 'completed') || termination.reason !== (refused ? 'refusal' : 'completed'))) throw new TypeError('Responses termination disagrees with output');
  if (usage && (usage.totalTokens !== usage.promptTokens + usage.completionTokens || usage.promptCacheMissTokens !== undefined)) throw new TypeError('Invalid Responses usage counts');
}
