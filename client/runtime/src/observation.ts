import { isArray } from 'es-toolkit/compat';
import type { ObservationBaseline, ObservationFrame, RecordEntry, RecordChangeEvent, InvocationEvent, ObserverOverview, MemoryObservation, RuntimeSnapshot, ExecutionRecord, OperationRecord, AttemptRecord, InvocationBoundaryRecord, TranscriptRecord, MemoryRecord, ResourceFact } from '@capix-observer/protocol';
import { validateSnapshot } from '@capix-observer/protocol';

export class ObservationSequenceError extends Error {}
/** A receiver-side replica. No UI geometry, business decisions or snapshot diffing. */
export class ObservationReplica {
  readonly scopeId: string;
  readonly sequence: number;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly entries: ReadonlyMap<string, RecordEntry>;
  readonly invocations: ReadonlyMap<string, InvocationEvent>;
  readonly transcriptRecords: readonly TranscriptRecord[];
  readonly snapshots: ReadonlyMap<string, RuntimeSnapshot>;
  readonly transcript: ObservationBaseline['transcript'];
  readonly memories: ObservationBaseline['memories'];
  readonly recorder: ObservationBaseline['recorder'];

  private constructor(baseline: ObservationBaseline, entries = new Map(baseline.entries.map((entry) => [entry.data.id, entry])), invocations = new Map(baseline.invocations.map((event) => [event.contextId, event])), transcriptRecords: readonly TranscriptRecord[] = []) {
    this.scopeId = baseline.scopeId;
    this.sequence = baseline.sequence;
    this.overview = baseline.overview;
    this.memory = baseline.memory;
    this.entries = entries;
    this.invocations = invocations;
    this.transcriptRecords = transcriptRecords;
    this.transcript = baseline.transcript;
    this.memories = baseline.memories;
    this.recorder = baseline.recorder;
    this.snapshots = snapshots(entries);
  }

  static receive(previous: ObservationReplica | undefined, frame: ObservationFrame): ObservationReplica {
    if (frame.type === 'baseline') return new ObservationReplica(frame);
    if (!previous || frame.scopeId !== previous.scopeId) throw new ObservationSequenceError('观测范围不一致，需要重新建立基线。');
    if (frame.sequence <= previous.sequence) return previous;
    if (frame.sequence !== previous.sequence + 1) throw new ObservationSequenceError('观测交付存在缺口，需要重新建立基线。');
    // Stage every change in new structures; a rejected batch never mutates the accepted replica.
    const entries = new Map(previous.entries);
    const invocations = new Map(previous.invocations);
    const transcriptRecords = [...previous.transcriptRecords];
    let overview = previous.overview;
    let memory = previous.memory;
    let transcript = previous.transcript;
    let memories = previous.memories;
    let recorder = previous.recorder;
    for (const event of frame.changes) {
      if (event.type === 'transcript') {
        if (event.transcriptId !== transcript.id || event.revision !== transcript.revision + 1) throw new ObservationSequenceError('消息变化顺序不连续。');
        const change = event.change;
        if (change.kind === 'messages-appended') {
          if (change.start !== overview.messages.length || change.end <= change.start) throw new ObservationSequenceError('消息追加位置不一致。');
          overview = { ...overview, messages: [...overview.messages, ...Array.from({ length: change.end - change.start }, (_, offset) => ({ index: change.start + offset, count: 0 }))] };
        } else {
          if (change.previousStart !== transcript.starts.at(-1) || change.start <= change.previousStart || change.start >= change.end || change.end !== overview.messages.length) throw new ObservationSequenceError('消息段边界不一致。');
          transcript = { ...transcript, starts: [...transcript.starts, change.start] };
        }
        transcript = { ...transcript, revision: event.revision };
      } else if (event.type === 'memory') {
        if (event.memoriesId !== memories.id || event.sequence !== memories.sequence + 1) throw new ObservationSequenceError('记忆变化顺序不连续。');
        const change = event.change;
        const old = memory.items.find((item) => item.id === change.memoryId);
        if ((change.action === 'create') === Boolean(old)) throw new ObservationSequenceError('记忆变化目标不一致。');
        const item = {
          id: change.memoryId,
          topic: change.result.topic,
          content: change.result.content,
          sources: change.result.sourceIndexes.map((index) => ({ transcriptId: transcript.id, index })),
          records: old?.records ?? [],
        };
        memory = { items: old ? memory.items.map((value) => (value.id === item.id ? item : value)) : [...memory.items, item] };
        memories = { ...memories, sequence: event.sequence };
      } else if (event.type === 'record') {
        if (event.recorderId !== recorder.id || event.revision !== recorder.revision + 1) throw new ObservationSequenceError('记录变化顺序不连续。');
        applyRecord(entries, event);
        const change = event.change;
        if (change.kind === 'added' && change.entry.kind === 'transcript') transcriptRecords.push(change.entry.data as TranscriptRecord);
        if (change.kind === 'added' && change.entry.kind === 'memory') {
          const record = change.entry.data as MemoryRecord;
          memory = { items: memory.items.map((item) => (item.id === record.memoryId ? { ...item, records: [...item.records, record] } : item)) };
        }
        recorder = { ...recorder, revision: event.revision };
      } else {
        const last = invocations.get(event.contextId);
        if (event.sequence !== (last?.sequence ?? 0) + 1) throw new ObservationSequenceError('调用变化顺序不连续。');
        invocations.set(event.contextId, event);
      }
    }
    return new ObservationReplica({ type: 'baseline', scopeId: frame.scopeId, sequence: frame.sequence, overview, memory, transcript, memories, recorder, entries: [], invocations: [] }, entries, invocations, transcriptRecords);
  }
}

