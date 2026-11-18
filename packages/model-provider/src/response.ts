import { isRequestCancellation, ModelAttemptTransportFailure, ProviderError, readModelChunk } from './error.js';
import type { ModelReply } from './types.js';
import { acceptWireReply } from './wire.js';

/** Count received bytes, including whitespace, before parsing the bounded envelope. */
export async function readModelReply(response: Response, signal: AbortSignal, limit: number): Promise<ModelReply> {
  if (!response.body) throw envelope();
  const reader = response.body.getReader();
  let abortCancellation: Promise<void> | undefined;
  const abort = () => {
    abortCancellation = reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let complete = false;
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    let chunk = await readModelChunk(reader, signal);
    while (!chunk.done) {
      signal.throwIfAborted();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('RESPONSE_LIMIT', 'Model response exceeds the configured byte limit');
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await readModelChunk(reader, signal);
    }
    signal.throwIfAborted();
    text += decoder.decode();
    complete = true;
    return acceptWireReply(JSON.parse(text));
  } catch (error) {
    if (isRequestCancellation(error, signal)) throw signal.reason;
    if (error instanceof ProviderError || error instanceof ModelAttemptTransportFailure) throw error;
    throw envelope();
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    await abortCancellation;
    reader.releaseLock();
  }
}

function envelope(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response is not a supported Chat Completions envelope');
}
