import { isPlainObject, isString } from 'es-toolkit/predicate';
import { z } from 'zod';
import { invocationProcessStages, invocationProcessActions, validateSnapshot, type ConfigurationResponse, type ConversationUpdate, type MemoryObservation, type ObserverOverview, type RuntimeSnapshot, type SourceResponse, type TranscriptResponse, type ObservationFrame, type TranscriptUpdate } from '@capix-observer/protocol';
import { HttpError, type HttpResponseInfo, ObserverTransportError } from './errors.js';

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().nonnegative();
const id = z.string().min(1);
const status = z.enum(['running', 'succeeded', 'failed']);
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const action = z.enum(['create', 'update']);
const content = z.object({ topic: z.string(), content: z.string(), sourceIndexes: z.array(index) });
const memoryRecord = z.object({ id, parentId: id.optional(), memoryId: id, memoriesId: id, sequence: z.number().int().positive(), contextId: id.optional(), callId: id.optional(), executionId: id.optional(), operationId: id.optional(), value: z.object({ action, change: z.string(), sourceIndexes: z.array(index), result: content }) });

export const configurationResponse = z.object({ configured: z.boolean(), model: z.string(), contextBudget: index, maxOutputTokens: index, timeoutMs: index }) satisfies z.ZodType<ConfigurationResponse>;
export const transcriptResponse = z.object({ id, revision: index, start: z.literal(0), end: index, starts: z.array(index).min(1), messages: z.array(message) }) satisfies z.ZodType<TranscriptResponse>;
export const sourceResponse = z.object({ path: z.string(), content: z.string() }) satisfies z.ZodType<SourceResponse>;
export const memoryResponse = z.object({ items: z.array(z.object({ id, topic: z.string(), content: z.string(), sources: z.array(z.object({ transcriptId: id, index })), records: z.array(memoryRecord) })) }) satisfies z.ZodType<MemoryObservation>;
export const overviewResponse = z.object({
  transcriptId: z.string(),
  messages: z.array(z.object({ index, count: index })),
  executions: z.array(
    z.object({
      id,
      startedAt: z.string(),
      status,
      inputIndex: index,
      selections: z.array(z.object({ operationId: id, status, indexes: z.array(index).optional() })),
      response: z.object({ index: index.optional() }).optional(),
      memoryStatus: status.optional(),
      durationMs: time.optional(),
      observedOffsetMs: time,
      calls: z.array(z.object({ id, contextId: id, recordType: z.enum(['execution', 'operation', 'attempt']), parentId: id.optional(), name: z.string(), label: z.string(), source: z.string(), status, offsetMs: time, durationMs: time.optional() })),
      transcriptRange: z.object({ transcriptId: id, start: index, end: index, revision: index.optional() }).optional(),
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

export const conversationUpdate = z.discriminatedUnion('type', [z.object({ type: z.literal('started'), contextId: id, transcriptId: id, inputIndex: index }), z.object({ type: z.literal('answer'), contextId: id, transcriptId: id, index, output: z.object({ kind: z.enum(['answer', 'unknown', 'needs-info']), content: z.string() }) }), z.object({ type: z.literal('completed'), contextId: id }), z.object({ type: z.literal('error'), error: z.string(), code: z.string().optional() })]) satisfies z.ZodType<ConversationUpdate>;

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

const recordData = z.object({ id, parentId: id.optional(), value: z.unknown() }).passthrough();
const callBody = z.object({ input: z.unknown(), processes: z.array(z.unknown()) }).passthrough();
const callRecord = recordData.extend({ contextId: id, status, childIds: z.array(id).optional(), value: callBody });
const entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime'), data: recordData.extend({ childIds: z.array(id), value: z.object({ createdAt: z.string() }) }) }),
  z.object({ kind: z.literal('execution'), data: callRecord.extend({ value: callBody.extend({ startedAt: z.string() }) }) }),
  z.object({ kind: z.literal('operation'), data: callRecord.extend({ executionId: id, operationInstanceId: id, parentOperationId: id.optional(), operation: z.string(), label: z.string(), source: z.string(), caller: z.string(), callee: z.string() }) }),
  z.object({ kind: z.literal('attempt'), data: callRecord.extend({ operationId: id, name: z.string(), label: z.string(), source: z.string(), caller: z.string(), callee: z.string() }) }),
  z.object({ kind: z.literal('invocation-boundary'), data: recordData.extend({ executionId: id, callId: id, sequence: index.min(1), occurredAt: z.string(), offsetMs: time, value: z.object({ type: z.enum(['call', 'return', 'throw']) }) }) }),
  z.object({ kind: z.literal('memory'), data: memoryRecord }),
  z.object({ kind: z.literal('transcript'), data: recordData.extend({ transcriptId: id, revision: index.min(1), occurredAt: z.string(), contextId: id.optional(), callId: id.optional(), executionId: id.optional(), value: z.discriminatedUnion('action', [z.object({ action: z.literal('append'), start: index, end: index }), z.object({ action: z.literal('segment'), previousStart: index, start: index, end: index })]) }) }),
  z.object({ kind: z.literal('resource'), data: recordData.extend({ parentId: id, access: id, supplyId: id, sequence: index.min(1), occurredAt: z.string(), phase: z.enum(['bound', 'available', 'unavailable', 'started', 'returned', 'threw']), interactionId: id.optional() }) }),
  z.object({ kind: z.literal('custom'), data: recordData }),
]);
const failure = z.object({ kind: z.enum(['exception', 'error']), phase: z.enum(['setup', 'execute', 'receive', 'handling', 'control', 'observation']), contextId: id, contract: id.optional() });
const process = z.object({ sequence: index.min(1), round: index, occurredAt: z.string(), offsetMs: time, stage: z.enum(invocationProcessStages), type: z.enum(invocationProcessActions), failure: failure.optional() }).passthrough();
const transcriptEvent = z.object({ type: z.literal('transcript'), transcriptId: id, revision: index.min(1), occurredAt: z.string(), origin: z.object({ contextId: id }).optional(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('messages-appended'), start: index, messages: z.array(message).min(1) }), z.object({ kind: z.literal('segment-started'), previousStart: index, start: index, end: index })]) });
const transcriptObservation = transcriptEvent.extend({ change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('messages-appended'), start: index, end: index }), z.object({ kind: z.literal('segment-started'), previousStart: index, start: index, end: index })]) });
export const transcriptUpdate = z.discriminatedUnion('type', [z.object({ type: z.literal('baseline'), snapshot: transcriptResponse }), z.object({ type: z.literal('delta'), event: transcriptEvent }), z.object({ type: z.literal('error'), error: z.string(), code: z.string() })]) satisfies z.ZodType<TranscriptUpdate>;
const memoryEvent = z.object({ type: z.literal('memory'), memoriesId: id, sequence: index.min(1), occurredAt: z.string(), origin: z.object({ contextId: id }).optional(), change: z.object({ action, memoryId: id, explanation: z.string(), sourceIndexes: z.array(index), result: content }) });
const recordEvent = z.object({ type: z.literal('record'), recorderId: id, revision: index.min(1), occurredAt: z.string(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('added'), entry, parent: z.object({ id, childId: id }).optional() }), z.object({ kind: z.literal('process-appended'), id, process }), z.object({ kind: z.literal('finished'), id, status: z.enum(['succeeded', 'failed']), result: z.object({ output: z.unknown().optional(), resultOf: index.min(1).optional(), error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(), failure: failure.optional() }) }), z.object({ kind: z.literal('replaced'), entry })]) });
const invocationEvent = z.object({ type: z.literal('invocation'), contextId: id, parentContextId: id.optional(), level: z.enum(['execution', 'operation', 'attempt']), sequence: index.min(1), occurredAt: z.string(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('started') }), z.object({ kind: z.literal('process'), processSequence: index.min(1), round: index, stage: z.enum(invocationProcessStages), action: z.enum(invocationProcessActions) }), z.object({ kind: z.literal('finished'), status: z.enum(['succeeded', 'failed']) })]) });
const observationFrame = z.discriminatedUnion('type', [z.object({ type: z.literal('baseline'), scopeId: id, sequence: index, overview: overviewResponse, memory: memoryResponse, transcript: z.object({ id, revision: index, starts: z.array(index).min(1) }), memories: z.object({ id, sequence: index }), recorder: z.object({ id, revision: index }), entries: z.array(entry), invocations: z.array(invocationEvent) }), z.object({ type: z.literal('delta'), scopeId: id, sequence: index.min(1), changes: z.array(z.discriminatedUnion('type', [transcriptObservation, memoryEvent, recordEvent, invocationEvent])).min(1) })]);
export function acceptObservationFrame(value: unknown): ObservationFrame {
  // Detailed call/IO relationships are checked after the corresponding boundaries arrive.
  return acceptResponse(observationFrame, value, '观测增量') as ObservationFrame;
}
