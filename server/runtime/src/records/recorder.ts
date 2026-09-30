import { randomUUID } from 'node:crypto';
import type { RecordChangeEvent, RecordMutation } from '@capix-observer/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { captureChange } from '../changes/publish.js';
import { snapshotValue } from './value/snapshot.js';
import { Clock } from '../runtime/clock.js';
import { RecordBook } from './container/book.js';
import type { BaseRecord } from './record.js';
import { RecordTree } from './tree.js';
import { RecordRegistration } from './registration.js';
import { writeRecord } from './error.js';

export interface RecorderOptions {
  clock?: Clock;
  changes?: ChangeCapture<RecordChangeEvent>;
}

/** Shared registration mechanism. Record kinds, lifecycle rules and projections belong to callers. */
export class Recorder {
  readonly id = randomUUID();
  #revision = 0;
  get revision(): number {
    return this.#revision;
  }
  readonly tree: RecordTree;
  readonly clock: Clock;
  private readonly changes?: ChangeCapture<RecordChangeEvent>;
  #registering = false;
  readonly #listeners = new Set<(record: BaseRecord<unknown>, change: 'add' | 'update', related: readonly BaseRecord<unknown>[]) => void>();

  constructor(
    readonly book: RecordBook,
    options: RecorderOptions = {},
  ) {
    this.clock = options.clock ?? new Clock();
    this.changes = options.changes;
    this.tree = new RecordTree(book);
  }

  add<R extends BaseRecord<unknown>>(record: R): R {
    const related = writeRecord(() => {
      if (this.#registering) throw new Error('Record registration cannot reenter');
      this.#registering = true;
      try {
        return new RecordRegistration(this.book, this.tree, record).commit();
      } finally {
        this.#registering = false;
      }
    });
    this.capture({ kind: 'added', entry: { kind: record.kind, data: record.toJSON() }, ...(related[0] ? { parent: { id: related[0].id, childId: record.id } } : {}) });
    this.notify(record, 'add', related);
    return record;
  }

  update<R extends BaseRecord<unknown>>(record: R, apply: (record: R) => void, describe?: (record: R) => RecordMutation): void {
    writeRecord(() => {
      if (this.#registering) throw new Error('Record registration cannot reenter');
      if (this.book.get(record.id) !== record) throw new Error('Record is not registered with this Recorder');
      apply(record);
    });
    this.capture(describe ? describe(record) : { kind: 'replaced', entry: { kind: record.kind, data: record.toJSON() } });
    this.notify(record, 'update');
  }

  private capture(change: RecordMutation): void {
    const revision = ++this.#revision;
    if (!this.changes) return;
    // Specific record snapshots preserve immutable message references; no later mutable reads.
    const event = snapshotValue({ type: 'record' as const, recorderId: this.id, revision, occurredAt: this.clock.now(), change });
    captureChange(this.changes, event);
  }

  subscribe(listener: (record: BaseRecord<unknown>, change: 'add' | 'update', related: readonly BaseRecord<unknown>[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  private notify(record: BaseRecord<unknown>, change: 'add' | 'update', related: readonly BaseRecord<unknown>[] = []): void {
    for (const listener of this.#listeners) {
      try {
        listener(record, change, related);
      } catch {
        console.error('运行记录通知失败；已登记的事实保持不变。');
      }
    }
  }
}
