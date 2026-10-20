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
  const startedAt = snapshot.execution.value.startedAt;
  if (startedAt === undefined) throw new Error('Conversation task has no recorded start');
  const starts = new Map(snapshot.boundaries.filter((event) => event.value.type === 'call').map((event) => [event.callId, event]));
  const ends = new Map(snapshot.boundaries.filter((event) => event.value.type !== 'call').map((event) => [event.callId, event]));
  const origin = starts.get(snapshot.execution.id)!;
  const calls: InvocationSummary[] = snapshot.calls.map((record) => {
    const start = starts.get(record.id)!;
    const end = ends.get(record.id);
    const offsetMs = start.scopeId === origin.scopeId ? start.offsetMs - origin.offsetMs : Date.parse(start.occurredAt) - Date.parse(origin.occurredAt);
    return { id: record.id, contextId: record.contextId, recordType: record.structureKind, ...(record.parentId ? { parentId: record.parentId } : {}), name: record.name ?? '', label: record.label ?? record.name ?? '调用', source: record.source ?? '', status: record.status, offsetMs, ...(end ? { durationMs: end.offsetMs - start.offsetMs } : {}) };
  });
  calls.sort((a, b) => (starts.get(a.id)?.sequence ?? Number.MAX_SAFE_INTEGER) - (starts.get(b.id)?.sequence ?? Number.MAX_SAFE_INTEGER));
  const own = new Set(snapshot.calls.map((call) => call.id));
  const observedOffsetMs = Math.max(0, ...snapshot.boundaries.filter((event) => own.has(event.callId)).map((event) => (event.scopeId === origin.scopeId ? event.offsetMs - origin.offsetMs : Date.parse(event.occurredAt) - Date.parse(origin.occurredAt))), ...snapshot.calls.map((record) => (record.value.processes.at(-1)?.offsetMs ?? origin.offsetMs) - origin.offsetMs));
  const durationMs = calls.find((call) => call.id === snapshot.execution.id)?.durationMs;
  const range = executionResources(snapshot).transcriptRange;
  const inputIndex = range ? range.end - 1 : (existing?.inputIndex ?? fallbackInputIndex);
  const selections = snapshot.calls.filter((call) => call.name === 'selection' || call.name === 'prepareContext');
  const preparation = selections.find((call) => call.name === 'prepareContext' && call.status === 'succeeded');
  const memoryInput = preparation ? object(object(readOutput(preparation.value)).material).memories : object(selections[0]?.value.input).memories;
  const answer = snapshot.transcripts.find((record) => record.parentId === snapshot.execution.id && record.value.action === 'append' && record.value.end === record.value.start + 1);
  const memory = snapshot.calls.find((call) => call.name === 'memory');
  return {
    id: snapshot.execution.id,
    ...(snapshot.archive ? { archive: snapshot.archive } : {}),
    startedAt,
    status: snapshot.execution.status,
    observedOffsetMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    inputIndex,
    calls,
    selections: selections.map((call) => {
      const output = call.status === 'succeeded' ? object(readOutput(call.value)) : {};
      const indexes = call.name === 'prepareContext' ? object(output.selection).historyIndexes : output.historyIndexes;
      return { operationId: call.id, status: call.status, ...(isArray(indexes) && indexes.every(isNumber) ? { indexes } : {}) };
    }),
    availableMemoryIds: isArray(memoryInput) ? memoryInput.map((memory) => object(memory).id).filter(isString) : [],
    memoryChanges: snapshot.memories.map((record) => ({ id: record.id, memoryId: record.memoryId, operationId: record.callId ?? record.operationId, action: record.value.action, change: record.value.change })),
    ...(range ? { transcriptRange: range } : {}),
    ...(answer?.value.action === 'append' ? { response: { index: answer.value.start } } : existing?.response ? { response: existing.response } : {}),
    ...(memory ? { memoryStatus: memory.status } : {}),
  };
}
