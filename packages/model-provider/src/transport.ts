import { deliverModelConsumer, isRequestCancellation, ModelAttemptTransportFailure, ModelEmissionFailure, ModelProtocolIssue, ProviderError, ProviderRequestLimitError } from './error.js';
import { retryAfterMilliseconds, retryDelay, retrySettings, waitForRetry } from './retry.js';
import type { RetrySettings } from './retry.js';
import { measureModelRequest } from './contract.js';
import { maximumModelRequestBytes, maximumModelWireRequestBytes, valueLimit } from './value.js';
import type { ModelHttpConfiguration, ModelControls, ModelAttemptFailure, ModelAttemptEvent, ModelReply, ModelRequest, ModelRequestInspection } from './types.js';

interface PreparedRequest<R extends ModelReply> {
  body: string;
  read(response: Response, signal: AbortSignal, limit: number, controls: ModelControls): Promise<R>;
}
interface ModelProtocol<R extends ModelReply> {
  readonly format: R['native']['format'];
  headers(apiKey: string): Record<string, string>;
  /** Optional alternate method on the configured endpoint, fixed before any request. */
  streamEndpoint?(endpoint: URL): string;
  encode(request: ModelRequest, streaming: boolean): PreparedRequest<R>;
}

/** A single bounded HTTP generation, including all explicitly permitted attempts. */
export class ModelHttpTransport<R extends ModelReply> {
  readonly #configuration: Required<Pick<ModelHttpConfiguration, 'endpoint' | 'timeoutMs' | 'maxRequestBytes' | 'maxWireRequestBytes' | 'maxResponseBytes'>>;
  readonly #streamEndpoint: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #retry: RetrySettings;

  constructor(
    configuration: ModelHttpConfiguration,
    private readonly protocol: ModelProtocol<R>,
  ) {
    this.#retry = retrySettings(configuration.retry);
    let endpoint: URL;
    try {
      endpoint = new URL(configuration.endpoint);
    } catch {
      throw new ProviderError('CONFIGURATION', 'A complete model HTTP endpoint is required');
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new ProviderError('CONFIGURATION', 'A plain HTTP endpoint without embedded credentials or fragment is required');
    if (typeof configuration.apiKey !== 'string' || !configuration.apiKey.trim() || /[\r\n]/.test(configuration.apiKey)) throw new ProviderError('CONFIGURATION', 'A model API key is required');
    if (typeof configuration.model !== 'string' || !configuration.model.trim()) throw new ProviderError('CONFIGURATION', 'A model name is required');
    const timeoutMs = configuration.timeoutMs ?? 60_000;
    const maxRequestBytes = configuration.maxRequestBytes === undefined ? valueLimit : configuration.maxRequestBytes;
    const maxWireRequestBytes = configuration.maxWireRequestBytes === undefined ? valueLimit : configuration.maxWireRequestBytes;
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > maximumModelRequestBytes || !Number.isSafeInteger(maxWireRequestBytes) || maxWireRequestBytes < 1 || maxWireRequestBytes > maximumModelWireRequestBytes) throw new ProviderError('CONFIGURATION', 'Request byte budgets must be positive integers within framework support bounds');
    const maxResponseBytes = configuration.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new ProviderError('CONFIGURATION', 'Positive bounded timeout and response byte limit are required');
    if (configuration.fetch !== undefined && typeof configuration.fetch !== 'function') throw new ProviderError('CONFIGURATION', 'Fetch transport must be a function');
    this.#configuration = Object.freeze({ endpoint: endpoint.href, timeoutMs, maxRequestBytes, maxWireRequestBytes, maxResponseBytes });
    this.#streamEndpoint = protocol.streamEndpoint?.(endpoint) ?? endpoint.href;
    this.#fetch = configuration.fetch ?? globalThis.fetch;
    this.#headers = { 'Content-Type': 'application/json', ...protocol.headers(configuration.apiKey) };
  }

