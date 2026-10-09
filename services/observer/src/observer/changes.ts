import type { RuntimeChange, InvocationEvent } from '@capix-observer/protocol';
import type { ChangeObserver } from '@capix-observer/runtime';

/** One environment owns the buffer drain; individual delivery sources only subscribe. */
export class ChangeConsumer {
  readonly #listeners = new Set<(change: RuntimeChange, position: number) => void>();
  readonly #invocations = new Map<string, InvocationEvent>();
  readonly #pending: { change: RuntimeChange; position: number }[] = [];
  readonly #controller = new AbortController();
  #position = 0;
  #flushing = false;
  get invocations(): readonly InvocationEvent[] {
    return [...this.#invocations.values()];
  }
  /** Local handoff watermark only; not a producer revision or a wire delivery cursor. */
  get position(): number {
    return this.#position;
  }
  constructor(private readonly changes: ChangeObserver<RuntimeChange>) {
    void this.pump();
  }
  subscribe(listener: (change: RuntimeChange, position: number) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  private ingest(): void {
    for (const change of this.changes.take()) {
      this.#pending.push({ change, position: ++this.#position });
      if (change.type === 'invocation') {
        if (change.change.kind === 'finished') this.#invocations.delete(change.contextId);
        else this.#invocations.set(change.contextId, change);
      }
    }
  }
  flush(): void {
    // Even a reentrant opening must see the current captured facts before fixing its baseline.
    this.ingest();
    if (this.#flushing) return;
    this.#flushing = true;
    let offset = 0;
    try {
      while (offset < this.#pending.length) {
        const { change, position } = this.#pending[offset++]!;
        for (const listener of this.#listeners) {
          try {
            listener(change, position);
          } catch {
            this.#listeners.delete(listener);
          }
        }
        this.ingest();
      }
    } finally {
      this.#pending.splice(0, offset);
      this.#flushing = false;
    }
  }
  private async pump(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await this.changes.wait(this.#controller.signal);
      if (!this.#controller.signal.aborted) this.flush();
    }
  }
  close(): void {
    this.#controller.abort();
    this.#listeners.clear();
  }
}
