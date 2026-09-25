export interface HttpResponseInfo {
  readonly method: string;
  readonly url: string;
  readonly status: number;
}

/** HTTP facts survive even when the server returns an empty or non-JSON error body. */
export class HttpError extends Error {
  readonly name = 'HttpError';
  constructor(
    readonly response: HttpResponseInfo,
    readonly body: unknown,
    readonly phase: 'status' | 'decode',
    message = `HTTP ${response.status}`,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ObserverTransportError extends Error {
  readonly name = 'ObserverTransportError';
  constructor(
    readonly kind: 'contract' | 'remote' | 'delivery',
    message: string,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
