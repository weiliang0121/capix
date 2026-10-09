import type { MemoryObservation, RuntimeSnapshot } from '@capix-observer/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import { executionResources } from './resources.js';
import { projectExecution } from '../observation/project.js';
import type { CallSpan } from '../observation/types.js';
import type { CallMemory, ExecutionDetail } from '../state/data.js';

export function projectDetail(snapshot: RuntimeSnapshot, memory: MemoryObservation): ExecutionDetail {
  const trace = projectExecution(snapshot);
  const calls = trace.callSequence.calls;
  const memoryAt = (call?: CallSpan): CallMemory => {
    const owner = call?.recordType === 'attempt' ? snapshot.operations.find((item) => item.id === call.parentId) : call?.recordType === 'operation' ? snapshot.operations.find((item) => item.id === call.id) : snapshot.operations.find((item) => item.operation === 'selection');
    const input = isPlainObject(owner?.value.input) ? owner.value.input : {};
    const incoming = isArray(input.memories) ? input.memories.filter(isPlainObject).map((item, index) => ({ id: isString(item.id) ? item.id : String(index), topic: String(item.topic ?? ''), content: String(item.content ?? ''), sourceIndexes: isArray(item.sourceIndexes) ? item.sourceIndexes.filter(isNumber) : [] })) : [];
    const changes = memory.items.flatMap((item) => item.records).filter((record) => record.executionId === trace.id && (!call || call.recordType === 'execution' || record.operationId === owner?.id));
    return { incoming, changes };
  };
  const input = isPlainObject(snapshot.execution.value.input) ? snapshot.execution.value.input : {};
  const response = calls.find((call) => call.operation === 'answer' && call.status === 'passed')?.output;
  return {
    id: trace.id,
    startedAt: trace.startedAt,
    status: trace.status,
    contextId: snapshot.execution.contextId,
    ...executionResources(snapshot),
    resources: snapshot.resources,
    inputContent: String(input.content ?? ''),
    answer: isString(response) ? response : isPlainObject(response) && isString(response.content) ? response.content : '本轮尚无已记录的回答。',
    error: trace.error,
    children: calls.filter((call) => call.parentId === trace.id),
    memory: memoryAt(),
    calls: new Map(calls.map((call) => [call.id, { ...call, resources: snapshot.resources.filter((fact) => fact.parentId === call.id), children: calls.filter((child) => child.parentId === call.id), memory: memoryAt(call), localRounds: Math.max(0, ...call.processes.map((process) => process.round)), processEntries: call.processes.map((record) => ({ record, ...('resultOf' in record ? { reused: call.processes.find((item) => item.sequence === record.resultOf) } : {}) })) }])),
  };
}
