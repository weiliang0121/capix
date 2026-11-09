import { isArray } from 'es-toolkit/compat';
import type { ObservationBaseline, ObservationFrame, RecordEntry, RecordChangeEvent, InvocationEvent, ObserverOverview, MemoryObservation, ExecutionRecordSnapshot, CallableRecord, InvocationBoundaryRecord, TranscriptRecord, MemoryRecord, ResourceRecord } from '@weiliang0121/capix-protocol';
import { validateExecutionRecordSnapshot, validateRecordingArchives, validateRecordingArchiveOrigin } from '@weiliang0121/capix-protocol';

export class ObservationSequenceError extends Error {}
/** Reconnecting cannot repair a foreign identity or contradictory formal fact. */
export class ObservationContractError extends ObservationSequenceError {}
/** A receiver-side replica. No UI geometry, business decisions or snapshot diffing. */
export class ObservationReplica {
  readonly scopeId: string;
  readonly sequence: number;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly entries: ReadonlyMap<string, RecordEntry>;
  readonly invocationEvents: ReadonlyMap<string, InvocationEvent>;
  readonly transcriptRecords: readonly TranscriptRecord[];
  readonly snapshots: ReadonlyMap<string, ExecutionRecordSnapshot>;
  /** Only complete execution views produced by this delivery; snapshots remains the cumulative replica. */
  readonly updates: ReadonlyMap<string, ExecutionRecordSnapshot>;
  readonly transcript: ObservationBaseline['transcript'];
  readonly memories: ObservationBaseline['memories'];
  readonly recorder: ObservationBaseline['recorder'];

  private constructor(baseline: ObservationBaseline, entries: ReadonlyMap<string, RecordEntry> = new Map(baseline.entries.map((entry) => [entry.data.id, entry])), invocationEvents: ReadonlyMap<string, InvocationEvent> = new Map(baseline.invocations.map((event) => [event.contextId, event])), transcriptRecords: readonly TranscriptRecord[] = [], previous?: ObservationReplica, affected?: ReadonlySet<string>) {
    this.scopeId = baseline.scopeId;
    this.sequence = baseline.sequence;
    this.overview = baseline.overview;
    this.memory = baseline.memory;
    this.entries = entries;
    this.invocationEvents = invocationEvents;
    this.transcriptRecords = transcriptRecords;
    this.transcript = baseline.transcript;
    this.memories = baseline.memories;
    this.recorder = baseline.recorder;
    const next = snapshots(entries, previous?.snapshots, affected);
    this.snapshots = next.snapshots;
    this.updates = next.updates;
  }

