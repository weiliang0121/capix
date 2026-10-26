import type { CallableRecord as CallableRecordValue, ExecutionRecordSnapshot, InvocationBoundaryRecord as BoundaryValue } from '@capix/protocol';
import { CallableRecord, RuntimeCallRecord, ExecutionRecord, OperationRecord, AttemptRecord, InvocationBoundaryRecord, ResourceRecord, TranscriptRecord, MemoryRecord, CompositeRecord, type BaseRecord, type RecordBook } from '@capix/records';

/** A service role attached to this exact business declaration, independent of Callable kind. */
export const conversationTaskRole = 'conversation-task';

export function isTaskRecord(record: BaseRecord<unknown> | undefined): record is CallableRecord | ExecutionRecord {
  return record instanceof ExecutionRecord || (record instanceof CallableRecord && record.role === conversationTaskRole);
}

/** Historical carriers are interpreted without mutating the restored record book. */
export function callRecord(record: BaseRecord<unknown> | undefined): CallableRecordValue | undefined {
  if (record instanceof CallableRecord) return record;
  if (!(record instanceof RuntimeCallRecord || record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord)) return;
  const common = { id: record.id, ...(record.parentId ? { parentId: record.parentId } : {}), childIds: record.childIds, contextId: record.contextId, status: record.status };
  if (record instanceof RuntimeCallRecord) return { ...common, structureKind: 'scene', structureId: record.runtimeInstanceId, name: 'conversation', label: '对话场景', value: record.value };
  if (record instanceof ExecutionRecord) return { ...common, structureKind: 'group', role: conversationTaskRole, name: 'conversationTask', label: '本次对话任务', value: record.value };
  const startedAt = record.value.processes[0]?.occurredAt;
  if (record instanceof OperationRecord) return { ...common, structureKind: 'group', structureId: record.operationInstanceId, name: record.operation, label: record.label, source: record.source, callee: record.callee, value: { ...record.value, ...(startedAt ? { startedAt } : {}) } };
  return { ...common, structureKind: 'node', name: record.name, label: record.label, source: record.source, callee: record.callee, value: { ...record.value, ...(startedAt ? { startedAt } : {}) } };
}

/** Resolve only direct recorded parent links, never kind, label, timing or an inferred QA number. */
export function taskRecord(book: RecordBook, id: string): CallableRecordValue | undefined {
  const visited = new Set<string>();
  let record = book.get(id);
  while (record) {
    if (visited.has(record.id)) throw new Error('Recorded call ancestry contains a cycle');
    visited.add(record.id);
    if (isTaskRecord(record)) return callRecord(record);
    record = record.parentId ? book.get(record.parentId) : undefined;
  }
}

export function recordSubtree(book: RecordBook, root: BaseRecord<unknown>): BaseRecord<unknown>[] {
  const records: BaseRecord<unknown>[] = [];
  const visited = new Set<string>();
  const pending = [root];
  for (let record = pending.pop(); record; record = pending.pop()) {
    if (visited.has(record.id)) throw new Error('Recorded subtree contains a cycle or repeated child');
    visited.add(record.id);
    records.push(record);
    if (record instanceof CompositeRecord) {
      for (const id of [...record.childIds].reverse()) {
        const child = book.get(id);
        if (!child || child.parentId !== record.id) throw new Error('Recorded subtree is incomplete');
        pending.push(child);
      }
    }
  }
  return records;
}

export function taskView(book: RecordBook, id: string): ExecutionRecordSnapshot {
  const selected = book.get(id);
  if (!isTaskRecord(selected)) throw new Error('Conversation task record does not exist');
  const execution = callRecord(selected)!;
  const records = recordSubtree(book, selected);
  const calls = records.map(callRecord).filter((record): record is CallableRecordValue => record !== undefined);
  const parents = new Set<string>();
  let parent = selected.parentId ? book.get(selected.parentId) : undefined;
  const path: CallableRecordValue[] = [];
  while (parent) {
    if (parents.has(parent.id)) throw new Error('Recorded task ancestry contains a cycle');
    parents.add(parent.id);
    const call = callRecord(parent);
    if (call) path.push(call);
    parent = parent.parentId ? book.get(parent.parentId) : undefined;
  }
  path.reverse();
  const rootCall = path[0];
  const ancestors = path.slice(1);
  const pathIds = new Set(path.map((call) => call.id));
  const ancestorChildren = path.flatMap((call) => call.childIds.map((childId) => book.get(childId)).filter((record): record is BaseRecord<unknown> => record !== undefined));
  const boundaries: BoundaryValue[] = [...ancestorChildren.filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord && pathIds.has(record.callId)), ...records.filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord)];
  boundaries.sort((left, right) => (left.scopeId === right.scopeId ? left.sequence - right.sequence : Date.parse(left.occurredAt) - Date.parse(right.occurredAt)));
  const resources = [...ancestorChildren.filter((record): record is ResourceRecord => record instanceof ResourceRecord), ...records.filter((record): record is ResourceRecord => record instanceof ResourceRecord)];
  return { execution, calls, ...(rootCall ? { rootCall } : {}), ...(ancestors.length ? { ancestors } : {}), boundaries, resources, transcripts: records.filter((record): record is TranscriptRecord => record instanceof TranscriptRecord), memories: records.filter((record): record is MemoryRecord => record instanceof MemoryRecord) };
}

/** Capture object fields once; immutable bodies are shared, never deep cloned for presentation. */
export function taskSnapshot(book: RecordBook, id: string): ExecutionRecordSnapshot {
  const view = taskView(book, id);
  const snapshotCall = (record: CallableRecordValue) => (record instanceof CallableRecord ? record.toJSON() : record);
  return { execution: snapshotCall(view.execution), calls: view.calls.map(snapshotCall), ...(view.rootCall ? { rootCall: snapshotCall(view.rootCall) } : {}), ...(view.ancestors ? { ancestors: view.ancestors.map(snapshotCall) } : {}), boundaries: view.boundaries.map((record) => (record instanceof InvocationBoundaryRecord ? record.toJSON() : record)), resources: view.resources.map((record) => (record instanceof ResourceRecord ? record.toJSON() : record)), transcripts: view.transcripts.map((record) => (record instanceof TranscriptRecord ? record.toJSON() : record)), memories: view.memories.map((record) => (record instanceof MemoryRecord ? record.toJSON() : record)) };
}
