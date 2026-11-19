import { decodeModelText, isRequestCancellation, ModelAttemptTransportFailure, ModelEmissionFailure, ModelProtocolIssue, ProviderError, readModelChunk } from './error.js';

interface EventStream<R> {
  readonly done: boolean;
  readonly canFinishAtEof?: boolean;
  receive(data: string, event: string): boolean;
  result(): R;
}

/** Byte limits, cancellation and UTF-8/SSE framing shared by native event streams. */
export async function readEventStream<R>(response: Response, signal: AbortSignal, limit: number, completion: EventStream<R>): Promise<R> {
  if (!response.body) throw new ModelProtocolIssue('ENVELOPE', 'missing-body');
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body.cancel().catch(() => undefined);
    throw new ModelProtocolIssue('ENVELOPE', 'unexpected-content-type');
  }
  const reader = response.body.getReader();
  let abortCancellation: Promise<void> | undefined;
  const abort = () => {
    abortCancellation = reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const events = new ServerSentEvents((data, event) => completion.receive(data, event));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let chunk = await readModelChunk(reader, signal);
    while (!chunk.done && !completion.done) {
      signal.throwIfAborted();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('RESPONSE_LIMIT', 'Model response exceeds the configured byte limit');
      events.write(decodeModelText(decoder, chunk.value));
      if (!completion.done) chunk = await readModelChunk(reader, signal);
    }
    signal.throwIfAborted();
    if (!completion.done) {
      events.write(decodeModelText(decoder));
      if (!completion.canFinishAtEof || events.pending) throw new ModelAttemptTransportFailure(new ModelProtocolIssue('ENVELOPE', events.pending ? 'truncated-event' : 'missing-terminal'), 'stream');
    }
    return completion.result();
  } catch (error) {
    if (error instanceof ModelEmissionFailure) throw error;
    if (isRequestCancellation(error, signal)) throw signal.reason;
    if (error instanceof ProviderError || error instanceof ModelAttemptTransportFailure) throw error;
    throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
  } finally {
    signal.removeEventListener('abort', abort);
    // A protocol terminator ends the stream without requiring the HTTP producer to close first.
    await reader.cancel().catch(() => undefined);
    await abortCancellation;
    reader.releaseLock();
  }
}

/** Only line framing belongs here; completion semantics remain with the consumer. */
class ServerSentEvents {
  #line = '';
  #skipLF = false;
  #data: string[] = [];
  #event = '';
  #done = false;

  constructor(private readonly receive: (data: string, event: string) => boolean) {}

  get pending(): boolean {
    return (this.#line.length > 0 && !this.#line.startsWith(':')) || this.#data.length > 0 || this.#event.length > 0;
  }

  write(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length && !this.#done; index++) {
      const character = text[index];
      if (this.#skipLF) {
        this.#skipLF = false;
        if (character === '\n') {
          start = index + 1;
          continue;
        }
      }
      if (character !== '\n' && character !== '\r') continue;
      this.acceptLine(this.#line + text.slice(start, index));
      this.#line = '';
      this.#skipLF = character === '\r';
      start = index + 1;
    }
    if (!this.#done) this.#line += text.slice(start);
  }

  private acceptLine(line: string): void {
    if (line === '') {
      if (this.#data.length) this.#done = this.receive(this.#data.join('\n'), this.#event);
      this.#data = [];
      this.#event = '';
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    const payload = value.startsWith(' ') ? value.slice(1) : value;
    if (field === 'data') this.#data.push(payload);
    if (field === 'event') this.#event = payload;
  }
}