  static receive(previous: ObservationReplica | undefined, frame: ObservationFrame): ObservationReplica {
    if (frame.type === 'baseline') {
      if (frame.overview.archives !== undefined) validateRecordingArchives(frame.overview.archives);
      for (const execution of frame.overview.executions) if (execution.archive !== undefined) validateRecordingArchiveOrigin(execution.archive);
      return new ObservationReplica(frame);
    }
    if (!previous) throw new ObservationSequenceError('观测连接缺少初始基线。');
    if (frame.scopeId !== previous.scopeId) throw new ObservationContractError('观测范围不一致。');
    if (frame.sequence <= previous.sequence) return previous;
    if (frame.sequence !== previous.sequence + 1) throw new ObservationSequenceError('观测交付存在缺口，需要重新建立基线。');
    // Stage every change in new structures; a rejected batch never mutates the accepted replica.
    let entries: Map<string, RecordEntry> | undefined;
    const changedRecords = new Set<string>();
    let invocationEvents: Map<string, InvocationEvent> | undefined;
    let transcriptRecords = previous.transcriptRecords;
    let overview = previous.overview;
    let memory = previous.memory;
    let transcript = previous.transcript;
    let memories = previous.memories;
    let recorder = previous.recorder;
    for (const event of frame.changes) {
      if (event.type === 'transcript') {
        if (event.transcriptId !== transcript.id) throw new ObservationContractError('消息集合身份不一致。');
        if (event.revision !== transcript.revision + 1) throw new ObservationSequenceError('消息变化顺序不连续。');
        const change = event.change;
        if (change.kind === 'messages-appended') {
          if (change.start !== overview.messages.length || change.end <= change.start) throw new ObservationContractError('消息追加位置不一致。');
          overview = { ...overview, messages: [...overview.messages, ...Array.from({ length: change.end - change.start }, (_, offset) => ({ index: change.start + offset, count: 0 }))] };
        } else {
          if (change.previousStart !== transcript.starts.at(-1) || change.start <= change.previousStart || change.start >= change.end || change.end !== overview.messages.length) throw new ObservationContractError('消息段边界不一致。');
          transcript = { ...transcript, starts: [...transcript.starts, change.start] };
        }
        transcript = { ...transcript, revision: event.revision };
      } else if (event.type === 'memory') {
        if (event.memoriesId !== memories.id) throw new ObservationContractError('记忆集合身份不一致。');
        if (event.sequence !== memories.sequence + 1) throw new ObservationSequenceError('记忆变化顺序不连续。');
        const change = event.change;
        const old = memory.items.find((item) => item.id === change.memoryId);
        if ((change.action === 'create') === Boolean(old)) throw new ObservationContractError('记忆变化目标不一致。');
        const item = {
          id: change.memoryId,
          topic: change.result.topic,
          content: change.result.content,
          sources: change.result.sourceIndexes.map((index) => ({ transcriptId: transcript.id, index })),
          ...(change.result.sourceResults ? { sourceResults: change.result.sourceResults } : {}),
          records: old?.records ?? [],
        };
        memory = { items: old ? memory.items.map((value) => (value.id === item.id ? item : value)) : [...memory.items, item] };
        memories = { ...memories, sequence: event.sequence };
      } else if (event.type === 'record') {
        if (event.recorderId !== recorder.id) throw new ObservationContractError('记录来源身份不一致。');
        if (event.revision !== recorder.revision + 1) throw new ObservationSequenceError('记录变化顺序不连续。');
        entries ??= new Map(previous.entries);
        applyRecord(entries, event);
        const change = event.change;
        changedRecords.add(change.kind === 'added' || change.kind === 'replaced' ? change.entry.data.id : change.id);
        if (change.kind === 'added' && change.parent) changedRecords.add(change.parent.id);
        if (change.kind === 'added' && change.entry.kind === 'transcript') transcriptRecords = [...transcriptRecords, change.entry.data as TranscriptRecord];
        if (change.kind === 'added' && change.entry.kind === 'memory') {
          const record = change.entry.data as MemoryRecord;
          memory = { items: memory.items.map((item) => (item.id === record.memoryId ? { ...item, records: [...item.records, record] } : item)) };
        }
        recorder = { ...recorder, revision: event.revision };
      } else {
        invocationEvents ??= new Map(previous.invocationEvents);
        const last = invocationEvents.get(event.contextId);
        if (event.sequence !== (last?.sequence ?? 0) + 1) throw new ObservationSequenceError('调用变化顺序不连续。');
        invocationEvents.set(event.contextId, event);
      }
    }
    const acceptedEntries = entries ?? previous.entries;
    return new ObservationReplica({ type: 'baseline', scopeId: frame.scopeId, sequence: frame.sequence, overview, memory, transcript, memories, recorder, entries: [], invocations: [] }, acceptedEntries, invocationEvents ?? previous.invocationEvents, transcriptRecords, previous, affectedExecutions(previous.entries, acceptedEntries, changedRecords));
  }
}

