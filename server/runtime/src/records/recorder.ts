import { Clock } from '../runtime/clock.js';
import { RecordBook } from './container/book.js';
import type { BaseRecord } from './record.js';
import { RecordTree } from './tree.js';
import { RecordRegistration, type RegistrationIndex } from './registration.js';
import { writeRecord } from './error.js';

/** Shared registration mechanism. Record kinds, lifecycle rules and projections belong to callers. */
export class Recorder {
  readonly tree: RecordTree;
  #registering = false;
  readonly #listeners = new Set<(record: BaseRecord<unknown>, change: 'add' | 'update', related: readonly BaseRecord<unknown>[]) => void>();

  constructor(
    readonly book: RecordBook,
    readonly clock = new Clock(),
  ) {
    this.tree = new RecordTree(book);
  }

  add<R extends BaseRecord<unknown>>(record: R, indexes: readonly RegistrationIndex<NoInfer<R>>[] = []): R {
    const related = writeRecord(() => {
      if (this.#registering) throw new Error('Record registration cannot reenter');
      this.#registering = true;
      try {
        return new RecordRegistration(this.book, this.tree, record, indexes).commit();
      } finally {
        this.#registering = false;
      }
    });
    this.notify(record, 'add', related);
    return record;
  }

  update<R extends BaseRecord<unknown>>(record: R, apply: (record: R) => void): void {
    writeRecord(() => {
      if (this.#registering) throw new Error('Record registration cannot reenter');
      if (this.book.get(record.id) !== record) throw new Error('Record is not registered with this Recorder');
      apply(record);
    });
    this.notify(record, 'update');
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
