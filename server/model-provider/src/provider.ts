import { isRequestCancellation, ModelEmissionFailure, ProviderError } from './error.js';
import { readModelReply } from './response.js';
import { readModelStream } from './stream.js';
import type { ChatCompletionsConfiguration, ModelControls, ModelProvider, ModelReply, ModelRequest } from './types.js';

/** One bounded HTTP request. No resource, interaction or conversation lifecycle is owned here. */
export class ChatCompletionsProvider implements ModelProvider {
  readonly #configuration: Readonly<Required<Omit<ChatCompletionsConfiguration, 'fetch' | 'thinking'>> & Pick<ChatCompletionsConfiguration, 'thinking'>>;
  readonly #fetch: typeof fetch;

  constructor(configuration: ChatCompletionsConfiguration) {
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
    const maxResponseBytes = configuration.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new ProviderError('CONFIGURATION', 'Positive bounded timeout and response byte limit are required');
    if (configuration.thinking !== undefined && !['enabled', 'disabled'].includes(configuration.thinking)) throw new ProviderError('CONFIGURATION', 'Unsupported thinking setting');
    if (configuration.fetch !== undefined && typeof configuration.fetch !== 'function') throw new ProviderError('CONFIGURATION', 'Fetch transport must be a function');
    this.#configuration = Object.freeze({ endpoint: endpoint.href, apiKey: configuration.apiKey, model: configuration.model, timeoutMs, maxResponseBytes, thinking: configuration.thinking });
    this.#fetch = configuration.fetch ?? globalThis.fetch;
  }

  async complete(request: ModelRequest, controls: ModelControls = {}): Promise<ModelReply> {
    const external = controls.signal;
    external?.throwIfAborted();
    const emit = controls.emit;
    if (emit !== undefined && typeof emit !== 'function') throw new ProviderError('REQUEST', 'Model preview consumer must be a function');
    const stream = request?.stream;
    if (stream !== undefined && typeof stream !== 'boolean') throw new ProviderError('REQUEST', 'stream must be a boolean');
    const streaming = stream === true;
    const body = this.requestBody(request, streaming);
    const controller = new AbortController();
    const abort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new ProviderError('TIMEOUT', 'Model request exceeded its total timeout')), this.#configuration.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const response = await this.#fetch(this.#configuration.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#configuration.apiKey}` },
        body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        controller.signal.throwIfAborted();
      }
      if (!response.ok) {
        const failure = new ProviderError('HTTP', `Model endpoint returned HTTP ${response.status}; request was not retried`, response.status);
        await response.body?.cancel().catch(() => undefined);
        throw failure;
      }
      return streaming ? await readModelStream(response, controller.signal, this.#configuration.maxResponseBytes, emit) : await readModelReply(response, controller.signal, this.#configuration.maxResponseBytes);
    } catch (error) {
      if (error instanceof ModelEmissionFailure) throw error.failure;
      if (isRequestCancellation(error, controller.signal)) throw controller.signal.reason;
      if (error instanceof ProviderError) throw error;
      // A fetcher's error/cause can contain headers or a response body. Do not expose it.
      throw new ProviderError('NETWORK', 'Model transport failed; request was not retried');
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener('abort', abort);
    }
  }

  private requestBody(request: ModelRequest, stream: boolean): string {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError('REQUEST', 'At least one model message is required');
    const messages = Array.from(request.messages, (message) => {
      if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new ProviderError('REQUEST', 'Model messages require a supported role and text');
      return { role: message.role, content: message.content };
    });
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw new ProviderError('REQUEST', 'maxTokens must be a positive integer');
    if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new ProviderError('REQUEST', 'temperature must be between zero and two');
    if (request.responseFormat !== undefined && !['text', 'json_object'].includes(request.responseFormat)) throw new ProviderError('REQUEST', 'Unsupported response format');
    return JSON.stringify({ model: this.#configuration.model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.responseFormat === undefined ? {} : { response_format: { type: request.responseFormat } }), ...(this.#configuration.thinking === undefined ? {} : { thinking: { type: this.#configuration.thinking } }) });
  }
}
