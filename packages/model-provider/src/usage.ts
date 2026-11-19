import { ProviderError } from './error.js';
import type { ModelReply } from './types.js';
import { count, record } from './value.js';

/** Both JSON and SSE preserve the same reported usage, without estimating absent counts. */
export function acceptUsage(value: unknown): ModelReply['usage'] {
  if (value === undefined || value === null) return null;
  if (!record(value) || !count(value.prompt_tokens) || !count(value.completion_tokens) || !count(value.total_tokens)) throw invalidUsage();
  let hit = value.prompt_cache_hit_tokens;
  if (hit === undefined && value.prompt_tokens_details != null) {
    if (!record(value.prompt_tokens_details)) throw invalidUsage();
    hit = value.prompt_tokens_details.cached_tokens ?? undefined;
  }
  const miss = value.prompt_cache_miss_tokens;
  if ((hit !== undefined && (!count(hit) || hit > value.prompt_tokens)) || (miss !== undefined && (!count(miss) || miss > value.prompt_tokens)) || (typeof hit === 'number' && typeof miss === 'number' && hit !== value.prompt_tokens - miss)) throw invalidUsage();
  return Object.freeze({ promptTokens: value.prompt_tokens, completionTokens: value.completion_tokens, totalTokens: value.total_tokens, ...(hit === undefined ? {} : { promptCacheHitTokens: hit }), ...(miss === undefined ? {} : { promptCacheMissTokens: miss }) });
}

function invalidUsage(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response contains invalid usage counts');
}
