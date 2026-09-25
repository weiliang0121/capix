import type { ClientTransport } from '@capix-observer/client-runtime';
import type { ExecutionRequest, RuntimeSnapshot } from '@capix-observer/protocol';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { HttpTransport } from './transport.js';
import { HttpError, ObserverTransportError, type HttpResponseInfo } from './errors.js';
import { acceptResponse, acceptSnapshot, configurationResponse, overviewResponse, transcriptResponse, memoryResponse, sourceResponse } from './responses.js';
import { readLines } from './stream.js';

/** The current Observer HTTP and snapshot-stream contract. */
export class ObserverHttpTransport extends HttpTransport implements ClientTransport {
  protected override statusError(info: HttpResponseInfo, body: unknown): HttpError {
    if (!isPlainObject(body)) return super.statusError(info, body);
    return new HttpError(info, body, 'status', isString(body.error) ? body.error : undefined, isString(body.code) ? body.code : undefined);
  }

  async config() {
    return acceptResponse(configurationResponse, await this.get('/api/config'), '配置');
  }
  async overview() {
    return acceptResponse(overviewResponse, await this.get('/api/executions'), '执行概览');
  }
  async transcript() {
    return acceptResponse(transcriptResponse, await this.get('/api/transcript'), '消息');
  }
  async memory() {
    return acceptResponse(memoryResponse, await this.get('/api/memory'), '记忆');
  }
  async source(path: string, signal?: AbortSignal) {
    const source = acceptResponse(sourceResponse, await this.get(`/api/source?file=${encodeURIComponent(path)}`, signal), '源码');
    if (source.path !== path) throw new ObserverTransportError('contract', '返回的源码路径与请求不一致。', 'SOURCE_MISMATCH');
    return source;
  }
  async execution(id: string, signal?: AbortSignal) {
    return acceptSnapshot(await this.get(`/api/execution?id=${encodeURIComponent(id)}`, signal), id);
  }
  async run(request: ExecutionRequest, accept: (snapshot: RuntimeSnapshot) => void, accepted: () => void): Promise<void> {
    const response = await this.post('/api/run', request);
    try {
      deliver(accepted, '接纳通知');
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw new ObserverTransportError('contract', '服务未返回记录流。', 'MISSING_STREAM');
    let latest: RuntimeSnapshot | undefined;
    for await (const line of readLines(response.body)) {
      const snapshot = acceptUpdate(line, latest?.execution.id);
      if (latest && latest.execution.status !== 'running') throw new ObserverTransportError('contract', '执行终态之后又返回了快照。', 'AFTER_TERMINAL');
      latest = snapshot;
      deliver(() => accept(snapshot), '执行快照');
    }
    if (!latest || latest.execution.status === 'running') throw new ObserverTransportError('contract', '记录流提前结束，尚未获得执行终态。', 'INCOMPLETE_STREAM');
  }
}

function acceptUpdate(line: string, executionId?: string): RuntimeSnapshot {
  let update: unknown;
  try {
    update = JSON.parse(line);
  } catch (cause) {
    throw new ObserverTransportError('contract', '记录流 JSON 格式无效。', 'INVALID_JSON', { cause });
  }
  if (!isPlainObject(update)) throw new ObserverTransportError('contract', '记录流格式无效。', 'INVALID_UPDATE');
  if (update.type === 'error') {
    if (!isString(update.error) || ('code' in update && !isString(update.code))) throw new ObserverTransportError('contract', '记录流错误消息格式无效。', 'INVALID_UPDATE');
    throw new ObserverTransportError('remote', update.error, update.code as string | undefined);
  }
  if (update.type !== 'snapshot') throw new ObserverTransportError('contract', '未知的记录流消息。', 'INVALID_UPDATE');
  return acceptSnapshot(update.snapshot, executionId);
}

function deliver(callback: () => void, name: string): void {
  try {
    callback();
  } catch (cause) {
    throw new ObserverTransportError('delivery', `${name}接收处理失败。`, 'DELIVERY_FAILED', { cause });
  }
}
