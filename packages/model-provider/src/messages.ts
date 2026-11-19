import { assertMessagesReservation } from './messages-history.js';
import { ProviderError } from './error.js';
import { acceptMessagesReply, encodeMessagesRequest } from './messages-wire.js';
import { MessagesStream } from './messages-stream.js';
import { readJsonReply } from './response.js';
import { readEventStream } from './sse.js';
import { ModelHttpTransport } from './transport.js';
import { reserveMessagesWireBytes } from './reservation.js';
import type { AnthropicMessagesConfiguration, AnthropicMessagesReply, ModelControls, ModelProvider, ModelRequest, ModelRequestInspection, ModelRequestReservation } from './types.js';

/** A Messages deployment binding is supplied by the host and survives credential rotation. */
export class AnthropicMessagesProvider implements ModelProvider {
  readonly #transport: ModelHttpTransport<AnthropicMessagesReply>;

  constructor(configuration: AnthropicMessagesConfiguration) {
    const { model, bindingId, anthropicVersion, maxTokens, thinkingBudgetTokens } = configuration;
    if (typeof bindingId !== 'string' || !bindingId.trim() || bindingId.length > 256 || typeof anthropicVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(anthropicVersion) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || (typeof model === 'string' && model.length > 256)) throw new ProviderError('CONFIGURATION', 'Messages requires a binding identity, API version, model and positive default output token limit');
    if (thinkingBudgetTokens !== undefined && (!Number.isSafeInteger(thinkingBudgetTokens) || thinkingBudgetTokens < 1024 || thinkingBudgetTokens >= maxTokens)) throw new ProviderError('CONFIGURATION', 'Messages thinking budget must be at least 1024 and below the default output token limit');
    const binding = { model, bindingId, anthropicVersion, maxTokens, thinkingBudgetTokens };
    this.#transport = new ModelHttpTransport(configuration, {
      format: 'anthropic-messages',
      headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': anthropicVersion }),
      encode: (request, stream) => {
        const { body, prefixSha256 } = encodeMessagesRequest(request, binding);
        const source = { ...binding, prefixSha256 };
        return { body, read: (response, signal, limit, controls) => (stream ? readEventStream(response, signal, limit, new MessagesStream(source, signal, controls)) : readJsonReply(response, signal, limit, (value) => acceptMessagesReply(value, source))) };
      },
    });
  }

  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.#transport.inspectRequest(request);
  }

  reserveWireBytes(request: ModelRequest, reservation: ModelRequestReservation): number {
    const bound = reserveMessagesWireBytes(this.inspectRequest(request).wireBytes, request, reservation);
    assertMessagesReservation(request, reservation);
    return bound;
  }

  complete(request: ModelRequest, controls?: ModelControls): Promise<AnthropicMessagesReply> {
    return this.#transport.complete(request, controls);
  }
}
