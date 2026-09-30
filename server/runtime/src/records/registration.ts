import type { RecordBook } from './container/book.js';
import type { BaseRecord } from './record.js';
import type { RecordTree } from './tree.js';
import { removeRegistration, prepareAttachment } from './tree/access.js';

export interface RegistrationIndex<R extends BaseRecord<unknown>> {
  add(record: R): void;
  remove(recordId: string): void;
}

/** One synchronous registration, including its direct relation and transitional indexes. */
export class RecordRegistration<R extends BaseRecord<unknown>> {
  private readonly attachment;

  constructor(
    private readonly book: RecordBook,
    tree: RecordTree,
    private readonly record: R,
    private readonly indexes: readonly RegistrationIndex<R>[],
  ) {
    this.attachment = tree[prepareAttachment](record);
  }

  commit(): readonly BaseRecord<unknown>[] {
    const attempted: RegistrationIndex<R>[] = [];
    try {
      for (const index of this.indexes) {
        attempted.push(index);
        index.add(this.record);
      }
      this.book.add(this.record);
      this.attachment?.commit();
    } catch (error) {
      const failures: unknown[] = [error];
      this.attachment?.rollback();
      // Also handle an add implementation that wrote before throwing.
      if (this.book.get(this.record.id) === this.record) this.book[removeRegistration](this.record);
      for (const index of attempted.reverse()) {
        try {
          index.remove(this.record.id);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Record registration and cleanup failed');
      throw error;
    }
    return Object.freeze(this.attachment ? [this.attachment.parent] : []);
  }
}
