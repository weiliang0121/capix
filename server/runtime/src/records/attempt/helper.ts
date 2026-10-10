import type { InvocationFailureFact } from '@capix/protocol';
import { InvocationRecordHelper } from '../invocation/helper.js';

import type { Recorder } from '../recorder.js';
import type { RuntimeErrorValue } from '@capix/protocol';
import type { RecordBook } from '../container/book.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord, type AttemptRecordOptions } from './record.js';

/** Attempt recording; direct ownership queries follow the record tree. */
export class AttemptRecordHelper {
  static create(recorder: Recorder, options: AttemptRecordOptions, input: unknown): AttemptRecord {
    const book = recorder.book;
    const operation = this.owner(book, options.operationId);
    const execution = book.get(operation.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running' || operation.status !== 'running') throw new Error('Record has already ended');
    const record = new AttemptRecord(options, input);
    return recorder.add(record);
  }

  static get(book: RecordBook, id: string): AttemptRecord {
    const record = book.get(id);
    if (!(record instanceof AttemptRecord)) throw new Error('Attempt does not exist');
    return record;
  }

  static findByOperation(recorder: Recorder, operationId: string): readonly AttemptRecord[] {
    this.owner(recorder.book, operationId);
    return recorder.tree.children(operationId).filter((record): record is AttemptRecord => record instanceof AttemptRecord);
  }

  static complete(recorder: Recorder, id: string, output: unknown, resultOf?: number): void {
    InvocationRecordHelper.finish(recorder, this.get(recorder.book, id), (record) => record.complete(output, resultOf));
  }

  static fail(recorder: Recorder, id: string, error: RuntimeErrorValue, failure?: InvocationFailureFact): void {
    InvocationRecordHelper.finish(recorder, this.get(recorder.book, id), (record) => record.fail(error, failure));
  }

  private static owner(book: RecordBook, id: string): OperationRecord {
    const operation = book.get(id);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation does not exist');
    return operation;
  }
}