function applyRecord(entries: Map<string, RecordEntry>, event: RecordChangeEvent): void {
  const change = event.change;
  if (change.kind === 'added') {
    if (entries.has(change.entry.data.id)) throw new ObservationContractError('重复登记记录。');
    if (change.parent && (change.entry.data.parentId !== change.parent.id || change.parent.childId !== change.entry.data.id)) throw new ObservationContractError('记录归属不一致。');
    entries.set(change.entry.data.id, change.entry);
    if (change.parent) {
      const parent = entries.get(change.parent.id);
      // Completed historical bodies may not be loaded. Their references remain explicit IDs.
      if (parent) {
        const data = parent.data as typeof parent.data & { childIds: readonly string[] };
        if (!isArray(data.childIds) || data.childIds.includes(change.parent.childId)) throw new ObservationContractError('父级引用无效。');
        entries.set(data.id, { ...parent, data: { ...data, childIds: [...data.childIds, change.parent.childId] } as typeof data });
      }
    }
    return;
  }
  if (change.kind === 'replaced') {
    const previous = entries.get(change.entry.data.id);
    if (previous && (previous.kind !== change.entry.kind || previous.data.parentId !== change.entry.data.parentId)) throw new ObservationContractError('记录身份或直接归属不能被替换。');
    entries.set(change.entry.data.id, change.entry);
    return;
  }
  const entry = entries.get(change.id);
  if (!entry || entry.kind !== 'invocation') throw new ObservationContractError('调用记录尚未装载。');
  const data = entry.data as CallableRecord;
  if (data.status !== 'running') throw new ObservationContractError('调用记录已经结束。');
  if (change.kind === 'process-appended' || change.kind === 'relation-appended') {
    const sequence = Math.max(data.value.processes.at(-1)?.eventSequence ?? 0, data.value.relationChanges.at(-1)?.eventSequence ?? 0);
    const next = change.kind === 'process-appended' ? change.process.eventSequence : change.relation.eventSequence;
    if (next <= sequence) throw new ObservationContractError('调用事实顺序没有前进。');
  }
  if (change.kind === 'relation-appended') {
    if (change.relation.identity.parentContextId !== data.contextId) throw new ObservationContractError('调用关系不属于此父调用。');
    entries.set(data.id, { ...entry, data: { ...data, value: { ...data.value, relationChanges: [...data.value.relationChanges, change.relation] } } });
  } else if (change.kind === 'process-appended') {
    if (change.process.sequence !== data.value.processes.length + 1) throw new ObservationContractError('调用过程顺序不连续。');
    entries.set(data.id, { ...entry, data: { ...data, value: { ...data.value, processes: [...data.value.processes, change.process] } } });
  } else entries.set(data.id, { ...entry, data: { ...data, status: change.status, value: { ...data.value, ...change.result } } as CallableRecord });
}

function isTask(entry: RecordEntry | undefined): entry is RecordEntry & { data: CallableRecord } {
  return entry?.kind === 'invocation' && (entry.data as CallableRecord).role === 'conversation-task';
}

