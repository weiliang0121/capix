import { reserveChatWireBytes } from './reservation.js';
import { ProviderError } from './error.js';
import { ModelHttpTransport } from './transport.js';
import { readModelReply } from './response.js';
import { readModelStream } from './stream.js';
import { encodeMessages } from './wire.js';
import type { ChatCompletionsConfiguration, ChatCompletionsReply, ModelControls, ModelProvider, ModelRequest, ModelRequestInspection, ModelRequestReservation } from './types.js';

/** Chat Completions wire protocol, including replay of provider-specific reasoning. */
export class ChatCompletionsProvider implements ModelProvider {
  readonly #configuration: Pick<ChatCompletionsConfiguration, 'model' | 'thinking'>;
  readonly #transport: ModelHttpTransport<ChatCompletionsReply>;

  constructor(configuration: ChatCompletionsConfiguration) {
    if (configuration.thinking !== undefined && !['enabled', 'disabled'].includes(configuration.thinking)) throw new ProviderError('CONFIGURATION', 'Unsupported thinking setting');
    this.#configuration = Object.freeze({ model: configuration.model, thinking: configuration.thinking });
    this.#transport = new ModelHttpTransport(configuration, {
      format: 'chat-completions',
      headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
      encode: (request, streaming) => ({ body: this.requestBody(request, streaming), read: (response, signal, limit, controls) => (streaming ? readModelStream(response, signal, limit, controls.emit, controls.progress, controls.emitReasoning) : readModelReply(response, signal, limit)) }),
    });
  }

  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.#transport.inspectRequest(request);
  }

  reserveWireBytes(request: ModelRequest, reservation: ModelRequestReservation): number {
    return reserveChatWireBytes(this.inspectRequest(request).wireBytes, request, reservation);
  }

  complete(request: ModelRequest, controls?: ModelControls): Promise<ChatCompletionsReply> {
    return this.#transport.complete(request, controls);
  }

  private requestBody(request: ModelRequest, stream: boolean): string {
    const messages = encodeMessages(request);
    const tools = request.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const choice = request.toolChoice;
    const body = JSON.stringify({ model: this.#configuration.model, messages, stream, ...(tools ? { tools } : {}), ...(choice === undefined ? {} : { tool_choice: typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } } }), ...(stream ? { stream_options: { include_usage: true } } : {}), ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.responseFormat === undefined ? {} : { response_format: { type: request.responseFormat } }), ...(this.#configuration.thinking === undefined ? {} : { thinking: { type: this.#configuration.thinking } }) });
    return body;
  }
}
