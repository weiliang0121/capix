import { isPlainObject, isString } from 'es-toolkit/predicate';
import { z } from 'zod';
import { invocationProcessStages, invocationProcessActions, validateExecutionRecordSnapshot, type ConversationAdmission, type ConfigurationResponse, type ConversationSubmissionSnapshot, type MemoryObservation, type ObserverOverview, type ExecutionRecordSnapshot, type SourceResponse, type TranscriptResponse, type ObservationFrame, type TranscriptUpdate } from '@capix/protocol';
import { HttpError, type HttpResponseInfo, HttpTransportError } from './errors.js';

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().nonnegative();
const id = z.string().min(1);
const status = z.enum(['running', 'succeeded', 'failed']);
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const action = z.enum(['create', 'update']);
const content = z.object({ topic: z.string(), content: z.string(), sourceIndexes: z.array(index) });
const memoryRecord = z.object({ id, parentId: id.optional(), memoryId: id, memoriesId: id, sequence: z.number().int().positive(), contextId: id.optional(), callId: id.optional(), executionId: id.optional(), operationId: id.optional(), value: z.object({ action, change: z.string(), sourceIndexes: z.array(index), result: content }) });

export const configurationResponse = z.object({ configured: z.boolean(), model: z.string(), contextBudget: index, maxOutputTokens: index, timeoutMs: index, files: z.object({ maxReadBytes: index.positive(), maxWriteBytes: index.positive() }).optional() }) satisfies z.ZodType<ConfigurationResponse>;
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
export function acceptResponse<Response>(schema: z.ZodType<Response>, value: unknown, name: string): Response {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpTransportError('contract', `${name}响应格式无效。`, 'INVALID_RESPONSE', { cause: result.error });
  return result.data;
}

export function acceptSnapshot(value: unknown, expectedId?: string): ExecutionRecordSnapshot {
  try {
    validateExecutionRecordSnapshot(value);
  } catch (cause) {
    throw new HttpTransportError('contract', '运行记录格式无效或关联缺失。', 'INVALID_SNAPSHOT', { cause });
  }
  if (expectedId && value.execution.id !== expectedId) throw new HttpTransportError('contract', '返回了不同执行的记录。', 'EXECUTION_MISMATCH');
  return value;
}

const conversationFailure = z.object({ code: id, message: z.string() });
export const admissionResponse = z.discriminatedUnion('status', [z.object({ transcriptId: id, status: z.literal('ready') }), z.object({ transcriptId: id, status: z.literal('busy') }), z.object({ transcriptId: id, status: z.literal('unavailable'), error: conversationFailure })]) satisfies z.ZodType<ConversationAdmission>;
const conversationActivities = z.object({
  calls: z.array(z.object({ contextId: id.max(256), parentContextId: id.max(256).optional(), level: z.enum(['runtime', 'execution', 'operation', 'attempt']), label: z.string().max(120), status: z.enum(['running', 'succeeded', 'failed', 'cancelled']), phase: z.enum(['setup', ...invocationProcessStages]), round: index.max(2), startedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(), relation: z.object({ phase: z.enum(['attached', 'returned', 'receiving', 'accepted', 'failed']), returned: z.enum(['succeeded', 'failed', 'cancelled']).optional() }).optional() })).max(512),
  integrity: z.discriminatedUnion('status', [z.object({ status: z.literal('complete') }), z.object({ status: z.literal('incomplete'), error: conversationFailure })]),
});
const fileTask = z.union([z.object({ sourcePath: id, output: z.object({ path: id }).optional() }), z.object({ sourcePath: z.never().optional(), output: z.object({ path: id }) })]);
const conversationTask = z.discriminatedUnion('kind', [z.object({ kind: z.literal('reply') }), z.object({ kind: z.literal('file'), task: fileTask }), z.object({ kind: z.literal('clarify') }), z.object({ kind: z.literal('unsupported') })]);
export const submissionResponse = z.object({
  submissionId: id,
  revision: index,
  input: z.object({ transcriptId: id, start: index, end: index, revision: index.optional() }).optional(),
  answer: z.object({ transcriptId: id, index }).optional(),
  executions: z.array(z.object({ contextId: id })),
  activities: conversationActivities.optional(),
  task: conversationTask.optional(),
  fileOutput: z.discriminatedUnion('status', [z.object({ status: z.literal('pending'), path: id }), z.object({ status: z.literal('created'), receipt: z.object({ path: id, bytes: index, digest: z.string().regex(/^[a-f0-9]{64}$/u) }) }), z.object({ status: z.literal('not-created'), path: id, reason: z.enum(['not-started', 'cancelled', 'failed']) }), z.object({ status: z.literal('unconfirmed'), path: id })]).optional(),
  cancelRequested: z.literal(true).optional(),
  admission: admissionResponse.optional(),
  result: z.discriminatedUnion('status', [z.object({ status: z.literal('completed'), retry: z.never().optional() }), z.object({ status: z.literal('cancelled'), retry: z.never().optional() }), z.object({ status: z.literal('failed'), error: conversationFailure, retry: z.never().optional() }), z.object({ status: z.literal('rejected'), error: conversationFailure, retry: z.literal('admission').optional() })]).optional(),
  integrity: z.discriminatedUnion('status', [z.object({ status: z.literal('complete') }), z.object({ status: z.literal('incomplete'), error: conversationFailure })]),
}) satisfies z.ZodType<ConversationSubmissionSnapshot>;

