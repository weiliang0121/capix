import { isUndefined } from 'es-toolkit/predicate';
import type { ExecutionSummary, InvocationSummary, ObserverOverview } from '@capix-observer/protocol';
import { AttemptRecord, EventRecord, ExecutionRecord, MemoryRecord, OperationRecord, TranscriptRangeRef } from '@capix-observer/runtime';
import type { initializeObserver } from './environment.js';
import { inspectExecutions } from './inspect.js';
import type { SelectionInput } from '../operations/history/input.js';

type Observer = ReturnType<typeof initializeObserver>;
type Invocation = ExecutionRecord | OperationRecord | AttemptRecord;

/** Read list/timing facts directly: opening the explorer does not load every invocation body. */
export function observeOverview(observer: Observer): ObserverOverview {
  const observation = inspectExecutions(observer.book, observer.transcript, observer.execution);
  const records = [...observer.book.values()];
  const operations = records.filter((record): record is OperationRecord => record instanceof OperationRecord);
  const attempts = records.filter((record): record is AttemptRecord => record instanceof AttemptRecord);
  const changes = records.filter((record): record is MemoryRecord => record instanceof MemoryRecord);
  const observedOffsets = new Map<string, number>();
  const boundaries = new Map<string, { start?: number; end?: number }>();
  for (const record of records) {
    if (record instanceof ExecutionRecord) observedOffsets.set(record.id, Math.max(observedOffsets.get(record.id) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    if (record instanceof OperationRecord) observedOffsets.set(record.executionId, Math.max(observedOffsets.get(record.executionId) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    if (record instanceof AttemptRecord) {
      const operation = observer.book.get(record.operationId);
      if (operation instanceof OperationRecord) observedOffsets.set(operation.executionId, Math.max(observedOffsets.get(operation.executionId) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    }
    if (!(record instanceof EventRecord)) continue;
    observedOffsets.set(record.executionId, Math.max(observedOffsets.get(record.executionId) ?? 0, record.offsetMs));
    const timing = boundaries.get(record.callId) ?? {};
    if (record.value.type === 'call') timing.start = record.offsetMs;
    else timing.end = record.offsetMs;
    boundaries.set(record.callId, timing);
  }
  const summarize = (record: Invocation): InvocationSummary => {
    const timing = boundaries.get(record.id);
    const common = { id: record.id, contextId: record.contextId, status: record.status, offsetMs: timing?.start ?? 0, ...(!isUndefined(timing?.start) && !isUndefined(timing?.end) ? { durationMs: timing!.end! - timing!.start! } : {}) };
    if (record instanceof ExecutionRecord) return { ...common, recordType: 'execution', name: 'execution', label: '执行', source: 'server/runtime/src/execution/execution.ts · Execution.call' };
    if (record instanceof OperationRecord) return { ...common, recordType: 'operation', parentId: record.parentOperationId ?? record.executionId, name: record.operation, label: record.label, source: record.source };
    return { ...common, recordType: 'attempt', parentId: record.operationId, name: record.name, label: record.label, source: record.source };
  };
  const executions: ExecutionSummary[] = observation.executions.map((execution) => {
    const record = observer.book.get(execution.id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Observed execution record does not exist');
    const ownOperations = operations.filter((operation) => operation.executionId === record.id);
    const operationIds = new Set<string>(ownOperations.map((operation) => operation.id));
    const selection = ownOperations.find((operation) => operation.operationInstanceId === observer.execution.selection.id);
    const captured = selection?.value.input as SelectionInput | undefined;
    const range = record.value.transcriptRange;
    const call = summarize(record);
    return {
      ...execution,
      observedOffsetMs: observedOffsets.get(execution.id) ?? 0,
      ...(isUndefined(call.durationMs) ? {} : { durationMs: call.durationMs }),
      calls: [call, ...ownOperations.map(summarize), ...attempts.filter((attempt) => operationIds.has(attempt.operationId)).map(summarize)],
      ...(range instanceof TranscriptRangeRef ? { transcriptRange: { start: range.start, end: range.end } } : {}),
      availableMemoryIds: captured?.memories.map((memory) => memory.id) ?? [],
      memoryChanges: changes.filter((change) => change.executionId === execution.id).map((change) => ({ id: change.id, memoryId: change.memoryId, operationId: change.operationId, action: change.value.action, change: change.value.change })),
    };
  });
  return { messages: observation.messages, executions };
}
