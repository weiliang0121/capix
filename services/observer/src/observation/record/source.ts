import type { RecordChangeEvent, RecordEntry } from '@capix/protocol';
import { snapshotValue, type Recorder } from '@capix/server-runtime/recording';
import type { ChangeConsumer } from '../../assembly/changes.js';

import { SourceIncomplete, type ObservationSource, type SourceReceiver } from '../delivery.js';
export { SourceIncomplete } from '../delivery.js';
export type RecordReceiver = SourceReceiver<RecordChangeEvent>;
/** Integrity belongs to the lifetime of the source, not to any HTTP connection. */
export class RecordSource implements ObservationSource<readonly RecordEntry[], RecordChangeEvent> {
  readonly #receivers = new Map<RecordReceiver, number>();
  #failure?: SourceIncomplete;
  constructor(
    private readonly recorder: Recorder,
    private readonly consumer: ChangeConsumer,
  ) {
    consumer.subscribe((change) => {
      if (change.type !== 'record' || change.recorderId !== recorder.id || this.#failure) return;
      for (const [receiver, revision] of this.#receivers) {
        if (change.revision <= revision) continue;
        this.#receivers.set(receiver, change.revision);
        try {
          receiver.change({ revision: change.revision, value: change });
        } catch {
          this.#receivers.delete(receiver);
        }
      }
    });
  }
  assertComplete(): void {
    if (this.#failure) throw this.#failure;
  }
  invalidate(error: unknown): void {
    if (this.#failure) return;
    this.#failure = new SourceIncomplete(this.recorder.id, '记录来源已不完整，不能继续提供完整的观测基线或增量。', { cause: error });
    const receivers = [...this.#receivers.keys()];
    this.#receivers.clear();
    for (const receiver of receivers) {
      try {
        receiver.incomplete(this.#failure);
      } catch {
        /* One consumer cannot prevent other consumers learning of the gap. */
      }
    }
  }
  open(receiver: RecordReceiver): { baseline: { sourceId: string; revision: number; value: readonly RecordEntry[] }; close(): void } {
    this.assertComplete();
    this.consumer.flush();
    this.assertComplete();
    const entries = [...this.recorder.book.values()].map((record) => ({ kind: record.kind, data: record.toJSON() }));
    const baseline = { sourceId: this.recorder.id, revision: this.recorder.revision, value: snapshotValue(entries) as readonly RecordEntry[] };
    this.assertComplete();
    this.#receivers.set(receiver, baseline.revision);
    return {
      baseline,
      close: () => {
        this.#receivers.delete(receiver);
      },
    };
  }
}
