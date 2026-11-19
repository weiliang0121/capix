import type { ReplyFields } from './native-reply.js';
import type { AnthropicMessagesUsageCounts, ModelReply, ModelUsage } from './types.js';
import { count, identity, record, shape } from './value.js';

export const messagesUsageKeys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/** Both wire and stored counts must fit the common exact-integer budget, even if incomplete. */
export function validMessagesCounts(counts: Record<string, unknown>): counts is AnthropicMessagesUsageCounts {
  let sum = 0;
  for (const value of Object.values(counts)) {
    if (!count(value)) return false;
    sum += value;
  }
  return count(sum);
}

export function projectMessagesUsage(counts: AnthropicMessagesUsageCounts): Partial<ModelUsage> | null {
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: hit, cache_creation_input_tokens: write } = counts;
  const prompt = input !== undefined && hit !== undefined && write !== undefined ? input + hit + write : undefined;
  if (prompt === undefined && output === undefined && hit === undefined && write === undefined) return null;
  return { ...(prompt === undefined ? {} : { promptTokens: prompt }), ...(output === undefined ? {} : { completionTokens: output }), ...(hit === undefined ? {} : { promptCacheHitTokens: hit }), ...(write === undefined ? {} : { promptCacheWriteTokens: write }), ...(prompt !== undefined && output !== undefined ? { totalTokens: prompt + output } : {}) };
}

export function messagesTerminationKind(reason: string): ModelReply['termination']['kind'] {
  return reason === 'end_turn' || reason === 'stop_sequence' || reason === 'tool_use' ? 'completed' : reason === 'refusal' ? 'refused' : 'incomplete';
}

export function checkMessagesReply(native: Record<string, unknown>, { output, termination, usage }: ReplyFields, calls: number): void {
  checkMessagesLayout(native, output.length);
  if (native.partialUsage !== undefined) {
    const counts = native.partialUsage;
    shape(counts, [], messagesUsageKeys);
    const fields = Object.keys(counts).length;
    if (usage !== null || fields === 0 || fields === messagesUsageKeys.length || !validMessagesCounts(counts)) throw new TypeError('Invalid partial Anthropic Messages usage counts');
  }
  const { kind, reason } = termination;
  const hasCalls = calls > 0;
  if (kind !== messagesTerminationKind(reason) || (kind === 'completed' && (reason === 'tool_use') !== hasCalls)) throw new TypeError('Model termination disagrees with Anthropic Messages output');
  if (usage && (usage.totalTokens !== usage.promptTokens + usage.completionTokens || usage.promptCacheMissTokens !== undefined || (usage.promptCacheWriteTokens !== undefined && usage.promptCacheWriteTokens > usage.promptTokens - (usage.promptCacheHitTokens ?? 0)))) throw new TypeError('Invalid Anthropic Messages usage counts');
}
/** Each visible block is stored once, in output. The layout interleaves it with signed material. */
function checkMessagesLayout(native: unknown, outputLength: number): void {
  shape(native, ['format', 'version', 'bindingId', 'model', 'anthropicVersion', 'blocks'], ['prefixSha256', 'partialUsage']);
  for (const field of [native.bindingId, native.model]) {
    identity(field);
    if (!field.trim()) throw new TypeError('Empty Anthropic Messages binding');
  }
  if (typeof native.anthropicVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(native.anthropicVersion)) throw new TypeError('Invalid Anthropic API version');
  if (!Array.isArray(native.blocks)) throw new TypeError('Invalid Anthropic Messages blocks');
  let next = 0;
  for (const block of native.blocks) {
    if (record(block) && block.kind === 'output') {
      shape(block, ['kind', 'index']);
      if (block.index !== next) throw new TypeError('Invalid Anthropic Messages output order');
      next++;
    } else if (record(block) && block.kind === 'thinking') {
      shape(block, ['kind', 'thinking', 'signature']);
      if (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature.trim()) throw new TypeError('Invalid signed thinking block');
    } else {
      shape(block, ['kind', 'data']);
      if (block.kind !== 'redacted_thinking' || typeof block.data !== 'string' || !block.data.trim()) throw new TypeError('Invalid redacted thinking block');
    }
  }
  if (native.blocks.length > next) {
    if (typeof native.prefixSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(native.prefixSha256)) throw new TypeError('Missing or invalid signed Messages prefix digest');
  } else if (native.prefixSha256 !== undefined) throw new TypeError('Unexpected prefix digest on unsigned Messages reply');
  if (next !== outputLength) throw new TypeError('Incomplete Anthropic Messages output layout');
}
