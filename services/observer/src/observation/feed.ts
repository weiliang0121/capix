import { randomUUID } from 'node:crypto';
import type { ObservationBaseline, ObservationFrame, ObservationUpdate, ObserverChange, ObservationChange, RecordEntry, RecordingArchive } from '@capix/protocol';
import type { Transcript, Memories } from '@capix/server-runtime/content';
import { observeMemory, snapshotValue, CompositeRecord, CallableRecord, ExecutionRecord, RuntimeCallRecord, type BaseRecord, type RecordBook, type RecordingInstallation } from '@capix/server-runtime/recording';
import type { ChangeConsumer } from '../assembly/changes.js';
import type { RecordReceiver, RecordSource } from './record/source.js';
import { observeOverview } from './overview.js';
import { bindDelivery } from './delivery.js';

export interface ObservationEnvironment {
  readonly consumer: ChangeConsumer;
  readonly records: {
    readonly source: RecordSource;
    readonly installation: RecordingInstallation;
    readonly book: RecordBook;
    readonly archives?: readonly RecordingArchive[];
  };
  readonly transcript: Transcript;
  readonly memories: Memories;
}
/** Each connection consumes an atomic source opening; delivery never runs in a producer. */
export class ObservationFeed {
  readonly #connections = new Set<() => void>();
  constructor(private readonly observer: ObservationEnvironment) {}

  connect(listener: (frame: ObservationUpdate) => void): () => void {
    const { consumer, records, transcript, memories } = this.observer;
    const scopeId = randomUUID();
    let sequence = 0;
    const source = { open: (receiver: RecordReceiver) => records.source.open(receiver, (book) => activeRecords(book, records.installation.root.id)) };
    const delivery = bindDelivery<readonly RecordEntry[], ObserverChange, ObservationUpdate>(source, {
      attach: (sink) => {
        const position = consumer.position;
        this.#connections.add(sink.close);
        return consumer.subscribe((change, current) => {
          if (current > position && change.type !== 'record') sink.enqueue(change);
        });
      },
      closed: (connection) => {
        this.#connections.delete(connection.close);
      },
      baseline: (source) => {
        const baseline: ObservationBaseline = {
          type: 'baseline',
          scopeId,
          sequence,
          overview: observeOverview(this.observer),
          memory: observeMemory(memories, records.book),
          transcript: { id: transcript.id, revision: transcript.revision, starts: transcript.segments().map((segment) => segment.start) },
          memories: { id: memories.id, sequence: memories.sequence },
          recorder: { id: source.sourceId, revision: source.revision },
          entries: source.value,
          invocations: [...consumer.invocationEvents],
        };
        return wire(baseline);
      },
      delta: (changes) => wire({ type: 'delta', scopeId, sequence: ++sequence, changes: changes.map(observationChange) } satisfies ObservationFrame),
      incomplete: (error) => ({ type: 'error', code: error.code, error: error.message }),
      error: () => ({ type: 'error', code: 'OBSERVATION_ENCODING', error: '观测变化编码失败。' }),
      send: listener,
    });
    return delivery.close;
  }

  close(): void {
    for (const close of [...this.#connections]) close();
  }
}

/** A running ancestor can still receive a finished task: retain its subtree until that call ends. */
function activeRecords(book: RecordBook, rootId: string): BaseRecord<unknown>[] {
  const records = [...book.values()];
  const belongsToCurrent = (record: BaseRecord<unknown>): boolean => {
    const visited = new Set<string>();
    let current: BaseRecord<unknown> | undefined = record;
    while (current && !visited.has(current.id)) {
      if (current.id === rootId) return true;
      visited.add(current.id);
      current = current.parentId ? book.get(current.parentId) : undefined;
    }
    return false;
  };
  const selected = new Set<string>([rootId]);
  const pending: BaseRecord<unknown>[] = records.filter((record) => (record instanceof CallableRecord || record instanceof RuntimeCallRecord || record instanceof ExecutionRecord) && record.status === 'running' && belongsToCurrent(record));
  for (let record: BaseRecord<unknown> | undefined = pending.pop(); record; record = pending.pop()) {
    if (selected.has(record.id)) continue;
    selected.add(record.id);
    if (!(record instanceof CompositeRecord)) continue;
    for (const id of record.childIds) {
      const child = book.get(id);
      if (child) pending.push(child);
    }
  }
  return records.filter((record) => selected.has(record.id));
}
function wire<Value>(value: Value): Value {
  return snapshotValue(JSON.parse(JSON.stringify(value))) as Value;
}
function observationChange(event: ObserverChange): ObservationChange {
  if (event.type !== 'transcript' || event.change.kind !== 'messages-appended') return event as ObservationChange;
  return { ...event, change: { kind: 'messages-appended', start: event.change.start, end: event.change.start + event.change.messages.length } };
}
