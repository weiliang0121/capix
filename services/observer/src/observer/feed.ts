import { randomUUID } from 'node:crypto';
import type { ObservationBaseline, ObservationFrame, ObservationUpdate, RuntimeChange, InvocationEvent, ObservationChange, TranscriptUpdate } from '@capix-observer/protocol';
import { ChangeObserver, ExecutionRecord, observeMemory, snapshotValue } from '@capix-observer/runtime';
import type { initializeObserver } from './environment.js';
import { observeOverview } from './overview.js';
import { TranscriptFeed } from './transcript/feed.js';

type Environment = ReturnType<typeof initializeObserver>;
/** Consumption/delivery boundary. Producers never invoke these listeners. */
export class ObservationFeed {
  readonly scopeId = randomUUID();
  #sequence = 0;
  readonly #listeners = new Set<(frame: ObservationUpdate) => void>();
  readonly #invocations = new Map<string, InvocationEvent>();
  readonly #controller = new AbortController();
  readonly #transcripts: TranscriptFeed;
  constructor(
    private readonly observer: Environment,
    private readonly changes: ChangeObserver<RuntimeChange>,
  ) {
    this.#transcripts = new TranscriptFeed(observer.transcript);
    void this.pump();
  }

  private async pump(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await this.changes.wait(this.#controller.signal);
      if (!this.#controller.signal.aborted) this.flush();
    }
  }

  /** Synchronous drain before a baseline establishes one unambiguous handoff point. */
  private flush(): void {
    const changes = this.changes.take();
    if (!changes.length) return;
    for (const change of changes) if (change.type === 'transcript') this.#transcripts.publish(change);
    for (const change of changes)
      if (change.type === 'invocation') {
        if (change.change.kind === 'finished') this.#invocations.delete(change.contextId);
        else this.#invocations.set(change.contextId, change);
      }
    const sequence = ++this.#sequence;
    try {
      const frame = wire({ type: 'delta', scopeId: this.scopeId, sequence, changes: changes.map(observationChange) } satisfies ObservationFrame);
      for (const listener of this.#listeners) this.deliver(listener, frame);
    } catch {
      for (const listener of this.#listeners) this.deliver(listener, { type: 'error', code: 'OBSERVATION_ENCODING', error: '观测变化编码失败，需要重新建立基线。' });
    }
  }

  connect(listener: (frame: ObservationUpdate) => void): () => void {
    this.flush();
    const { runtime, recorder, transcript, book, memories } = this.observer;
    const entries = [...book.values()]
      .filter((record) => record === runtime.record || (record instanceof ExecutionRecord && record.status === 'running'))
      .flatMap((record) => (record === runtime.record ? [record] : [record, ...recorder.tree.descendants(record.id)]))
      .map((record) => ({ kind: record.kind, data: record.toJSON() }));
    const baseline: ObservationBaseline = { type: 'baseline', scopeId: this.scopeId, sequence: this.#sequence, overview: observeOverview(this.observer), memory: observeMemory(memories, book), transcript: { id: transcript.id, revision: transcript.revision, starts: transcript.segments().map((segment) => segment.start) }, memories: { id: memories.id, sequence: memories.sequence }, recorder: { id: recorder.id, revision: recorder.revision }, entries, invocations: [...this.#invocations.values()] };
    // No await between snapshot capture and registration; callback receives already fixed wire data.
    const frame = wire(baseline);
    this.#listeners.add(listener);
    this.deliver(listener, frame);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  connectTranscript(listener: (frame: TranscriptUpdate) => void): () => void {
    this.flush();
    return this.#transcripts.connect(listener);
  }

  private deliver(listener: (frame: ObservationUpdate) => void, frame: ObservationUpdate): void {
    try {
      listener(frame);
    } catch {
      this.#listeners.delete(listener);
    }
  }

  close(): void {
    this.#controller.abort();
    this.#listeners.clear();
    this.#transcripts.close();
  }
}
function wire<T>(value: T): T {
  return snapshotValue(JSON.parse(JSON.stringify(value))) as T;
}

function observationChange(event: RuntimeChange): ObservationChange {
  if (event.type !== 'transcript' || event.change.kind !== 'messages-appended') return event as ObservationChange;
  return { ...event, change: { kind: 'messages-appended', start: event.change.start, end: event.change.start + event.change.messages.length } };
}
