import { readOutput, validateExecutionRecordSnapshot, type InvocationSummary, type ObserverOverview, type ExecutionRecordSnapshot } from '@capix/protocol';
import { isNumber, isPlainObject, isString } from 'es-toolkit/predicate';
import { executionResources } from './resources.js';
import { isArray } from 'es-toolkit/compat';

function object(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
/** Live snapshots are projected locally; list loading never fetches all detail records. */
export function updateOverview(previous: ObserverOverview, snapshot: ExecutionRecordSnapshot): ObserverOverview {
  return updateOverviews(previous, [snapshot]);
}

/** One delivery can affect multiple E under an R; update their selection contributions once. */
export function updateOverviews(previous: ObserverOverview, snapshots: Iterable<ExecutionRecordSnapshot>): ObserverOverview {
  const byId = new Map(previous.executions.map((item) => [item.id, item]));
  const counts = new Map<number, number>();
  let transcriptId = previous.transcriptId;
  let changed = false;
  const contribute = (execution: ObserverOverview['executions'][number] | undefined, direction: number) => {
    for (const selection of execution?.selections ?? []) for (const index of new Set(selection.indexes ?? [])) counts.set(index, (counts.get(index) ?? 0) + direction);
  };
  for (const snapshot of snapshots) {
    const existing = byId.get(snapshot.execution.id);
    const item = projectExecutionSummary(snapshot, existing, previous.messages.length);
    contribute(existing, -1);
    contribute(item, 1);
    byId.set(item.id, item);
    transcriptId = item.transcriptRange?.transcriptId ?? transcriptId;
    changed = true;
  }
  if (!changed) return previous;
  const messages = previous.messages.map((message) => {
    const delta = counts.get(message.index) ?? 0;
    return delta ? { ...message, count: message.count + delta } : message;
  });
  return { ...previous, transcriptId, executions: [...byId.values()], messages };
}

function projectExecutionSummary(snapshot: ExecutionRecordSnapshot, existing: ObserverOverview['executions'][number] | undefined, fallbackInputIndex: number): ObserverOverview['executions'][number] {
  validateExecutionRecordSnapshot(snapshot);
  const starts = new Map(snapshot.events.filter((event) => event.value.type === 'call').map((event) => [event.callId, event]));
  const ends = new Map(snapshot.events.filter((event) => event.value.type !== 'call').map((event) => [event.callId, event]));
  const records = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts];
  const calls: InvocationSummary[] = [{ ...snapshot.execution, recordType: 'execution' as const, name: 'execution', label: '执行调用', source: 'server/runtime/src/structure/execution.ts · BoundExecution.create' }, ...snapshot.operations.map((record) => ({ ...record, recordType: 'operation' as const, name: record.operation, parentId: record.parentOperationId ?? record.executionId })), ...snapshot.attempts.map((record) => ({ ...record, recordType: 'attempt' as const, parentId: record.operationId }))].map((record) => {
    const start = starts.get(record.id);
    const end = ends.get(record.id);
    return { id: record.id, contextId: record.contextId, recordType: record.recordType, ...('parentId' in record ? { parentId: record.parentId } : {}), name: record.name, label: record.label, source: record.source, status: record.status, offsetMs: start?.offsetMs ?? 0, ...(end && start ? { durationMs: end.offsetMs - start.offsetMs } : {}) };
  });
  calls.sort((a, b) => (starts.get(a.id)?.sequence ?? Number.MAX_SAFE_INTEGER) - (starts.get(b.id)?.sequence ?? Number.MAX_SAFE_INTEGER));
  const observedOffsetMs = Math.max(snapshot.events.at(-1)?.offsetMs ?? 0, ...records.map((record) => record.value.processes.at(-1)?.offsetMs ?? 0));
  const durationMs = calls.find((call) => call.recordType === 'execution')?.durationMs;
  const range = executionResources(snapshot).transcriptRange;
  const inputIndex = range ? range.end - 1 : (existing?.inputIndex ?? fallbackInputIndex);
  const selections = snapshot.operations.filter((operation) => operation.operation === 'selection' || operation.operation === 'prepareContext');
  const response = snapshot.operations.find((operation) => operation.operation === 'answer' && operation.status === 'succeeded');
  const responseValue = response ? object(readOutput(response.value)) : {};
  const preparation = selections.find((operation) => operation.operation === 'prepareContext' && operation.status === 'succeeded');
  const memoryInput = preparation ? object(object(readOutput(preparation.value)).material).memories : object(selections[0]?.value.input).memories;
  const item: ObserverOverview['executions'][number] = {
    id: snapshot.execution.id,
    ...(snapshot.archive ? { archive: snapshot.archive } : {}),
    startedAt: snapshot.execution.value.startedAt,
    status: snapshot.execution.status,
    observedOffsetMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    inputIndex,
    calls,
    selections: selections.map((operation) => {
      const output = operation.status === 'succeeded' ? object(readOutput(operation.value)) : {};
      const indexes = operation.operation === 'prepareContext' ? object(output.selection).historyIndexes : output.historyIndexes;
      return { operationId: operation.id, status: operation.status, ...(isArray(indexes) && indexes.every(isNumber) ? { indexes } : {}) };
    }),
    availableMemoryIds: isArray(memoryInput) ? memoryInput.map((memory) => object(memory).id).filter(isString) : [],
    memoryChanges: existing?.memoryChanges ?? [],
    ...(range ? { transcriptRange: range } : {}),
    ...(isString(responseValue.content) ? { response: { ...(existing?.response?.index === undefined ? {} : { index: existing.response.index }) } } : {}),
    ...(snapshot.operations.find((operation) => operation.operation === 'memory') ? { memoryStatus: snapshot.operations.find((operation) => operation.operation === 'memory')!.status } : {}),
  };
  return item;
}
