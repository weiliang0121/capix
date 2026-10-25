import { readOutput, type ExecutionSummary, type InvocationSummary, type ObserverOverview, type RecordingArchive } from '@capix/protocol';
import { type RecordBook } from '@capix/server-runtime/recording';
import { type Transcript } from '@capix/server-runtime/content';
import { executionTranscript } from './evidence.js';
import { inspectExecutions } from './inspect.js';
import { executionArchive } from './archive.js';
import { taskView } from './calls.js';
import type { SelectionInput } from '../conversation/group/history/input.js';
import type { describePreparedConversationContext } from '../conversation/content/observation.js';

/** Interpret explicit task roles while preserving the actual callable tree. No body is cloned here. */
export function observeOverview(observer: { readonly records: { readonly book: RecordBook; readonly archives?: readonly RecordingArchive[] }; readonly transcript: Transcript }): ObserverOverview {
  const { book, archives } = observer.records;
  const observation = inspectExecutions(book, observer.transcript);
  const executions: ExecutionSummary[] = observation.executions.map((execution) => {
    const snapshot = taskView(book, execution.id);
    const startedAt = snapshot.execution.value.startedAt;
    if (startedAt === undefined) throw new Error('Conversation task has no recorded start');
    const start = Date.parse(startedAt);
    const starts = new Map(snapshot.boundaries.filter((boundary) => boundary.value.type === 'call').map((boundary) => [boundary.callId, boundary]));
    const ends = new Map(snapshot.boundaries.filter((boundary) => boundary.value.type !== 'call').map((boundary) => [boundary.callId, boundary]));
    const origin = starts.get(snapshot.execution.id);
    const offset = (boundary: (typeof snapshot.boundaries)[number]) => (origin && boundary.scopeId === origin.scopeId ? boundary.offsetMs - origin.offsetMs : Date.parse(boundary.occurredAt) - start);
    const calls: InvocationSummary[] = snapshot.calls.map((record) => {
      const first = starts.get(record.id);
      const last = ends.get(record.id);
      return { id: record.id, contextId: record.contextId, recordType: record.structureKind, ...(record.parentId ? { parentId: record.parentId } : {}), name: record.name ?? '', label: record.label ?? record.name ?? '调用', source: record.source ?? '', status: record.status, offsetMs: first ? offset(first) : 0, ...(first && last ? { durationMs: last.offsetMs - first.offsetMs } : {}) };
    });
    const preparation = snapshot.calls.find((call) => call.name === 'prepareContext');
    const prepared = preparation?.status === 'succeeded' ? (readOutput(preparation.value) as ReturnType<typeof describePreparedConversationContext>) : undefined;
    const captured = snapshot.calls.find((call) => call.name === 'selection')?.value.input as SelectionInput | undefined;
    const range = executionTranscript(book, execution.id);
    const durationMs = calls.find((call) => call.id === execution.id)?.durationMs;
    const archive = executionArchive(book, archives, execution.id);
    const ownIds = new Set(snapshot.calls.map((call) => call.id));
    // A terminal boundary is the exact monotonic extent of that call. Its wall-clock
    // process timestamps have millisecond precision and must not extend that extent.
    const pendingProcesses = snapshot.calls.filter((call) => !ends.has(call.id)).flatMap((call) => call.value.processes.map((process) => Date.parse(process.occurredAt) - start));
    const observedOffsetMs = Math.max(0, ...snapshot.boundaries.filter((boundary) => ownIds.has(boundary.callId)).map(offset), ...pendingProcesses);
    return {
      ...execution,
      ...(archive ? { archive } : {}),
      observedOffsetMs,
      ...(durationMs === undefined ? {} : { durationMs }),
      calls,
      ...(range ? { transcriptRange: range } : {}),
      availableMemoryIds: (prepared?.material.memories ?? captured?.memories)?.map((memory) => memory.id) ?? [],
      memoryChanges: snapshot.memories.map((change) => ({ id: change.id, memoryId: change.memoryId, operationId: change.callId ?? change.operationId, action: change.value.action, change: change.value.change })),
    };
  });
  return { transcriptId: observer.transcript.id, messages: observation.messages, executions, ...(archives?.length ? { archives } : {}) };
}