function applyRecord(entries: Map<string, RecordEntry>, event: RecordChangeEvent): void {
  const change = event.change;
  if (change.kind === 'added') {
    if (entries.has(change.entry.data.id)) throw new ObservationSequenceError('重复登记记录。');
    if (change.parent && (change.entry.data.parentId !== change.parent.id || change.parent.childId !== change.entry.data.id)) throw new ObservationSequenceError('记录归属不一致。');
    entries.set(change.entry.data.id, change.entry);
    if (change.parent) {
      const parent = entries.get(change.parent.id);
      // Completed historical bodies may not be loaded. Their references remain explicit IDs.
      if (parent) {
        const data = parent.data as typeof parent.data & { childIds: readonly string[] };
        if (!isArray(data.childIds) || data.childIds.includes(change.parent.childId)) throw new ObservationSequenceError('父级引用无效。');
        entries.set(data.id, { ...parent, data: { ...data, childIds: [...data.childIds, change.parent.childId] } as typeof data });
      }
    }
    return;
  }
  if (change.kind === 'replaced') {
    entries.set(change.entry.data.id, change.entry);
    return;
  }
  const entry = entries.get(change.id);
  if (!entry || !['execution', 'operation', 'attempt'].includes(entry.kind)) throw new ObservationSequenceError('调用记录尚未装载。');
  const data = entry.data as ExecutionRecord | OperationRecord | AttemptRecord;
  if (data.status !== 'running') throw new ObservationSequenceError('调用记录已经结束。');
  if (change.kind === 'process-appended') {
    if (change.process.sequence !== data.value.processes.length + 1) throw new ObservationSequenceError('调用过程顺序不连续。');
    entries.set(data.id, { ...entry, data: { ...data, value: { ...data.value, processes: [...data.value.processes, change.process] } } });
  } else entries.set(data.id, { ...entry, data: { ...data, status: change.status, value: { ...data.value, ...change.result } } as ExecutionRecord });
}

function snapshots(entries: ReadonlyMap<string, RecordEntry>): ReadonlyMap<string, RuntimeSnapshot> {
  const values = [...entries.values()];
  const result = new Map<string, RuntimeSnapshot>();
  for (const item of values) {
    if (item.kind !== 'execution') continue;
    const execution = item.data as ExecutionRecord;
    const operations = values.filter((entry) => entry.kind === 'operation' && (entry.data as OperationRecord).executionId === execution.id).map((entry) => entry.data as OperationRecord);
    const ids = new Set(operations.map((operation) => operation.id));
    const attempts = values.filter((entry) => entry.kind === 'attempt' && ids.has((entry.data as AttemptRecord).operationId)).map((entry) => entry.data as AttemptRecord);
    const events = values
      .filter((entry) => entry.kind === 'invocation-boundary' && (entry.data as InvocationBoundaryRecord).executionId === execution.id)
      .map((entry) => entry.data as InvocationBoundaryRecord)
      .sort((a, b) => a.sequence - b.sequence);
    // A record update and its boundary are separate formal facts; expose a call view when both exist.
    if ([execution, ...operations, ...attempts].some((record) => !events.some((event) => event.callId === record.id && event.value.type === 'call') || (record.status !== 'running' && !events.some((event) => event.callId === record.id && event.value.type === (record.status === 'succeeded' ? 'return' : 'throw'))))) continue;
    const callIds = new Set([execution.id, ...operations.map((record) => record.id), ...attempts.map((record) => record.id)]);
    const resources = values.filter((entry) => entry.kind === 'resource' && entry.data.parentId && callIds.has(entry.data.parentId)).map((entry) => entry.data as ResourceFact);
    const snapshot = { execution, operations, attempts, events, resources };
    validateSnapshot(snapshot);
    result.set(execution.id, snapshot);
  }
  return result;
}
