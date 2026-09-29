import { isPlainObject, isString } from 'es-toolkit/predicate';
import { z } from 'zod';
import { validateSnapshot, type ConfigurationResponse, type ConversationUpdate, type MemoryObservation, type ObserverOverview, type RuntimeSnapshot, type SourceResponse, type TranscriptResponse } from '@capix-observer/protocol';
import { HttpError, type HttpResponseInfo, ObserverTransportError } from './errors.js';

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().nonnegative();
const id = z.string().min(1);
const status = z.enum(['running', 'succeeded', 'failed']);
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const action = z.enum(['create', 'update']);
const content = z.object({ topic: z.string(), content: z.string(), sourceIndexes: z.array(index) });
const memoryRecord = z.object({ id, memoryId: id, contextId: id.optional(), callId: id.optional(), executionId: id.optional(), operationId: id.optional(), value: z.object({ action, change: z.string(), sourceIndexes: z.array(index), result: content }) });

export const configurationResponse = z.object({ configured: z.boolean(), model: z.string(), contextBudget: index, maxOutputTokens: index, timeoutMs: index }) satisfies z.ZodType<ConfigurationResponse>;
export const transcriptResponse = z.object({ messages: z.array(message) }) satisfies z.ZodType<TranscriptResponse>;
export const sourceResponse = z.object({ path: z.string(), content: z.string() }) satisfies z.ZodType<SourceResponse>;
export const memoryResponse = z.object({ items: z.array(z.object({ id, topic: z.string(), content: z.string(), sources: z.array(z.object({ index, message })), records: z.array(memoryRecord) })) }) satisfies z.ZodType<MemoryObservation>;
export const overviewResponse = z.object({
  messages: z.array(z.object({ index, message, count: index })),
  executions: z.array(
    z.object({
      id,
      startedAt: z.string(),
      status,
      inputIndex: index,
      selections: z.array(z.object({ operationId: id, status, indexes: z.array(index).optional() })),
      response: z.object({ content: z.string(), index: index.optional() }).optional(),
      memoryStatus: status.optional(),
      durationMs: time.optional(),
      observedOffsetMs: time,
      calls: z.array(z.object({ id, contextId: id, recordType: z.enum(['execution', 'operation', 'attempt']), parentId: id.optional(), name: z.string(), label: z.string(), source: z.string(), status, offsetMs: time, durationMs: time.optional() })),
      transcriptRange: z.object({ start: index, end: index }).optional(),
      availableMemoryIds: z.array(id),
      memoryChanges: z.array(z.object({ id, memoryId: id, operationId: id.optional(), action, change: z.string() })),
    }),
  ),
}) satisfies z.ZodType<ObserverOverview>;

/** Check the response shape; domain mutations and model-output rules stay on the server. */
export function acceptResponse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ObserverTransportError('contract', `${name}响应格式无效。`, 'INVALID_RESPONSE', { cause: result.error });
  return result.data;
}

export function acceptSnapshot(value: unknown, expectedId?: string): RuntimeSnapshot {
  try {
    validateSnapshot(value);
  } catch (cause) {
    throw new ObserverTransportError('contract', '运行记录格式无效或关联缺失。', 'INVALID_SNAPSHOT', { cause });
  }
  if (expectedId && value.execution.id !== expectedId) throw new ObserverTransportError('contract', '返回了不同执行的记录。', 'EXECUTION_MISMATCH');
  return value;
}

export const conversationUpdate = z.discriminatedUnion('type', [z.object({ type: z.literal('started'), contextId: id, inputIndex: index }), z.object({ type: z.literal('answer'), contextId: id, index, output: z.object({ kind: z.enum(['answer', 'unknown', 'needs-info']), content: z.string() }) }), z.object({ type: z.literal('completed'), contextId: id }), z.object({ type: z.literal('error'), error: z.string(), code: z.string().optional() })]) satisfies z.ZodType<ConversationUpdate>;

/** Both endpoints use the service error envelope; the HTTP base stays protocol-neutral. */
export function responseStatusError(info: HttpResponseInfo, body: unknown): HttpError {
  if (!isPlainObject(body)) return new HttpError(info, body, 'status');
  return new HttpError(info, body, 'status', isString(body.error) ? body.error : undefined, isString(body.code) ? body.code : undefined);
}

export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw new ObserverTransportError('contract', '流 JSON 格式无效。', 'INVALID_JSON', { cause });
  }
}

export function deliver(callback: () => void, name: string): void {
  try {
    callback();
  } catch (cause) {
    throw new ObserverTransportError('delivery', `${name}接收处理失败。`, 'DELIVERY_FAILED', { cause });
  }
}
