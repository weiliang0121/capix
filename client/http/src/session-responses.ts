import { z } from 'zod';
import { validateExecutionRecordSnapshot, validateInvocationRecordValue, type CallableRecord, type ConversationCallDetail, type ConversationInspection, type ConversationServiceInfo, type InvocationBoundaryRecord, type MemoryRecord, type ResourceRecord, type TranscriptRecord } from '@capix/protocol';
import { acceptResponse, admissionResponse, recordEntryResponse, submissionBaselineResponse } from './responses.js';
import { HttpTransportError } from './errors.js';

const id = z.string().min(1);
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const locator = z.object({ transcriptId: id, index });
export const sessionResponse = z.object({ conversationId: id, transcriptId: id, mode: z.enum(['demo', 'live']), model: id, admission: admissionResponse, active: submissionBaselineResponse.optional() }).superRefine((info, context) => {
  const active = info.active?.submission;
  if (info.admission.conversationId !== info.conversationId || info.admission.transcriptId !== info.transcriptId || (active && (active.conversationId !== info.conversationId || active.result || [active.input, active.answer, active.admission].some((item) => item && item.transcriptId !== info.transcriptId) || (active.admission && active.admission.conversationId !== info.conversationId)))) context.addIssue({ code: 'custom', message: 'Service identity and active submission disagree' });
}) satisfies z.ZodType<ConversationServiceInfo>;

const fileResult = z.object({ id, kind: z.literal('file-created'), answerIndex: index, receipt: z.object({ path: id, bytes: index, digest: z.string().regex(/^[a-f0-9]{64}$/u) }) });
export const inspectionResponse = z
  .object({
    transcriptId: id,
    memories: z.object({ id, sequence: index, items: z.array(z.object({ id, topic: z.string(), content: z.string(), sourceIndexes: z.array(index), sourceResults: z.array(fileResult).optional() })) }),
    view: z.object({ revision: index, sources: z.object({ messages: z.object({ id, scope: id }), memories: z.object({ id, scope: id }) }), members: z.array(z.discriminatedUnion('source', [z.object({ source: z.literal('messages'), key: index }), z.object({ source: z.literal('memories'), key: id })])) }),
    recording: z.object({ recorderId: id, revision: index, integrity: z.enum(['intact', 'incomplete']), calls: z.array(z.object({ id, contextId: id, name: z.string().optional(), status: z.enum(['running', 'succeeded', 'failed']), startedAt: z.string().optional(), input: locator.optional(), answer: locator.optional() })), omitted: index }),
  })
  .superRefine((value, context) => {
    const memories = new Set(value.memories.items.map((item) => item.id));
    const members = value.view.members.map((item) => JSON.stringify([item.source, item.key]));
    if (value.view.sources.messages.id !== value.transcriptId || value.view.sources.memories.id !== value.memories.id || memories.size !== value.memories.items.length || new Set(members).size !== members.length || value.view.members.some((item) => item.source === 'memories' && !memories.has(item.key)) || new Set(value.recording.calls.map((call) => call.id)).size !== value.recording.calls.length || value.recording.calls.some((call) => [call.input, call.answer].some((item) => item && item.transcriptId !== value.transcriptId))) context.addIssue({ code: 'custom', message: 'Inspection contains conflicting entity identities or members' });
  }) satisfies z.ZodType<ConversationInspection>;

// The shared wire record validator checks each record before its value reaches the UI.
// Incomplete/truncated archives still need shape checks, but cannot claim complete topology.
function record<T>(kind: 'invocation' | 'resource' | 'transcript' | 'memory' | 'invocation-boundary') {
  return z.custom<T>((value) => recordEntryResponse.safeParse({ kind, data: value }).success);
}
const callable = record<CallableRecord>('invocation').refine((value) => {
  try {
    validateInvocationRecordValue(value.value, value.contextId);
    return true;
  } catch {
    return false;
  }
});
const callDetail = z.object({ recorderId: id, revision: index, integrity: z.enum(['intact', 'incomplete']), root: callable, calls: z.array(callable), resources: z.array(record<ResourceRecord>('resource')), transcripts: z.array(record<TranscriptRecord>('transcript')), memories: z.array(record<MemoryRecord>('memory')), boundaries: z.array(record<InvocationBoundaryRecord>('invocation-boundary')), truncated: z.boolean() }) satisfies z.ZodType<ConversationCallDetail>;

export function acceptCallDetail(value: unknown, expectedId: string): ConversationCallDetail {
  const detail = acceptResponse(callDetail, value, '调用详情');
  if (detail.root.id !== expectedId || detail.root.structureKind !== 'scene' || detail.calls.some((call) => call.id === expectedId) || new Set(detail.calls.map((call) => call.id)).size !== detail.calls.length) throw new HttpTransportError('contract', '调用详情身份不一致。', 'CALL_MISMATCH');
  if (!detail.truncated && detail.integrity === 'intact') {
    try {
      validateExecutionRecordSnapshot({ execution: detail.root, calls: [detail.root, ...detail.calls], resources: detail.resources, transcripts: detail.transcripts, memories: detail.memories, boundaries: detail.boundaries });
    } catch (cause) {
      throw new HttpTransportError('contract', '调用详情的关联或终态不一致。', 'INVALID_SNAPSHOT', { cause });
    }
  }
  return detail;
}
