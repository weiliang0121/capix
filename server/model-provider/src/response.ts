import { isRequestCancellation, ProviderError } from './error.js';
import type { ModelReply } from './types.js';

/** Count received bytes, including whitespace, before parsing the bounded envelope. */
export async function readModelReply(response: Response, signal: AbortSignal, limit: number): Promise<ModelReply> {
  if (!response.body) throw envelope();
  const reader = response.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  let complete = false;
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    let chunk = await reader.read();
    while (!chunk.done) {
      signal.throwIfAborted();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('RESPONSE_LIMIT', 'Model response exceeds the configured byte limit');
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    signal.throwIfAborted();
    text += decoder.decode();
    complete = true;
    return acceptReply(JSON.parse(text));
  } catch (error) {
    if (isRequestCancellation(error, signal)) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw envelope();
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function acceptReply(value: unknown): ModelReply {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.model !== 'string' || !value.model || !Array.isArray(value.choices) || value.choices.length !== 1) throw envelope();
  const choice: unknown = value.choices[0];
  if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.message) || typeof choice.message.content !== 'string' || typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw envelope();
  let usage: ModelReply['usage'] = null;
  if (value.usage !== undefined && value.usage !== null) {
    if (!record(value.usage) || !count(value.usage.prompt_tokens) || !count(value.usage.completion_tokens) || !count(value.usage.total_tokens)) throw envelope();
    usage = Object.freeze({ promptTokens: value.usage.prompt_tokens, completionTokens: value.usage.completion_tokens, totalTokens: value.usage.total_tokens });
  }
  return Object.freeze({ id: value.id, model: value.model, text: choice.message.content, finishReason: choice.finish_reason, usage });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function envelope(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response is not a supported text completion envelope');
}