  /** Uses the same fixed configuration and encoder as complete, without opening transport. */
  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.prepareRequest(request).inspection;
  }

  async complete(request: ModelRequest, controls: ModelControls = {}): Promise<R> {
    const external = controls.signal;
    external?.throwIfAborted();
    const emit = controls.emit;
    if (emit !== undefined && typeof emit !== 'function') throw new ProviderError('REQUEST', 'Model preview consumer must be a function');
    const emitReasoning = controls.emitReasoning;
    if (emitReasoning !== undefined && typeof emitReasoning !== 'function') throw new ProviderError('REQUEST', 'Model reasoning preview consumer must be a function');
    const progress = controls.progress;
    if (progress !== undefined && typeof progress !== 'function') throw new ProviderError('REQUEST', 'Model progress consumer must be a function');
    const attemptConsumer = controls.attempt;
    if (attemptConsumer !== undefined && typeof attemptConsumer !== 'function') throw new ProviderError('REQUEST', 'Model attempt consumer must be a function');
    const notify = (event: ModelAttemptEvent) => {
      if (attemptConsumer) deliverModelConsumer(() => attemptConsumer(Object.freeze(event)), 'Model attempt consumer must be synchronous');
    };
    // Inspection is not a reservation: the current value is always checked again before sending.
    const { body, streaming, inspection, read } = this.prepareRequest(request);
    if (inspection.requestBytes > this.#configuration.maxRequestBytes) throw new ProviderRequestLimitError('requestBytes', inspection.requestBytes, this.#configuration.maxRequestBytes);
    if (inspection.wireBytes > this.#configuration.maxWireRequestBytes) throw new ProviderRequestLimitError('wireBytes', inspection.wireBytes, this.#configuration.maxWireRequestBytes);
    const controller = new AbortController();
    const abort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    const timeoutFailure = new ProviderError('TIMEOUT', 'Model request exceeded its total timeout');
    const timeout = setTimeout(() => controller.abort(timeoutFailure), this.#configuration.timeoutMs);
    try {
      for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt++) {
        let phase: ModelAttemptFailure['phase'] = 'connect';
        let reply: R;
        try {
          controller.signal.throwIfAborted();
          notify({ kind: 'started', attempt });
          controller.signal.throwIfAborted();
          let response: Response;
          try {
            response = await this.#fetch(streaming ? this.#streamEndpoint : this.#configuration.endpoint, {
              method: 'POST',
              redirect: 'error',
              headers: { ...this.#headers },
              body,
              signal: controller.signal,
            });
          } catch (error) {
            if (isRequestCancellation(error, controller.signal)) throw controller.signal.reason;
            // Transport errors may expose secrets through messages or causes.
            throw new ModelAttemptTransportFailure(new ProviderError('NETWORK', 'Model transport failed'), 'connect');
          }
          if (controller.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            controller.signal.throwIfAborted();
          }
          if (!response.ok) {
            const failure = new ProviderError('HTTP', `Model endpoint returned HTTP ${response.status}`, response.status);
            const hint = retryAfterMilliseconds(response.headers.get('retry-after'));
            await response.body?.cancel().catch(() => undefined);
            throw new ModelAttemptTransportFailure(failure, 'http', hint);
          }
          phase = streaming ? 'stream' : 'response';
          reply = await read(response, controller.signal, this.#configuration.maxResponseBytes, { emit, progress, emitReasoning });
        } catch (error) {
          if (error instanceof ModelEmissionFailure) throw error;
          if (isRequestCancellation(error, controller.signal)) {
            const failure: ModelAttemptFailure = controller.signal.reason === timeoutFailure ? { code: 'TIMEOUT', phase: 'timeout' } : { code: 'CANCELLED', phase: 'cancelled' };
            notify({ kind: 'failed', attempt, failure: Object.freeze(failure) });
            throw controller.signal.reason;
          }
          const transport = error instanceof ModelAttemptTransportFailure ? error : undefined;
          const original = this.responseFailure(transport?.failure ?? error, streaming);
          const failure: ModelAttemptFailure = {
            code: original.code,
            phase: transport?.phase ?? phase,
            ...(original.status === undefined ? {} : { status: original.status }),
            ...(original.diagnostic && { diagnostic: original.diagnostic }),
          };
          notify({ kind: 'failed', attempt, failure: Object.freeze(failure) });
          const eligible = transport && (transport.failure.code !== 'HTTP' || [408, 429, 500, 502, 503, 504].includes(transport.failure.status!));
          const delayMs = eligible && attempt < this.#retry.maxAttempts && !controller.signal.aborted ? retryDelay(this.#retry, attempt, transport.retryAfterMs) : undefined;
          if (delayMs === undefined) throw original;
          notify({ kind: 'retrying', attempt, nextAttempt: attempt + 1, delayMs });
          await waitForRetry(delayMs, controller.signal);
          continue;
        }
        // A returned reply ends retry eligibility before delivery to observers.
        controller.signal.throwIfAborted();
        notify({ kind: 'completed', attempt, usage: reply.usage });
        controller.signal.throwIfAborted();
        return reply;
      }
      throw new ProviderError('NETWORK', 'Model attempts exhausted');
    } catch (error) {
      if (error instanceof ModelEmissionFailure) throw error.failure;
      throw error;
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener('abort', abort);
    }
  }

  private responseFailure(received: unknown, streaming: boolean): ProviderError {
    if (received instanceof ProviderError && received.code !== 'ENVELOPE') return received;
    const issue = received instanceof ModelProtocolIssue ? received : new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
    return issue.at(this.protocol.format, streaming ? 'stream' : 'response');
  }

  private prepareRequest(request: ModelRequest) {
    try {
      const requestBytes = measureModelRequest(request);
      const streaming = request.stream === true;
      const { body, read } = this.protocol.encode(request, streaming);
      const wireBytes = Buffer.byteLength(body);
      if (wireBytes > maximumModelWireRequestBytes) throw new TypeError('Model wire request exceeds byte limit');
      return { body, read, streaming, inspection: Object.freeze({ requestBytes, wireBytes, limits: Object.freeze({ maxRequestBytes: this.#configuration.maxRequestBytes, maxWireRequestBytes: this.#configuration.maxWireRequestBytes }) }) };
    } catch (error) {
      const issue = error instanceof ModelProtocolIssue ? error : new ModelProtocolIssue('REQUEST', 'invalid-request');
      throw issue.at(this.protocol.format, 'request');
    }
  }
}
