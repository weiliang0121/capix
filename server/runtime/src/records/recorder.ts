import { Clock } from '../runtime/clock.js';
import { RecordBook } from './container/book.js';
import type { RuntimeRecord } from './record.js';
import { writeRecord } from './error.js';

/** Shared registration mechanism. Record kinds, lifecycle rules and projections belong to callers. */
export class RuntimeRecorder {
  readonly #listeners = new Set<(record: RuntimeRecord<unknown>, change: 'add' | 'update') => void>();

  constructor(
    readonly book: RecordBook,
    readonly clock = new Clock(),
  ) {}

  add<R extends RuntimeRecord<unknown>>(record: R, indexes: readonly { add(record: NoInfer<R>): void; remove(recordId: string): void }[] = []): R {
    writeRecord(() => {
      if (this.book.get(record.id)) throw new Error('Record ID already exists');
      const registered: (typeof indexes)[number][] = [];
      try {
        for (const index of indexes) {
          index.add(record);
          registered.push(index);
        }
        this.book.add(record);
      } catch (error) {
        for (const index of registered) index.remove(record.id);
        throw error;
      }
    });
    this.notify(record, 'add');
    return record;
  }

  update<R extends RuntimeRecord<unknown>>(record: R, apply: (record: R) => void): void {
    writeRecord(() => {
      if (this.book.get(record.id) !== record) throw new Error('Record is not registered with this Recorder');
      apply(record);
    });
    this.notify(record, 'update');
  }

  subscribe(listener: (record: RuntimeRecord<unknown>, change: 'add' | 'update') => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  private notify(record: RuntimeRecord<unknown>, change: 'add' | 'update'): void {
    for (const listener of this.#listeners) {
      try {
        listener(record, change);
      } catch {
        console.error('运行记录通知失败；已登记的事实保持不变。');
      }
    }
  }
}
