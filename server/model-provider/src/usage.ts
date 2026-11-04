import { ProviderError } from './error.js';
import type { ModelReply } from './types.js';

/** Both JSON and SSE preserve the same reported usage, without estimating absent counts. */
export function acceptUsage(value: unknown): ModelReply['usage'] {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !('prompt_tokens' in value) || !('completion_tokens' in value) || !('total_tokens' in value) || !count(value.prompt_tokens) || !count(value.completion_tokens) || !count(value.total_tokens)) throw invalidUsage();
  const hit = 'prompt_cache_hit_tokens' in value ? value.prompt_cache_hit_tokens : undefined;
  const miss = 'prompt_cache_miss_tokens' in value ? value.prompt_cache_miss_tokens : undefined;
  if ((hit !== undefined && (!count(hit) || hit > value.prompt_tokens)) || (miss !== undefined && (!count(miss) || miss > value.prompt_tokens)) || (typeof hit === 'number' && typeof miss === 'number' && hit !== value.prompt_tokens - miss)) throw invalidUsage();
  return Object.freeze({ promptTokens: value.prompt_tokens, completionTokens: value.completion_tokens, totalTokens: value.total_tokens, ...(hit === undefined ? {} : { promptCacheHitTokens: hit }), ...(miss === undefined ? {} : { promptCacheMissTokens: miss }) });
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidUsage(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response contains invalid usage counts');
}
