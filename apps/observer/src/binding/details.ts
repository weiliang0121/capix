import { hasOutput, readOutput, type MemoryObservation, type ExecutionRecordSnapshot } from '@capix/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import { executionResources } from './resources.js';
import { projectMemoryResults } from './memory.js';
import { projectExecution } from '../observation/project.js';
import type { CallSpan } from '../observation/types.js';
import type { CallMemory, CallDetail, ExecutionDetail } from '../state/data.js';

export function projectDetail(snapshot: ExecutionRecordSnapshot, memory: MemoryObservation): ExecutionDetail {
  const trace = projectExecution(snapshot);
  const calls = trace.callSequence.calls.map((call) => (call.id === snapshot.execution.id ? { ...call, parentId: snapshot.runtimeCall.id } : call));
  const memoryAt = (call?: CallSpan): CallMemory => {
    const owner = call?.recordType === 'attempt' ? snapshot.operations.find((item) => item.id === call.parentId) : call?.recordType === 'operation' ? snapshot.operations.find((item) => item.id === call.id) : snapshot.operations.find((item) => item.operation === 'selection');
    const input = isPlainObject(owner?.value.input) ? owner.value.input : {};
    const incoming = isArray(input.memories) ? input.memories.filter(isPlainObject).map((item, index) => ({ id: isString(item.id) ? item.id : String(index), topic: String(item.topic ?? ''), content: String(item.content ?? ''), sourceIndexes: isArray(item.sourceIndexes) ? item.sourceIndexes.filter(isNumber) : [], ...(item.sourceResults === undefined ? {} : { sourceResults: projectMemoryResults(item.sourceResults) }) })) : [];
    const changes = memory.items.flatMap((item) => item.records).filter((record) => record.executionId === trace.id && (!call || call.recordType === 'execution' || record.operationId === owner?.id));
    return { incoming, changes };
  };
  const input = isPlainObject(snapshot.execution.value.input) ? snapshot.execution.value.input : {};
  const response = calls.find((call) => call.operation === 'answer' && call.status === 'passed')?.output;
  const records = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts];
  const details = new Map<string, CallDetail>(
    calls.map((call) => [
      call.id,
      {
        ...call,
        resources: snapshot.resources.filter((fact) => fact.parentId === call.id),
        children: calls.filter((child) => child.parentId === call.id),
        memory: memoryAt(call),
        localRounds: Math.max(0, ...call.processes.map((process) => process.round)),
        processEntries: call.processes.map((record) => ({ record, ...('resultOf' in record ? { reused: call.processes.find((item) => item.sequence === record.resultOf) } : {}) })),
        relationEntries: records.find((record) => record.id === call.id)?.value.relationChanges ?? [],
      },
    ]),
  );
  const parent = snapshot.runtimeCall;
  const runtimeStart = snapshot.runtimeEvents.find((event) => event.value.type === 'call');
  const runtimeEnd = snapshot.runtimeEvents.find((event) => event.value.type !== 'call');
  details.set(parent.id, {
    id: parent.id,
    contextId: parent.contextId,
    recordType: 'runtime',
    caller: 'caller',
    callee: 'runtime',
    label: '运行调用',
    source: '',
    status: parent.status === 'succeeded' ? 'passed' : parent.status,
    startedAt: parent.value.startedAt,
    offsetMs: 0,
    ...(runtimeStart && runtimeEnd ? { durationMs: runtimeEnd.offsetMs - runtimeStart.offsetMs } : {}),
    input: parent.value.input,
    ...(hasOutput(parent.value) ? { output: readOutput(parent.value) } : {}),
    error: parent.value.error,
    failure: parent.value.failure,
    processes: parent.value.processes,
    relationEntries: parent.value.relationChanges,
    processEntries: parent.value.processes.map((record) => ({ record, ...('resultOf' in record ? { reused: parent.value.processes.find((item) => item.sequence === record.resultOf) } : {}) })),
    resources: snapshot.resources.filter((fact) => fact.parentId === parent.id),
    children: calls.filter((child) => child.parentId === parent.id),
    memory: { incoming: [], changes: [] },
    localRounds: Math.max(0, ...parent.value.processes.map((process) => process.round)),
  });
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
    failure: trace.failure,
    children: calls.filter((call) => call.parentId === trace.id),
    memory: memoryAt(),
    calls: details,
  };
}
