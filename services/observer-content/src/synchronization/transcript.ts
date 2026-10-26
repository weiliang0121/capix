import type { TranscriptEvent, TranscriptSnapshot, TranscriptUpdate } from '@capix/protocol';
import type { Transcript } from '@capix/transcript';

/** The endpoint reads only the entity explicitly installed in this service. */
export function transcriptSnapshot(transcript: Transcript): TranscriptSnapshot {
  return { id: transcript.id, revision: transcript.revision, start: 0, end: transcript.length, starts: transcript.segments().map((segment) => segment.start), messages: transcript.snapshot() };
}

/** Entity delivery is independent from record subscriptions and contains no invocation data. */
export class TranscriptFeed {
  readonly #listeners = new Map<(frame: TranscriptUpdate) => void, number>();

  constructor(private readonly transcript: Transcript) {}

  connect(listener: (frame: TranscriptUpdate) => void): () => void {
    const snapshot = transcriptSnapshot(this.transcript);
    // The consumer drains source changes before connecting. No await separates capture and registration.
    this.#listeners.set(listener, snapshot.revision);
    this.deliver(listener, { type: 'baseline', snapshot });
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: TranscriptEvent): void {
    if (event.transcriptId !== this.transcript.id) return;
    for (const [listener, revision] of this.#listeners) {
      if (event.revision <= revision) continue;
      this.#listeners.set(listener, event.revision);
      this.deliver(listener, { type: 'delta', event });
    }
  }

  private deliver(listener: (frame: TranscriptUpdate) => void, frame: TranscriptUpdate): void {
    try {
      listener(frame);
    } catch {
      this.#listeners.delete(listener);
    }
  }

  close(): void {
    this.#listeners.clear();
  }
}
