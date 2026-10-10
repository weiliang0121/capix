import type { ObservationTransport } from '@capix/client-runtime';
import type { ObservationFrame } from '@capix/protocol';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { HttpTransport } from './transport.js';
import { HttpTransportError } from './errors.js';
import { acceptResponse, acceptSnapshot, acceptObservationFrame, overviewResponse, memoryResponse, sourceResponse, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';

/** Observation queries and subscriptions, independent of conversation delivery. */
export class ObservationHttpTransport extends HttpTransport implements ObservationTransport {
  protected override statusError = responseStatusError;

  async overview() {
    return acceptResponse(overviewResponse, await this.get('/api/executions'), '执行概览');
  }
  async memory() {
    return acceptResponse(memoryResponse, await this.get('/api/memory'), '记忆');
  }
  async source(path: string, signal?: AbortSignal) {
    const source = acceptResponse(sourceResponse, await this.get(`/api/source?file=${encodeURIComponent(path)}`, signal), '源码');
    if (source.path !== path) throw new HttpTransportError('contract', '返回的源码路径与请求不一致。', 'SOURCE_MISMATCH');
    return source;
  }
  async execution(id: string, signal?: AbortSignal) {
    return acceptSnapshot(await this.get(`/api/execution?id=${encodeURIComponent(id)}`, signal), id);
  }
  async observe(accept: (frame: ObservationFrame) => void, signal: AbortSignal): Promise<void> {
    const response = await this.send('/api/observe', { signal });
    if (!response.body) throw new HttpTransportError('contract', '服务未返回记录流。', 'MISSING_STREAM');
    for await (const line of readLines(response.body)) {
      const update = parseLine(line);
      if (!isPlainObject(update)) throw new HttpTransportError('contract', '记录流格式无效。', 'INVALID_UPDATE');
      if (update.type === 'error' && isString(update.error)) throw new HttpTransportError('remote', update.error, isString(update.code) ? update.code : undefined);
      const frame = acceptObservationFrame(update);
      deliver(() => accept(frame), '观测变化');
    }
    if (!signal.aborted) throw new HttpTransportError('contract', '观测连接已结束。', 'INCOMPLETE_STREAM');
  }
}
