import { ObservationConnectionError, type ObservationTransport } from '@capix/client-runtime';
import type { ObservationFrame, InteractionObservation } from '@capix/protocol';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { HttpTransport } from './transport.js';
import { HttpError, HttpTransportError } from './errors.js';
import { acceptResponse, acceptSnapshot, acceptObservationFrame, overviewResponse, memoryResponse, sourceResponse, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';
import { consumeInteraction, interactionLinksResponse } from './interaction.js';

/** Observation queries and subscriptions, independent of conversation delivery. */
export class ObservationHttpTransport extends HttpTransport implements ObservationTransport {
  protected override statusError = responseStatusError;

  async overview(conversationId: string) {
    return acceptResponse(overviewResponse, await this.get(`/api/executions?conversationId=${encodeURIComponent(conversationId)}`), '执行概览');
  }
  async memory(conversationId: string) {
    return acceptResponse(memoryResponse, await this.get(`/api/memory?conversationId=${encodeURIComponent(conversationId)}`), '记忆');
  }
  async source(path: string, signal?: AbortSignal) {
    const source = acceptResponse(sourceResponse, await this.get(`/api/source?file=${encodeURIComponent(path)}`, signal), '源码');
    if (source.path !== path) throw new HttpTransportError('contract', '返回的源码路径与请求不一致。', 'SOURCE_MISMATCH');
    return source;
  }
  async execution(conversationId: string, id: string, signal?: AbortSignal) {
    return acceptSnapshot(await this.get(`/api/execution?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(id)}`, signal), id);
  }
  async interactions(conversationId: string, callId: string, signal?: AbortSignal) {
    const links = acceptResponse(interactionLinksResponse, await this.get(`/api/interactions?conversationId=${encodeURIComponent(conversationId)}&callId=${encodeURIComponent(callId)}`, signal), '调用交互关联');
    if (links.callId !== callId) throw new HttpTransportError('contract', '返回了不同调用的交互关联。', 'CALL_MISMATCH');
    return links;
  }
  async observeInteraction(conversationId: string, callId: string, id: string, accept: (value: InteractionObservation) => void, signal: AbortSignal): Promise<void> {
    const response = await this.send(`/api/interaction/observe?conversationId=${encodeURIComponent(conversationId)}&callId=${encodeURIComponent(callId)}&id=${encodeURIComponent(id)}`, { signal });
    if (!response.body) throw new HttpTransportError('contract', '服务未返回交互观测流。', 'MISSING_STREAM');
    await consumeInteraction(response.body, id, accept);
  }
  async observe(conversationId: string, accept: (frame: ObservationFrame) => void, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.send(`/api/observe?conversationId=${encodeURIComponent(conversationId)}`, { signal });
      if (!response.body) throw new HttpTransportError('contract', '服务未返回记录流。', 'MISSING_STREAM');
      for await (const line of readLines(response.body)) {
        const update = parseLine(line);
        if (!isPlainObject(update)) throw new HttpTransportError('contract', '记录流格式无效。', 'INVALID_UPDATE');
        if (update.type === 'error' && isString(update.error)) throw new HttpTransportError('remote', update.error, isString(update.code) ? update.code : undefined);
        const frame = acceptObservationFrame(update);
        deliver(() => accept(frame), '观测变化');
      }
      if (!signal.aborted) throw new ObservationConnectionError('观测连接已结束。');
    } catch (error) {
      if (signal.aborted) throw error;
      // Source and callback failures remain terminal, including a structured source error on HTTP 503.
      if (error instanceof HttpTransportError || (error instanceof HttpError && error.code)) throw error;
      if (error instanceof TypeError || (error instanceof HttpError && error.phase === 'status' && [408, 429, 500, 502, 503, 504].includes(error.response.status))) throw new ObservationConnectionError(error.message, { cause: error });
      throw error;
    }
  }
}
