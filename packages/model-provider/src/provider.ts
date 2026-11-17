import { deliverModelConsumer, isRequestCancellation, ModelAttemptTransportFailure, ModelEmissionFailure, ProviderError, ProviderRequestLimitError } from './error.js';
import { retryAfterMilliseconds, retryDelay, retrySettings, waitForRetry } from './retry.js';
import type { RetrySettings } from './retry.js';
import { readModelReply } from './response.js';
import { readModelStream } from './stream.js';
import { measureModelRequest } from './contract.js';
import { encodeMessages } from './wire.js';
import { maximumModelRequestBytes, maximumModelWireRequestBytes, valueLimit } from './value.js';
import type { ChatCompletionsConfiguration, ModelControls, ModelAttemptFailure, ModelAttemptEvent, ModelProvider, ModelReply, ModelRequest, ModelRequestInspection } from './types.js';

/** One bounded logical model request. No resource, interaction or conversation lifecycle is owned here. */
export class ChatCompletionsProvider implements ModelProvider {
  readonly #configuration: Readonly<Required<Omit<ChatCompletionsConfiguration, 'fetch' | 'thinking' | 'retry'>> & Pick<ChatCompletionsConfiguration, 'thinking'>>;
  readonly #fetch: typeof fetch;
  readonly #retry: RetrySettings;

  constructor(configuration: ChatCompletionsConfiguration) {
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
    if (configuration.thinking !== undefined && !['enabled', 'disabled'].includes(configuration.thinking)) throw new ProviderError('CONFIGURATION', 'Unsupported thinking setting');
    if (configuration.fetch !== undefined && typeof configuration.fetch !== 'function') throw new ProviderError('CONFIGURATION', 'Fetch transport must be a function');
    this.#configuration = Object.freeze({ endpoint: endpoint.href, apiKey: configuration.apiKey, model: configuration.model, timeoutMs, maxRequestBytes, maxWireRequestBytes, maxResponseBytes, thinking: configuration.thinking });
    this.#fetch = configuration.fetch ?? globalThis.fetch;
  }

  /** Uses the same fixed configuration and encoder as complete, without opening transport. */
  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.prepareRequest(request).inspection;
  }

  async complete(request: ModelRequest, controls: ModelControls = {}): Promise<ModelReply> {
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
    const { body, streaming, inspection } = this.prepareRequest(request);
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
        let reply: ModelReply;
        try {
          controller.signal.throwIfAborted();
          notify({ kind: 'started', attempt });
          controller.signal.throwIfAborted();
          let response: Response;
          try {
            response = await this.#fetch(this.#configuration.endpoint, {
              method: 'POST',
              redirect: 'error',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#configuration.apiKey}` },
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
          reply = streaming ? await readModelStream(response, controller.signal, this.#configuration.maxResponseBytes, emit, progress, emitReasoning) : await readModelReply(response, controller.signal, this.#configuration.maxResponseBytes);
        } catch (error) {
          if (error instanceof ModelEmissionFailure) throw error;
          const cancellation = isRequestCancellation(error, controller.signal);
          const transport = error instanceof ModelAttemptTransportFailure ? error : undefined;
          const original = transport ? transport.failure : cancellation ? controller.signal.reason : error instanceof ProviderError ? error : new ProviderError('ENVELOPE', 'Model response is not a supported Chat Completions envelope');
          const failure: ModelAttemptFailure = cancellation ? (controller.signal.reason === timeoutFailure ? { code: 'TIMEOUT', phase: 'timeout' } : { code: 'CANCELLED', phase: 'cancelled' }) : original instanceof ProviderError ? { code: original.code, phase: transport?.phase ?? phase, ...(original.status === undefined ? {} : { status: original.status }) } : { code: 'ENVELOPE', phase };
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

  private prepareRequest(request: ModelRequest) {
    try {
      const requestBytes = measureModelRequest(request);
      const streaming = request.stream === true;
      const body = this.requestBody(request, streaming);
      const wireBytes = Buffer.byteLength(body);
      if (wireBytes > maximumModelWireRequestBytes) throw new TypeError('Model wire request exceeds byte limit');
      return { body, streaming, inspection: Object.freeze({ requestBytes, wireBytes, limits: Object.freeze({ maxRequestBytes: this.#configuration.maxRequestBytes, maxWireRequestBytes: this.#configuration.maxWireRequestBytes }) }) };
    } catch {
      throw new ProviderError('REQUEST', 'Model request has invalid, unsupported or excessive content');
    }
  }

  private requestBody(request: ModelRequest, stream: boolean): string {
    const messages = encodeMessages(request);
    const tools = request.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const choice = request.toolChoice;
    const body = JSON.stringify({ model: this.#configuration.model, messages, stream, ...(tools ? { tools } : {}), ...(choice === undefined ? {} : { tool_choice: typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } } }), ...(stream ? { stream_options: { include_usage: true } } : {}), ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.responseFormat === undefined ? {} : { response_format: { type: request.responseFormat } }), ...(this.#configuration.thinking === undefined ? {} : { thinking: { type: this.#configuration.thinking } }) });
    return body;
  }
}
