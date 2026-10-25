import type { InvocationFailureFact, RuntimeErrorValue } from '@capix/contracts';
import { InvocationRecordHelper } from '../invocation/helper.js';

import type { Recorder } from '../recorder.js';
import type { RecordBook } from '../book.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord, type OperationRecordOptions } from './record.js';

/** Operation recording; scope queries and completion checks follow the record tree. */
export class OperationRecordHelper {
  static create(recorder: Recorder, options: OperationRecordOptions, input: unknown): OperationRecord {
    const book = recorder.book;
    const execution = book.get(options.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running') throw new Error('Record has already ended');
    if (options.parentOperationId) {
      const parent = book.get(options.parentOperationId);
      if (!(parent instanceof OperationRecord) || parent.executionId !== options.executionId) throw new Error('Parent operation belongs to another execution or does not exist');
      if (parent.status !== 'running') throw new Error('Record has already ended');
    }
    const record = new OperationRecord(options, input);
    return recorder.add(record);
  }

  static get(book: RecordBook, id: string): OperationRecord {
    const record = book.get(id);
    if (!(record instanceof OperationRecord)) throw new Error('Operation does not exist');
    return record;
  }

  static findByExecution(recorder: Recorder, executionId: string): readonly OperationRecord[] {
    if (!(recorder.book.get(executionId) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return recorder.tree.descendants(executionId).filter((record): record is OperationRecord => record instanceof OperationRecord);
  }

  static complete(recorder: Recorder, id: string, output: unknown, resultOf?: number): void {
    const record = this.prepareFinish(recorder, id);
    InvocationRecordHelper.finish(recorder, record, (record) => record.complete(output, resultOf));
  }

  static fail(recorder: Recorder, id: string, error: RuntimeErrorValue, failure?: InvocationFailureFact): void {
    const record = this.prepareFinish(recorder, id);
    InvocationRecordHelper.finish(recorder, record, (record) => record.fail(error, failure));
  }

  private static prepareFinish(recorder: Recorder, id: string): OperationRecord {
    const record = this.get(recorder.book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (recorder.tree.children(id).some((op) => op instanceof OperationRecord && op.status === 'running')) throw new Error('Cannot end a record with active operations');
    if (AttemptRecordHelper.findByOperation(recorder, id).some((attempt) => attempt.status === 'running')) throw new Error('Cannot end a record with active attempts');
    return record;
  }
}
