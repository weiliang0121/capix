import type { Transcript } from '@capix/transcript';
import type { TranscriptEvent, TranscriptFrame, TranscriptSnapshot } from '@capix/protocol';
import type { ObservationInstallation, CheckpointInstallation } from '@capix/server-runtime';

/** The host's message source. It consumes actual entity events, independently of recording. */
export class ConversationEvents {
  readonly #listeners = new Set<(event: TranscriptEvent) => void>();
  readonly #failures = new Set<() => void>();
  #available = true;
  readonly observation: ObservationInstallation = {
    bindInvocation: () => ({ observe() {}, transcript: (event) => this.publish(event) }),
    invalidate: () => this.invalidate(),
  };
  /** Restored calls publish their actual new content facts through the CP channel. */
  readonly checkpoint: NonNullable<CheckpointInstallation['feedback']> = {
    receive: (event) => {
      if (event.recovering && event.kind === 'transcript') this.publish(event.fact);
      return undefined;
    },
    failed: () => {
      this.invalidate();
      return undefined;
    },
  };

  constructor(readonly transcript: Transcript) {}

  get available(): boolean {
    return this.#available;
  }

  snapshot(): TranscriptSnapshot {
    const state = this.transcript.exportState();
    return Object.freeze({ id: state.id, revision: state.revision, start: 0, end: state.messages.length, starts: state.starts, messages: state.messages });
  }

  subscribe(receive: (event: TranscriptEvent) => void): () => void {
    if (!this.#available) throw new Error('Conversation content source is unavailable');
    this.#listeners.add(receive);
    return () => this.#listeners.delete(receive);
  }

  failed(receive: () => void): () => void {
    this.#failures.add(receive);
    if (!this.#available) receive();
    return () => this.#failures.delete(receive);
  }

  connect(receive: (frame: TranscriptFrame) => void): () => void {
    const detach = this.subscribe((event) => receive({ type: 'delta', event }));
    try {
      receive({ type: 'baseline', snapshot: this.snapshot() });
    } catch (error) {
      detach();
      throw error;
    }
    return detach;
  }

  close(): void {
    this.#available = false;
    this.#listeners.clear();
    this.#failures.clear();
  }

  private publish(event: TranscriptEvent): void {
    if (!this.#available) return;
    if (event.transcriptId !== this.transcript.id) throw new Error('Conversation content belongs to another transcript');
    for (const receive of [...this.#listeners]) {
      if (!this.#listeners.has(receive)) continue;
      try {
        receive(event);
      } catch {
        this.#listeners.delete(receive);
      }
    }
  }

  private invalidate(): void {
    if (!this.#available) return;
    this.#available = false;
    for (const failed of [...this.#failures]) {
      try {
        failed();
      } catch {
        this.#failures.delete(failed);
      }
    }
  }
}
