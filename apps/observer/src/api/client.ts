import { validateSnapshot, type ConfigurationResponse, type ExecutionRequest, type MemoryObservation, type ObserverOverview, type RuntimeSnapshot, type SourceResponse, type TranscriptResponse } from '@capix-observer/protocol';
import { isString, isPlainObject } from 'es-toolkit/predicate';

function responseError(value: unknown, fallback: string) {
  return isPlainObject(value) && isString(value.error) ? value.error : fallback;
}
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(responseError(value, `HTTP ${response.status}`));
  return value as T;
}
export const api = {
  config: () => get<ConfigurationResponse>('/api/config'),
  overview: () => get<ObserverOverview>('/api/executions'),
  transcript: () => get<TranscriptResponse>('/api/transcript'),
  memory: () => get<MemoryObservation>('/api/memory'),
  source: (path: string, signal?: AbortSignal) => get<SourceResponse>(`/api/source?file=${encodeURIComponent(path)}`, signal),
  async execution(id: string, signal?: AbortSignal) {
    const value = await get<unknown>(`/api/execution?id=${encodeURIComponent(id)}`, signal);
    validateSnapshot(value);
    return value;
  },
};

/** Streaming decoder keeps byte and line boundaries independent of network chunks. */
export async function consumeRunStream(stream: ReadableStream<Uint8Array>, accept: (snapshot: RuntimeSnapshot) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    latest: RuntimeSnapshot | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const update: unknown = JSON.parse(line);
    if (!isPlainObject(update) || !('type' in update)) throw new Error('记录流格式无效。');
    if (update.type === 'error') throw new Error(responseError(update, '运行观测异常结束。'));
    if (update.type !== 'snapshot' || !('snapshot' in update)) throw new Error('未知的记录流消息。');
    validateSnapshot(update.snapshot);
    if (latest && latest.execution.id !== update.snapshot.execution.id) throw new Error('一次调用返回了不同执行的记录。');
    latest = update.snapshot;
    accept(latest);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!latest || latest.execution.status === 'running') throw new Error('记录流提前结束，尚未获得执行终态。');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export async function run(request: ExecutionRequest, accept: (snapshot: RuntimeSnapshot) => void, accepted: () => void): Promise<void> {
  const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error(responseError(await response.json(), `HTTP ${response.status}`));
  accepted();
  if (!response.body) throw new Error('服务未返回记录流。');
  await consumeRunStream(response.body, accept);
}
