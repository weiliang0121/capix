import type { RuntimeErrorValue } from '../../../shared/errors.js';
import type { RecordBook } from '../container/book.js';
import type { RecordIndex } from '../container/index.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord, type AttemptDefinition } from './record.js';

/** Attempt-specific operations. Index keys identify the owning operation, not its phase. */
export class AttemptRecordHelper {
  static create(book: RecordBook, index: RecordIndex<AttemptRecord>, definition: AttemptDefinition, input: unknown): AttemptRecord {
    const operation = this.owner(book, definition.operationId);
    const execution = book.get(operation.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running' || operation.status !== 'running') throw new Error('Record has already ended');
    const record = new AttemptRecord(definition, input);
    index.add(record);
    try {
      return book.add(record);
    } catch (error) {
      index.remove(record.id);
      throw error;
    }
  }

  static get(book: RecordBook, id: string): AttemptRecord {
    const record = book.get(id);
    if (!(record instanceof AttemptRecord)) throw new Error('Attempt does not exist');
    return record;
  }

  static findByOperation(book: RecordBook, index: RecordIndex<AttemptRecord>, operationId: string): readonly AttemptRecord[] {
    this.owner(book, operationId);
    return index.get(operationId).map((id) => {
      const record = this.get(book, id);
      if (record.operationId !== operationId) throw new Error('Attempt index contains another operation');
      return record;
    });
  }

  static complete(book: RecordBook, id: string, output: unknown): void {
    this.get(book, id).complete(output);
  }

  static fail(book: RecordBook, id: string, error: RuntimeErrorValue): void {
    this.get(book, id).fail(error);
  }

  private static owner(book: RecordBook, id: string): OperationRecord {
    const operation = book.get(id);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation does not exist');
    return operation;
  }
}
