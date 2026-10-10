import { readOutput, validateExecutionRecordSnapshot, type InvocationSummary, type ObserverOverview, type ExecutionRecordSnapshot } from '@capix/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { executionResources } from './resources.js';
import { isArray } from 'es-toolkit/compat';

function object(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
/** Live snapshots are projected locally; list loading never fetches all detail records. */
export function updateOverview(previous: ObserverOverview, snapshot: ExecutionRecordSnapshot): ObserverOverview {
  validateExecutionRecordSnapshot(snapshot);
  const starts = new Map(snapshot.events.filter((event) => event.value.type === 'call').map((event) => [event.callId, event]));
  const ends = new Map(snapshot.events.filter((event) => event.value.type !== 'call').map((event) => [event.callId, event]));
  const records = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts];
  const calls: InvocationSummary[] = [{ ...snapshot.execution, recordType: 'execution' as const, name: 'execution', label: '执行调用', source: 'server/runtime/src/execution/execution.ts · BoundExecution.create' }, ...snapshot.operations.map((record) => ({ ...record, recordType: 'operation' as const, name: record.operation, parentId: record.parentOperationId ?? record.executionId })), ...snapshot.attempts.map((record) => ({ ...record, recordType: 'attempt' as const, parentId: record.operationId }))].map((record) => {
    const start = starts.get(record.id)!;
    const end = ends.get(record.id);
    return { id: record.id, contextId: record.contextId, recordType: record.recordType, ...('parentId' in record ? { parentId: record.parentId } : {}), name: record.name, label: record.label, source: record.source, status: record.status, offsetMs: start.offsetMs, ...(end ? { durationMs: end.offsetMs - start.offsetMs } : {}) };
  });
  calls.sort((a, b) => starts.get(a.id)!.sequence - starts.get(b.id)!.sequence);
  const existing = previous.executions.find((item) => item.id === snapshot.execution.id);
  const observedOffsetMs = Math.max(snapshot.events.at(-1)?.offsetMs ?? 0, ...records.map((record) => record.value.processes.at(-1)?.offsetMs ?? 0));
  const durationMs = calls.find((call) => call.recordType === 'execution')?.durationMs;
  const range = executionResources(snapshot).transcriptRange;
  const inputIndex = range ? range.end - 1 : (existing?.inputIndex ?? previous.messages.length);
  const selections = snapshot.operations.filter((operation) => operation.operation === 'selection');
  const response = snapshot.operations.find((operation) => operation.operation === 'answer' && operation.status === 'succeeded');
  const responseValue = response ? object(readOutput(response.value)) : {};
  const memoryInput = object(selections[0]?.value.input).memories;
  const item: ObserverOverview['executions'][number] = {
    id: snapshot.execution.id,
    startedAt: snapshot.execution.value.startedAt,
    status: snapshot.execution.status,
    observedOffsetMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    inputIndex,
    calls,
    selections: selections.map((operation) => {
      const indexes = operation.status === 'succeeded' ? object(readOutput(operation.value)).historyIndexes : undefined;
      return { operationId: operation.id, status: operation.status, ...(isArray(indexes) && indexes.every(isNumber) ? { indexes } : {}) };
    }),
    availableMemoryIds: isArray(memoryInput) ? memoryInput.map((memory) => object(memory).id).filter(isString) : [],
    memoryChanges: existing?.memoryChanges ?? [],
    ...(range ? { transcriptRange: range } : {}),
    ...(isString(responseValue.content) ? { response: { ...(existing?.response?.index === undefined ? {} : { index: existing.response.index }) } } : {}),
    ...(snapshot.operations.find((operation) => operation.operation === 'memory') ? { memoryStatus: snapshot.operations.find((operation) => operation.operation === 'memory')!.status } : {}),
  };
  const executions = existing ? previous.executions.map((value) => (value.id === item.id ? item : value)) : [...previous.executions, item];
  const messages = [...previous.messages];
  return { transcriptId: range?.transcriptId ?? previous.transcriptId, executions, messages: messages.map((message) => ({ ...message, count: executions.reduce((count, execution) => count + execution.selections.filter((selection) => selection.indexes?.includes(message.index)).length, 0) })) };
}