/** Both endpoints use the service error envelope; the HTTP base stays protocol-neutral. */
export function responseStatusError(info: HttpResponseInfo, body: unknown): HttpError {
  if (!isPlainObject(body)) return new HttpError(info, body, 'status');
  return new HttpError(info, body, 'status', isString(body.error) ? body.error : undefined, isString(body.code) ? body.code : undefined);
}

export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw new HttpTransportError('contract', '流 JSON 格式无效。', 'INVALID_JSON', { cause });
  }
}

export function deliver(callback: () => void, name: string): void {
  try {
    callback();
  } catch (cause) {
    throw new HttpTransportError('delivery', `${name}接收处理失败。`, 'DELIVERY_FAILED', { cause });
  }
}

const recordData = z.object({ id, parentId: id.optional(), value: z.unknown() }).passthrough();
const callBody = z.object({ input: z.unknown(), processes: z.array(z.unknown()) }).passthrough();
const callRecord = recordData.extend({ contextId: id, status, childIds: z.array(id).optional(), value: callBody });
const entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime'), data: recordData.extend({ childIds: z.array(id), value: z.object({ createdAt: z.string() }) }) }),
  z.object({ kind: z.literal('runtime-call'), data: callRecord.extend({ runtimeInstanceId: id, value: callBody.extend({ startedAt: z.string() }) }) }),
  z.object({ kind: z.literal('execution'), data: callRecord.extend({ value: callBody.extend({ startedAt: z.string() }) }) }),
  z.object({ kind: z.literal('operation'), data: callRecord.extend({ executionId: id, operationInstanceId: id, parentOperationId: id.optional(), operation: z.string(), label: z.string(), source: z.string(), caller: z.string(), callee: z.string() }) }),
  z.object({ kind: z.literal('attempt'), data: callRecord.extend({ operationId: id, name: z.string(), label: z.string(), source: z.string(), caller: z.string(), callee: z.string() }) }),
  z.object({ kind: z.literal('invocation-boundary'), data: recordData.extend({ scopeId: id, executionId: id.optional(), callId: id, sequence: index.min(1), occurredAt: z.string(), offsetMs: time, value: z.object({ type: z.enum(['call', 'return', 'throw']), scope: z.literal('work') }) }) }),
  z.object({ kind: z.literal('memory'), data: memoryRecord }),
  z.object({ kind: z.literal('transcript'), data: recordData.extend({ transcriptId: id, revision: index.min(1), occurredAt: z.string(), contextId: id.optional(), callId: id.optional(), executionId: id.optional(), value: z.discriminatedUnion('action', [z.object({ action: z.literal('append'), start: index, end: index }), z.object({ action: z.literal('segment'), previousStart: index, start: index, end: index })]) }) }),
  z.object({ kind: z.literal('resource'), data: recordData.extend({ parentId: id, access: id, supplyId: id, sequence: index.min(1), occurredAt: z.string(), phase: z.enum(['bound', 'available', 'unavailable', 'started', 'returned', 'threw']), interactionId: id.optional() }) }),
  z.object({ kind: z.literal('custom'), data: recordData }),
]);
const failure = z.object({ kind: z.enum(['exception', 'error']), phase: z.enum(['setup', 'execute', 'receive', 'handling', 'control', 'observation']), contextId: id, contract: id.optional() });
const process = z.object({ sequence: index.min(1), eventSequence: index.min(1), round: index, occurredAt: z.string(), offsetMs: time, stage: z.enum(invocationProcessStages), type: z.enum(invocationProcessActions), failure: failure.optional() }).passthrough();
const relationIdentity = z.object({ parentContextId: id, childContextId: id, parentRound: index.max(2), key: id.optional() });
const relation = z.object({ identity: relationIdentity, eventSequence: index.min(1), occurredAt: z.string(), offsetMs: time, childId: id.optional(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('attached') }), z.object({ kind: z.literal('returned'), result: z.discriminatedUnion('status', [z.object({ status: z.literal('succeeded'), output: z.unknown() }), z.object({ status: z.literal('failed'), error: z.object({ code: id, message: z.string() }).passthrough(), failure: failure.optional() })]) }), z.object({ kind: z.literal('receiving') }), z.object({ kind: z.literal('accepted'), output: z.unknown() }), z.object({ kind: z.literal('failed'), source: z.enum(['work', 'observation']), error: z.object({ code: id, message: z.string() }).passthrough(), failure: failure.optional() })]) });
const transcriptEvent = z.object({ type: z.literal('transcript'), transcriptId: id, revision: index.min(1), occurredAt: z.string(), origin: z.object({ contextId: id }).optional(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('messages-appended'), start: index, messages: z.array(message).min(1) }), z.object({ kind: z.literal('segment-started'), previousStart: index, start: index, end: index })]) });
const transcriptObservation = transcriptEvent.extend({ change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('messages-appended'), start: index, end: index }), z.object({ kind: z.literal('segment-started'), previousStart: index, start: index, end: index })]) });
export const transcriptUpdate = z.discriminatedUnion('type', [z.object({ type: z.literal('baseline'), snapshot: transcriptResponse }), z.object({ type: z.literal('delta'), event: transcriptEvent }), z.object({ type: z.literal('error'), error: z.string(), code: z.string() })]) satisfies z.ZodType<TranscriptUpdate>;
const memoryEvent = z.object({ type: z.literal('memory'), memoriesId: id, sequence: index.min(1), occurredAt: z.string(), origin: z.object({ contextId: id }).optional(), change: z.object({ action, memoryId: id, explanation: z.string(), sourceIndexes: z.array(index), result: content }) });
const recordEvent = z.object({ type: z.literal('record'), recorderId: id, revision: index.min(1), occurredAt: z.string(), change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('added'), entry, parent: z.object({ id, childId: id }).optional() }), z.object({ kind: z.literal('process-appended'), id, process }), z.object({ kind: z.literal('relation-appended'), id, relation }), z.object({ kind: z.literal('finished'), id, status: z.enum(['succeeded', 'failed']), result: z.object({ output: z.unknown().optional(), resultOf: index.min(1).optional(), error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(), failure: failure.optional() }) }), z.object({ kind: z.literal('replaced'), entry })]) });
const invocationEvent = z.object({
  type: z.literal('invocation'),
  contextId: id,
  parentContextId: id.optional(),
  level: z.enum(['runtime', 'execution', 'operation', 'attempt']),
  sequence: index.min(1),
  occurredAt: z.string(),
  change: z.discriminatedUnion('kind', [z.object({ kind: z.literal('started') }), z.object({ kind: z.literal('entry'), target: z.literal('execution'), instanceId: id, key: id.optional(), stage: z.enum(['accept', 'notification', 'admit', 'capture']), status: z.enum(['accepted', 'failed']), error: z.object({ code: id, message: z.string() }).passthrough().optional() }), z.object({ kind: z.literal('process'), processSequence: index.min(1), round: index, stage: z.enum(invocationProcessStages), action: z.enum(invocationProcessActions) }), z.object({ kind: z.literal('relation'), identity: relationIdentity, phase: z.enum(['attached', 'returned', 'receiving', 'accepted', 'failed']), status: z.enum(['succeeded', 'failed']).optional(), failure: failure.optional() }), z.object({ kind: z.literal('finished'), status: z.enum(['succeeded', 'failed']) })]),
});
const observationFrame = z.discriminatedUnion('type', [z.object({ type: z.literal('baseline'), scopeId: id, sequence: index, overview: overviewResponse, memory: memoryResponse, transcript: z.object({ id, revision: index, starts: z.array(index).min(1) }), memories: z.object({ id, sequence: index }), recorder: z.object({ id, revision: index }), entries: z.array(entry), invocations: z.array(invocationEvent) }), z.object({ type: z.literal('delta'), scopeId: id, sequence: index.min(1), changes: z.array(z.discriminatedUnion('type', [transcriptObservation, memoryEvent, recordEvent, invocationEvent])).min(1) })]);
export function acceptObservationFrame(value: unknown): ObservationFrame {
  // Detailed call/IO relationships are checked after the corresponding boundaries arrive.
  return acceptResponse(observationFrame, value, '观测增量') as ObservationFrame;
}
