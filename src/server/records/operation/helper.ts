import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { RecordBook } from '../container/book.js';
import type { RecordIndex } from '../container/index.js';
import type { AttemptRecord } from '../attempt/record.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord, type OperationDefinition } from './record.js';

/** Operation-specific recording operations. Index keys here represent execution IDs. */
export class OperationRecordHelper {
  static create(book: RecordBook, index: RecordIndex<OperationRecord>, definition: OperationDefinition, input: unknown): OperationRecord {
    const execution = book.get(definition.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running') throw new Error('Record has already ended');
    if (definition.parentOperationId) {
      const parent = book.get(definition.parentOperationId);
      if (!(parent instanceof OperationRecord) || parent.executionId !== definition.executionId) throw new Error('Parent operation belongs to another execution or does not exist');
      if (parent.status !== 'running') throw new Error('Record has already ended');
    }
    const record = new OperationRecord(definition, input);
    // Index evaluation can fail. Do it before registering the new record in Book.
    index.add(record);
    try {
      return book.add(record);
    } catch (error) {
      index.remove(record.id);
      throw error;
    }
  }

  static get(book: RecordBook, id: string): OperationRecord {
    const record = book.get(id);
    if (!(record instanceof OperationRecord)) throw new Error('Operation does not exist');
    return record;
  }

  static findByExecution(book: RecordBook, index: RecordIndex<OperationRecord>, executionId: string): readonly OperationRecord[] {
    if (!(book.get(executionId) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return index.get(executionId).map((id) => {
      const record = this.get(book, id);
      if (record.executionId !== executionId) throw new Error('Operation index contains another execution');
      return record;
    });
  }

  static complete(book: RecordBook, index: RecordIndex<OperationRecord>, attempts: RecordIndex<AttemptRecord>, id: string, output: unknown): void {
    const record = this.prepareFinish(book, index, attempts, id);
    record.complete(output);
  }

  static fail(book: RecordBook, index: RecordIndex<OperationRecord>, attempts: RecordIndex<AttemptRecord>, id: string, error: RuntimeErrorValue): void {
    const record = this.prepareFinish(book, index, attempts, id);
    record.fail(error);
  }

  private static prepareFinish(book: RecordBook, index: RecordIndex<OperationRecord>, attempts: RecordIndex<AttemptRecord>, id: string): OperationRecord {
    const record = this.get(book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (this.findByExecution(book, index, record.executionId).some((op) => op.parentOperationId === id && op.status === 'running')) throw new Error('Cannot end a record with active operations');
    if (AttemptRecordHelper.findByOperation(book, attempts, id).some((attempt) => attempt.status === 'running')) throw new Error('Cannot end a record with active attempts');
    return record;
  }
}
