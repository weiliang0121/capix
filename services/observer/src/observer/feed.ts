import { randomUUID } from 'node:crypto';
import type { ObservationBaseline, ObservationFrame, ObservationUpdate, RuntimeChange, ObservationChange, TranscriptUpdate, RecordEntry, ExecutionRecord, RuntimeCallRecord } from '@capix-observer/protocol';
import { observeMemory, snapshotValue } from '@capix-observer/runtime';
import type { initializeObserver } from './environment.js';
import { observeOverview } from './overview.js';
import { bindDelivery } from '../observation/delivery.js';

type Environment = ReturnType<typeof initializeObserver>;
/** Each connection consumes an atomic source opening; delivery never runs in a producer. */
export class ObservationFeed {
  readonly #connections = new Set<() => void>();
  constructor(private readonly observer: Environment) {}

  connect(listener: (frame: ObservationUpdate) => void): () => void {
    const { consumer, recordSource, recording, transcript, book, memories } = this.observer;
    const scopeId = randomUUID();
    let sequence = 0;
    const delivery = bindDelivery<readonly RecordEntry[], RuntimeChange, ObservationUpdate>(recordSource, {
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
          memory: observeMemory(memories, book),
          transcript: { id: transcript.id, revision: transcript.revision, starts: transcript.segments().map((segment) => segment.start) },
          memories: { id: memories.id, sequence: memories.sequence },
          recorder: { id: source.sourceId, revision: source.revision },
          entries: activeEntries(source.value, recording.root.id),
          invocations: [...consumer.invocations],
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

  connectTranscript(listener: (frame: TranscriptUpdate) => void): () => void {
    this.observer.consumer.flush();
    const unsubscribe = this.observer.transcripts.connect(listener);
    const close = () => {
      unsubscribe();
      this.#connections.delete(close);
    };
    this.#connections.add(close);
    return close;
  }
  close(): void {
    for (const close of [...this.#connections]) close();
  }
}

/** A running R can be receiving a finished E: retain that whole local subtree until R finishes. */
function activeEntries(entries: readonly RecordEntry[], rootId?: string): RecordEntry[] {
  const selected = new Set(entries.filter((entry) => entry.data.id === rootId || ((entry.kind === 'runtime-call' || entry.kind === 'execution') && (entry.data as RuntimeCallRecord | ExecutionRecord).status === 'running')).map((entry) => entry.data.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (selected.has(entry.data.id) || !entry.data.parentId || entry.data.parentId === rootId || !selected.has(entry.data.parentId)) continue;
      selected.add(entry.data.id);
      changed = true;
    }
  }
  return entries.filter((entry) => selected.has(entry.data.id));
}
function wire<T>(value: T): T {
  return snapshotValue(JSON.parse(JSON.stringify(value))) as T;
}
function observationChange(event: RuntimeChange): ObservationChange {
  if (event.type !== 'transcript' || event.change.kind !== 'messages-appended') return event as ObservationChange;
  return { ...event, change: { kind: 'messages-appended', start: event.change.start, end: event.change.start + event.change.messages.length } };
}
