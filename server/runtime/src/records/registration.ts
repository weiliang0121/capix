import type { RecordBook } from './container/book.js';
import type { BaseRecord } from './record.js';
import type { RecordTree } from './tree.js';
import { removeRegistration, prepareAttachment } from './tree/access.js';

/** One synchronous registration, including its direct relation. */
export class RecordRegistration<R extends BaseRecord<unknown>> {
  private readonly attachment;

  constructor(
    private readonly book: RecordBook,
    tree: RecordTree,
    private readonly record: R,
  ) {
    this.attachment = tree[prepareAttachment](record);
  }

  commit(): readonly BaseRecord<unknown>[] {
    try {
      this.book.add(this.record);
      this.attachment?.commit();
    } catch (error) {
      this.attachment?.rollback();
      // Also handle an add implementation that wrote before throwing.
      if (this.book.get(this.record.id) === this.record) this.book[removeRegistration](this.record);
      throw error;
    }
    return Object.freeze(this.attachment ? [this.attachment.parent] : []);
  }
}
