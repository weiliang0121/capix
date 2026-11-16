/** Bounded public diagnostics never contain credentials, request text or upstream bodies. */
export class ProviderError extends Error {
  constructor(
    readonly code: 'CONFIGURATION' | 'REQUEST' | 'REQUEST_LIMIT' | 'NETWORK' | 'HTTP' | 'TIMEOUT' | 'RESPONSE_LIMIT' | 'ENVELOPE',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
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
