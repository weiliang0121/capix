import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { ExecutionValue, RecordEvent, RuntimeSnapshot } from '../../../shared/records.js';
import type { Clock } from '../../runtime/clock.js';
import type { RecordBook } from '../container/book.js';
import type { RecordIndex } from '../container/index.js';
import type { OperationRecord } from '../operation/record.js';
import { OperationRecordHelper } from '../operation/helper.js';
import type { AttemptRecord } from '../attempt/record.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from './record.js';

/** Execution-specific recording operations. All managed objects are explicit arguments. */
export class ExecutionRecordHelper {
  static create(book: RecordBook, clock: Clock, contextId: string, value: Omit<ExecutionValue, 'startedAt' | 'output' | 'error'>): ExecutionRecord {
    return book.add(new ExecutionRecord(contextId, { ...value, startedAt: clock.now() }));
  }

  static get(book: RecordBook, id: string): ExecutionRecord {
    const record = book.get(id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return record;
  }

  static complete(book: RecordBook, index: RecordIndex<OperationRecord>, id: string, output: unknown): void {
    const record = this.prepareFinish(book, index, id);
    record.complete(output);
  }

  static fail(book: RecordBook, index: RecordIndex<OperationRecord>, id: string, error: RuntimeErrorValue): void {
    const record = this.prepareFinish(book, index, id);
    record.fail(error);
  }

  private static prepareFinish(book: RecordBook, index: RecordIndex<OperationRecord>, id: string): ExecutionRecord {
    const record = this.get(book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (OperationRecordHelper.findByExecution(book, index, id).some((op) => op.status === 'running')) throw new Error('Cannot end a record with active operations');
    return record;
  }

  static snapshot(book: RecordBook, index: RecordIndex<OperationRecord>, attempts: RecordIndex<AttemptRecord>, id: string, events: readonly RecordEvent[]): RuntimeSnapshot {
    const operations = OperationRecordHelper.findByExecution(book, index, id);
    return {
      execution: this.get(book, id).toJSON(),
      operations: operations.map((record) => record.toJSON()),
      attempts: operations.flatMap((operation) => AttemptRecordHelper.findByOperation(book, attempts, operation.id).map((record) => record.toJSON())),
      events: events.map((event) => ({ ...event })),
    };
  }
}
