import { ProviderError } from './error.js';
import type { ChatCompletionsConfiguration } from './types.js';

export interface RetrySettings {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly maxDelayMs: number;
}

export function retrySettings(value: ChatCompletionsConfiguration['retry']): RetrySettings {
  if (value === undefined) return Object.freeze({ maxAttempts: 1, delayMs: 1000, maxDelayMs: 30_000 });
  if (typeof value !== 'object' || value === null) throw new ProviderError('CONFIGURATION', 'Model retry settings must be an object');
  const maxAttempts = value.maxAttempts;
  const delayMs = value.delayMs === undefined ? 1000 : value.delayMs;
  const maxDelayMs = value.maxDelayMs === undefined ? 30_000 : value.maxDelayMs;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647 || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < delayMs || maxDelayMs > 2_147_483_647) throw new ProviderError('CONFIGURATION', 'Model retry attempts and bounded delays must be valid integers');
  return Object.freeze({ maxAttempts, delayMs, maxDelayMs });
}

export function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  // Do not let Date.parse interpret malformed numeric durations as calendar dates.
  if (!/^[A-Za-z]{3},?\s/.test(text)) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

export function retryDelay(settings: RetrySettings, attempt: number, hint?: number): number | undefined {
  if (hint !== undefined && hint > settings.maxDelayMs) return undefined;
  const exponential = settings.delayMs === 0 ? 0 : settings.delayMs * 2 ** Math.min(attempt - 1, 53);
  return Math.max(Math.min(exponential, settings.maxDelayMs), hint ?? 0);
}

/** No transport resources remain when waiting; cancellation owns only this timer. */
export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
}
