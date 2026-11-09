import { observationStatus } from './status.js';
import { hasOutput, readOutput, validateExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';
import type { ExecutionRecordSnapshot, CallableRecord, InvocationValue, GenerationOutput } from '@weiliang0121/capix-protocol';
import type { CallSpan, Trace } from './types.js';
export { validateExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';

/** A task is selected by the service. Every call keeps its actual kind and direct parent. */
export function projectExecution(facts: ExecutionRecordSnapshot): Trace {
  validateExecutionRecordSnapshot(facts);
  const execution = facts.execution;
  const startedAt = execution.value.startedAt;
  if (startedAt === undefined) throw new Error('Conversation task has no recorded start');
  const starts = new Map(facts.boundaries.filter((event) => event.value.type === 'call').map((event) => [event.callId, event]));
  const ends = new Map(facts.boundaries.filter((event) => event.value.type !== 'call').map((event) => [event.callId, event]));
  const origin = starts.get(execution.id);
  const byId = new Map([...facts.calls, ...(facts.ancestors ?? []), ...(facts.rootCall ? [facts.rootCall] : [])].map((call) => [call.id, call]));
  const result = (id: string, body: InvocationValue, status: CallableRecord['status']) => {
    const start = starts.get(id);
    const end = ends.get(id);
    return {
      status: status === 'succeeded' ? ('passed' as const) : observationStatus(status, facts.archive),
      offsetMs: start && origin ? (start.scopeId === origin.scopeId ? start.offsetMs - origin.offsetMs : Date.parse(start.occurredAt) - Date.parse(origin.occurredAt)) : 0,
      ...(start && end ? { durationMs: end.offsetMs - start.offsetMs } : {}),
      input: body.input,
      processes: body.processes,
      ...(hasOutput(body) ? { output: readOutput(body) } : {}),
      ...(body.error ? { error: body.error } : {}),
      ...(body.failure ? { failure: body.failure } : {}),
    };
  };
  const calls: CallSpan[] = facts.calls.map((call) => ({
    recordType: call.structureKind,
    contextId: call.contextId,
    id: call.id,
    executionId: execution.id,
    operationInstanceId: call.structureId,
    operation: call.name,
    ...(call.parentId ? { parentId: call.parentId } : {}),
    caller: (call.parentId ? byId.get(call.parentId)?.structureKind : undefined) ?? 'caller',
    callee: call.structureKind,
    target: call.callee,
    label: call.label ?? call.name ?? '调用',
    source: call.source ?? '',
    ...result(call.id, call.value, call.status),
  }));
  calls.sort((left, right) => (starts.get(left.id)?.sequence ?? 0) - (starts.get(right.id)?.sequence ?? 0));
  const root = calls.find((call) => call.id === execution.id)!;
  const groups = new Map<string, Trace['nodes'][number]['group']>();
  for (const call of calls) {
    const operation = call.operation;
    const group = operation && ['selection', 'prepareContext', 'maintainContext'].includes(operation) ? 'selection' : operation === 'answer' || operation === 'processDocument' ? 'answer' : operation === 'memory' ? 'memory' : ((call.parentId ? groups.get(call.parentId) : undefined) ?? 'flow');
    groups.set(call.id, group);
  }
  const ownIds = new Set(facts.calls.map((call) => call.id));
  const events = facts.boundaries.filter((event) => ownIds.has(event.callId));
  return {
    facts,
    id: execution.id,
    startedAt,
    durationMs: root.durationMs ?? Math.max(0, ...calls.map((call) => call.offsetMs + (call.durationMs ?? 0))),
    status: observationStatus(execution.status, facts.archive),
    nodes: calls.map((call) => ({ ...call, group: groups.get(call.id)! })),
    callSequence: {
      version: 1,
      calls,
      events,
      participants: [
        { id: 'caller', label: '调用方', description: '调用入口' },
        { id: 'scene', label: 'Scene', description: '整体场景的处理' },
        { id: 'group', label: 'Group', description: '组合成员并实现整体处理' },
        { id: 'node', label: 'Node', description: '直接处理，可以访问本地实体或外部交互' },
      ],
    },
    ...(root.status === 'passed' ? { result: root.output as GenerationOutput } : {}),
    ...(root.error ? { error: root.error } : {}),
    ...(root.failure ? { failure: root.failure } : {}),
  };
}
