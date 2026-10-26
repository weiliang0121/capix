import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RecordChangeEvent, RecordMutation } from '@capix/protocol';
import type { ChangeCapture } from '@capix/changes';
import { captureChange } from '@capix/changes';
import { snapshotValue } from './value/snapshot.js';
import { RecordBook } from './book.js';
import type { BaseRecord } from './record.js';
import { RecordTree } from './tree/tree.js';
import { RecordRegistration } from './registration.js';
import { writeRecord } from './error.js';

/** Wall time for record dates; monotonic time for observed durations. */
export interface RecordClock {
  now(): string;
  tick(): number;
}

export interface RecorderOptions {
  clock?: RecordClock;
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
  readonly clock: RecordClock;
  private readonly changes?: ChangeCapture<RecordChangeEvent>;
  #registering = false;
  readonly #listeners = new Set<(record: BaseRecord<unknown>, change: 'add' | 'update', related: readonly BaseRecord<unknown>[]) => void>();

  constructor(
    readonly book: RecordBook,
    options: RecorderOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date().toISOString(), tick: () => performance.now() };
    this.changes = options.changes;
    this.tree = new RecordTree(book);
  }

  add<RecordType extends BaseRecord<unknown>>(record: RecordType): RecordType {
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

  update<RecordType extends BaseRecord<unknown>>(record: RecordType, apply: (record: RecordType) => void, describe?: (record: RecordType) => RecordMutation): void {
    writeRecord(() => {
      if (this.#registering) throw new Error('Record registration cannot reenter');
      if (this.book.get(record.id) !== record) throw new Error('Record is not registered with this Recorder');
      if (record.historical) throw new Error('Historical record is read-only');
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
