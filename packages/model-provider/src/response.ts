import { decodeModelText, parseModelJson, isRequestCancellation, ModelAttemptTransportFailure, ModelProtocolIssue, ProviderError, readModelChunk } from './error.js';
import type { ChatCompletionsReply } from './types.js';
import { acceptWireReply } from './wire.js';

/** Count received bytes, including whitespace, before parsing the bounded envelope. */
export async function readModelReply(response: Response, signal: AbortSignal, limit: number): Promise<ChatCompletionsReply> {
  return readJsonReply(response, signal, limit, acceptWireReply);
}

export async function readJsonReply<R>(response: Response, signal: AbortSignal, limit: number, accept: (wire: unknown) => R): Promise<R> {
  if (!response.body) throw new ModelProtocolIssue('ENVELOPE', 'missing-body');
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
      text += decodeModelText(decoder, chunk.value);
      chunk = await readModelChunk(reader, signal);
    }
    signal.throwIfAborted();
    text += decodeModelText(decoder);
    complete = true;
    return accept(parseModelJson(text));
  } catch (error) {
    if (isRequestCancellation(error, signal)) throw signal.reason;
    if (error instanceof ProviderError || error instanceof ModelAttemptTransportFailure) throw error;
    throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    await abortCancellation;
    reader.releaseLock();
  }
}
