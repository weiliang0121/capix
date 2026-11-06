import { isRequestCancellation, ModelEmissionFailure, ProviderError } from './error.js';
import { readModelReply } from './response.js';
import { readModelStream } from './stream.js';
import { measureModelRequest } from './contract.js';
import { encodeMessages } from './wire.js';
import { valueLimit } from './value.js';
import type { ChatCompletionsConfiguration, ModelControls, ModelProvider, ModelReply, ModelRequest, ModelRequestInspection } from './types.js';

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

  /** Uses the same fixed configuration and encoder as complete, without opening transport. */
  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.prepareRequest(request).inspection;
  }

  async complete(request: ModelRequest, controls: ModelControls = {}): Promise<ModelReply> {
    const external = controls.signal;
    external?.throwIfAborted();
    const emit = controls.emit;
    if (emit !== undefined && typeof emit !== 'function') throw new ProviderError('REQUEST', 'Model preview consumer must be a function');
    // Inspection is not a reservation: the current value is always checked again before sending.
    const { body, streaming } = this.prepareRequest(request);
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

  private prepareRequest(request: ModelRequest) {
    try {
      const requestBytes = measureModelRequest(request);
      const streaming = request.stream === true;
      const body = this.requestBody(request, streaming);
      const wireBytes = Buffer.byteLength(body);
      if (wireBytes > valueLimit) throw new TypeError('Model wire request exceeds byte limit');
      return { body, streaming, inspection: Object.freeze({ requestBytes, wireBytes }) };
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
