import { ProviderError } from './error.js';
import { acceptGeminiReply } from './gemini-reply.js';
import { GeminiStream } from './gemini-stream.js';
import { encodeGeminiRequest } from './gemini-wire.js';
import { reserveGeminiWireBytes } from './reservation.js';
import { readJsonReply } from './response.js';
import { readEventStream } from './sse.js';
import { ModelHttpTransport } from './transport.js';
import type { GeminiGenerateContentConfiguration, GeminiGenerateContentReply, ModelControls, ModelProvider, ModelRequest, ModelRequestInspection, ModelRequestReservation } from './types.js';

export class GeminiGenerateContentProvider implements ModelProvider {
  readonly #transport: ModelHttpTransport<GeminiGenerateContentReply>;

  constructor(configuration: GeminiGenerateContentConfiguration) {
    const { bindingId, model } = configuration;
    if (typeof bindingId !== 'string' || !bindingId.trim() || bindingId.length > 256 || typeof model !== 'string' || !model.trim() || model.length > 256 || /\p{Surrogate}/u.test(model)) throw new ProviderError('CONFIGURATION', 'Gemini requires a binding identity and a model name');
    const binding = { bindingId, model };
    this.#transport = new ModelHttpTransport(configuration, {
      format: 'gemini-generate-content',
      headers: (apiKey) => ({ 'x-goog-api-key': apiKey }),
      streamEndpoint(endpoint) {
        if (!endpoint.pathname.endsWith('/models/' + encodeURIComponent(model) + ':generateContent')) throw new ProviderError('CONFIGURATION', 'Gemini endpoint must address the configured model and generateContent method');
        endpoint.pathname = endpoint.pathname.slice(0, -':generateContent'.length) + ':streamGenerateContent';
        endpoint.searchParams.set('alt', 'sse');
        return endpoint.href;
      },
      encode(request, stream) {
        const { body, source } = encodeGeminiRequest(request, binding);
        return { body, read: (response, signal, limit, controls) => (stream ? readEventStream(response, signal, limit, new GeminiStream(source, signal, controls)) : readJsonReply(response, signal, limit, (value) => acceptGeminiReply(value, source))) };
      },
    });
  }

  inspectRequest(request: ModelRequest): ModelRequestInspection {
    return this.#transport.inspectRequest(request);
  }

  reserveWireBytes(request: ModelRequest, reservation: ModelRequestReservation): number {
    return reserveGeminiWireBytes(this.inspectRequest(request).wireBytes, request, reservation);
  }

  complete(request: ModelRequest, controls?: ModelControls): Promise<GeminiGenerateContentReply> {
    return this.#transport.complete(request, controls);
  }
}
