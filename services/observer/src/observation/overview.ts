import { isUndefined } from 'es-toolkit/predicate';
import type { ExecutionSummary, InvocationSummary, ObserverOverview, RecordingArchive } from '@capix/protocol';
import { AttemptRecord, InvocationBoundaryRecord, ExecutionRecord, MemoryRecord, OperationRecord, type RecordBook } from '@capix/server-runtime/recording';
import { type Transcript } from '@capix/server-runtime/content';
import { executionTranscript } from './evidence.js';
import { inspectExecutions } from './inspect.js';
import { executionArchive } from './archive.js';
import type { SelectionInput } from '../conversation/operations/history/input.js';

type ObservedCallRecord = ExecutionRecord | OperationRecord | AttemptRecord;

/** Read list/timing facts directly: opening the explorer does not load every invocation body. */
export function observeOverview(observer: { readonly book: RecordBook; readonly transcript: Transcript; readonly recordingArchives?: readonly RecordingArchive[] }): ObserverOverview {
  const observation = inspectExecutions(observer.book, observer.transcript);
  const records = [...observer.book.values()];
  const operations = records.filter((record): record is OperationRecord => record instanceof OperationRecord);
  const attempts = records.filter((record): record is AttemptRecord => record instanceof AttemptRecord);
  const changes = records.filter((record): record is MemoryRecord => record instanceof MemoryRecord);
  const operationsByExecution = new Map<string, OperationRecord[]>();
  for (const record of operations) {
    const own = operationsByExecution.get(record.executionId);
    if (own) own.push(record);
    else operationsByExecution.set(record.executionId, [record]);
  }
  const operationsById = new Map(operations.map((record) => [record.id, record]));
  const attemptsByExecution = new Map<string, AttemptRecord[]>();
  for (const record of attempts) {
    const executionId = operationsById.get(record.operationId)?.executionId;
    if (!executionId) continue;
    const own = attemptsByExecution.get(executionId);
    if (own) own.push(record);
    else attemptsByExecution.set(executionId, [record]);
  }
  const changesByExecution = new Map<string, MemoryRecord[]>();
  for (const record of changes) {
    if (!record.executionId) continue;
    const own = changesByExecution.get(record.executionId);
    if (own) own.push(record);
    else changesByExecution.set(record.executionId, [record]);
  }
  const observedOffsets = new Map<string, number>();
  const boundaries = new Map<string, { start?: number; end?: number }>();
  for (const record of records) {
    if (record instanceof ExecutionRecord) observedOffsets.set(record.id, Math.max(observedOffsets.get(record.id) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    if (record instanceof OperationRecord) observedOffsets.set(record.executionId, Math.max(observedOffsets.get(record.executionId) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    if (record instanceof AttemptRecord) {
      const operation = observer.book.get(record.operationId);
      if (operation instanceof OperationRecord) observedOffsets.set(operation.executionId, Math.max(observedOffsets.get(operation.executionId) ?? 0, record.value.processes.at(-1)?.offsetMs ?? 0));
    }
    if (!(record instanceof InvocationBoundaryRecord) || !record.executionId) continue;
    observedOffsets.set(record.executionId, Math.max(observedOffsets.get(record.executionId) ?? 0, record.offsetMs));
    const timing = boundaries.get(record.callId) ?? {};
    if (record.value.type === 'call') timing.start = record.offsetMs;
    else timing.end = record.offsetMs;
    boundaries.set(record.callId, timing);
  }
  const summarize = (record: ObservedCallRecord): InvocationSummary => {
    const timing = boundaries.get(record.id);
    const common = { id: record.id, contextId: record.contextId, status: record.status, offsetMs: timing?.start ?? 0, ...(!isUndefined(timing?.start) && !isUndefined(timing?.end) ? { durationMs: timing!.end! - timing!.start! } : {}) };
    if (record instanceof ExecutionRecord) return { ...common, recordType: 'execution', name: 'execution', label: '执行调用', source: 'server/runtime/src/structure/execution.ts · BoundExecution.create' };
    if (record instanceof OperationRecord) return { ...common, recordType: 'operation', parentId: record.parentOperationId ?? record.executionId, name: record.operation, label: record.label, source: record.source };
    return { ...common, recordType: 'attempt', parentId: record.operationId, name: record.name, label: record.label, source: record.source };
  };
  const executions: ExecutionSummary[] = observation.executions.map((execution) => {
    const record = observer.book.get(execution.id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Observed execution record does not exist');
    const ownOperations = operationsByExecution.get(record.id) ?? [];
    const ownAttempts = attemptsByExecution.get(record.id) ?? [];
    const selection = ownOperations.find((operation) => operation.operation === 'selection');
    const captured = selection?.value.input as SelectionInput | undefined;
    const range = executionTranscript(observer.book, record.id);
    const call = summarize(record);
    const archive = executionArchive(observer.book, observer.recordingArchives, record.id);
    return {
      ...execution,
      ...(archive ? { archive } : {}),
      observedOffsetMs: observedOffsets.get(execution.id) ?? 0,
      ...(isUndefined(call.durationMs) ? {} : { durationMs: call.durationMs }),
      calls: [call, ...ownOperations.map(summarize), ...ownAttempts.map(summarize)],
      ...(range ? { transcriptRange: range } : {}),
      availableMemoryIds: captured?.memories.map((memory) => memory.id) ?? [],
      memoryChanges: (changesByExecution.get(execution.id) ?? []).map((change) => ({ id: change.id, memoryId: change.memoryId, operationId: change.operationId, action: change.value.action, change: change.value.change })),
    };
  });
  return { transcriptId: observer.transcript.id, messages: observation.messages, executions, ...(observer.recordingArchives?.length ? { archives: observer.recordingArchives } : {}) };
}