function snapshots(entries: ReadonlyMap<string, RecordEntry>, previous?: ReadonlyMap<string, ExecutionRecordSnapshot>, affected?: ReadonlySet<string>) {
  if (previous && affected?.size === 0) return { snapshots: previous, updates: new Map<string, ExecutionRecordSnapshot>() };
  const result = new Map(previous);
  const updates = new Map<string, ExecutionRecordSnapshot>();
  const ids = affected ?? new Set([...entries.values()].filter(isTask).map((entry) => entry.data.id));
  for (const id of ids) {
    result.delete(id);
    const item = entries.get(id);
    if (!isTask(item)) continue;
    const execution = item.data;
    const scope = [item, ...descendants(entries, item)];
    const calls = scope.filter((entry) => entry.kind === 'invocation').map((entry) => entry.data as CallableRecord);
    const boundaries = scope.filter((entry) => entry.kind === 'invocation-boundary').map((entry) => entry.data as InvocationBoundaryRecord);
    const resources = scope.filter((entry) => entry.kind === 'resource').map((entry) => entry.data as ResourceRecord);
    const transcripts = scope.filter((entry) => entry.kind === 'transcript').map((entry) => entry.data as TranscriptRecord);
    const memories = scope.filter((entry) => entry.kind === 'memory').map((entry) => entry.data as MemoryRecord);
    let ancestor = execution.parentId ? entries.get(execution.parentId) : undefined;
    const path: RecordEntry[] = [];
    const visited = new Set<string>();
    while (ancestor) {
      if (visited.has(ancestor.data.id)) throw new ObservationContractError('调用祖先存在循环。');
      visited.add(ancestor.data.id);
      if (ancestor.kind === 'invocation') path.push(ancestor);
      ancestor = ancestor.data.parentId ? entries.get(ancestor.data.parentId) : undefined;
    }
    path.reverse();
    const rootCall = path[0]?.data as CallableRecord | undefined;
    const ancestors = path.slice(1).map((entry) => entry.data as CallableRecord);
    if (execution.parentId && !rootCall && entries.get(execution.parentId)?.kind !== 'runtime') continue;
    const ancestorResources: ResourceRecord[] = [];
    for (const member of path) {
      const own = children(entries, member);
      boundaries.push(...own.filter((entry) => entry.kind === 'invocation-boundary' && (entry.data as InvocationBoundaryRecord).callId === member.data.id).map((entry) => entry.data as InvocationBoundaryRecord));
      ancestorResources.push(...own.filter((entry) => entry.kind === 'resource').map((entry) => entry.data as ResourceRecord));
    }
    resources.unshift(...ancestorResources);
    const called = new Set(boundaries.filter((event) => event.value.type === 'call').map((event) => event.callId));
    const returned = new Set(boundaries.filter((event) => event.value.type === 'return').map((event) => event.callId));
    const threw = new Set(boundaries.filter((event) => event.value.type === 'throw').map((event) => event.callId));
    // Updates and boundaries are separate facts. Do not expose a partially closed call snapshot.
    if ([...calls, ...ancestors, ...(rootCall ? [rootCall] : [])].some((call) => !called.has(call.id) || (call.status !== 'running' && !(call.status === 'succeeded' ? returned : threw).has(call.id)))) continue;
    boundaries.sort((left, right) => (left.scopeId === right.scopeId ? left.sequence - right.sequence : Date.parse(left.occurredAt) - Date.parse(right.occurredAt)));
    const snapshot = { execution, calls, ...(rootCall ? { rootCall } : {}), ...(ancestors.length ? { ancestors } : {}), boundaries, resources, transcripts, memories };
    validateExecutionRecordSnapshot(snapshot);
    result.set(execution.id, snapshot);
    updates.set(execution.id, snapshot);
  }
  return { snapshots: result, updates };
}

/** Follow recorded ownership; only explicit task roles select QA scopes. */
function affectedExecutions(previous: ReadonlyMap<string, RecordEntry>, entries: ReadonlyMap<string, RecordEntry>, changed: ReadonlySet<string>): Set<string> {
  const affected = new Set<string>();
  const visit = (source: ReadonlyMap<string, RecordEntry>, id: string) => {
    const visited = new Set<string>();
    let entry = source.get(id);
    if (entry?.kind === 'invocation') {
      for (const child of descendants(source, entry)) if (isTask(child)) affected.add(child.data.id);
    }
    while (entry) {
      if (visited.has(entry.data.id)) throw new ObservationContractError('记录归属存在循环。');
      visited.add(entry.data.id);
      if (isTask(entry)) affected.add(entry.data.id);
      if (!entry.data.parentId) return;
      entry = source.get(entry.data.parentId);
    }
  };
  for (const id of changed) {
    visit(previous, id);
    visit(entries, id);
  }
  return affected;
}

function descendants(entries: ReadonlyMap<string, RecordEntry>, parent: RecordEntry): RecordEntry[] {
  const result: RecordEntry[] = [];
  const pending = children(entries, parent).reverse();
  const visited = new Set([parent.data.id]);
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    if (visited.has(entry.data.id)) throw new ObservationContractError('记录归属存在循环或重复引用。');
    visited.add(entry.data.id);
    result.push(entry);
    pending.push(...children(entries, entry).reverse());
  }
  return result;
}

function children(entries: ReadonlyMap<string, RecordEntry>, parent: RecordEntry): RecordEntry[] {
  if (!('childIds' in parent.data)) return [];
  if (!isArray(parent.data.childIds)) throw new ObservationContractError('父级引用无效。');
  return parent.data.childIds.map((id) => {
    const child = entries.get(id);
    if (!child || child.data.parentId !== parent.data.id) throw new ObservationContractError('记录子级缺失或归属不一致。');
    return child;
  });
}
