import type { ModelProtocolDiagnostic } from './types.js';

/** Bounded public diagnostics never contain credentials, request text or upstream bodies. */
export class ProviderError extends Error {
  constructor(
    readonly code: 'CONFIGURATION' | 'REQUEST' | 'REQUEST_LIMIT' | 'NETWORK' | 'HTTP' | 'TIMEOUT' | 'RESPONSE_LIMIT' | 'ENVELOPE',
    message: string,
    readonly status?: number,
    readonly diagnostic?: ModelProtocolDiagnostic,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Annotate codec failures at the adapter boundary, where the actual wire phase is known. */
export class ModelProtocolIssue extends ProviderError {
  constructor(
    code: 'ENVELOPE' | 'REQUEST',
    readonly reason: ModelProtocolDiagnostic['reason'],
  ) {
    super(code, 'Model protocol validation failed (' + reason + ')');
  }

  at(protocol: ModelProtocolDiagnostic['protocol'], phase: ModelProtocolDiagnostic['phase']): ProviderError {
    return new ProviderError(this.code, this.message, undefined, Object.freeze({ protocol, phase, reason: this.reason }));
  }
}

export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelProtocolIssue('ENVELOPE', 'invalid-json');
  }
}

export function decodeModelText(decoder: TextDecoder, bytes?: Uint8Array): string {
  try {
    return decoder.decode(bytes, { stream: bytes !== undefined });
  } catch {
    throw new ModelProtocolIssue('ENVELOPE', 'invalid-utf8');
  }
}

/** Request budget diagnostics contain measurements only, never request material. */
export class ProviderRequestLimitError extends ProviderError {
  constructor(
    readonly metric: 'requestBytes' | 'wireBytes',
    readonly bytes: number,
    readonly limit: number,
  ) {
    super('REQUEST_LIMIT', `Model request ${metric} exceeds the configured byte limit (${bytes} > ${limit})`);
    this.name = 'ProviderRequestLimitError';
  }
}

/** Internal provenance: consumer failures must not be mistaken for unsafe transport errors. */
export class ModelEmissionFailure {
  constructor(readonly failure: unknown) {}
}

/** Concurrent cancellation does not relabel an independently thrown failure. */
export function isRequestCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'));
}

/** Internal transport provenance is never inferred from a caller supplied ProviderError. */
export class ModelAttemptTransportFailure {
  constructor(
    readonly failure: ProviderError,
    readonly phase: 'connect' | 'http' | 'read' | 'stream',
    readonly retryAfterMs?: number,
  ) {}
}

/** Consumer failures retain their exact identity until the final public rejection. */
export function deliverModelConsumer(consumer: () => unknown, message: string): void {
  try {
    const returned = consumer();
    if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
      if ('then' in returned && typeof returned.then === 'function') {
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError(message);
      }
    }
  } catch (failure) {
    throw new ModelEmissionFailure(failure);
  }
}

/** Only the read operation is tagged; decoder and envelope failures remain terminal. */
export async function readModelChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (isRequestCancellation(error, signal)) throw signal.reason;
    throw new ModelAttemptTransportFailure(new ProviderError('NETWORK', 'Model response transport failed'), 'read');
  }
}
