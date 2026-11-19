import { ProviderError } from './error.js';
import { reserveResponsesWireBytes } from './reservation.js';
import { readJsonReply } from './response.js';
import { acceptResponsesReply } from './responses-reply.js';
import { ResponsesStream } from './responses-stream.js';
import { assertResponsesReservation, encodeResponsesRequest } from './responses-wire.js';
import { readEventStream } from './sse.js';
import { ModelHttpTransport } from './transport.js';
import type { ModelControls, ModelProvider, ModelRequest, ModelRequestInspection, ModelRequestReservation, OpenAIResponsesConfiguration, OpenAIResponsesReply } from './types.js';

export class OpenAIResponsesProvider implements ModelProvider {
  readonly #transport: ModelHttpTransport<OpenAIResponsesReply>;

  constructor(configuration: OpenAIResponsesConfiguration) {
    const { model, bindingId, continuation = 'replay' } = configuration;
    if (typeof bindingId !== 'string' || !bindingId.trim() || bindingId.length > 256 || typeof model !== 'string' || model.length > 256 || (continuation !== 'replay' && continuation !== 'previous-response-id')) throw new ProviderError('CONFIGURATION', 'Responses requires a deployment binding, model and supported continuation strategy');
    const binding = { model, bindingId, continuation };
    this.#transport = new ModelHttpTransport(configuration, {
      format: 'openai-responses',
      headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
      encode: (request, stream) => {
        const { body, source } = encodeResponsesRequest(request, binding);
        return { body, read: (response, signal, limit, controls) => (stream ? readEventStream(response, signal, limit, new ResponsesStream(source, signal, controls)) : readJsonReply(response, signal, limit, (value) => acceptResponsesReply(value, source))) };
      },
    });
  }

  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.#transport.inspectRequest(request);
  }

  reserveWireBytes(request: ModelRequest, reservation: ModelRequestReservation): number {
    const bound = reserveResponsesWireBytes(this.inspectRequest(request).wireBytes, request, reservation);
    assertResponsesReservation(request, reservation);
    return bound;
  }

  complete(request: ModelRequest, controls?: ModelControls): Promise<OpenAIResponsesReply> {
    return this.#transport.complete(request, controls);
  }
}
