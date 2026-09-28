import type { AttemptContext } from '../../context/attempt.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import type { Attempt } from '../../attempt/attempt.js';
import type { RuntimeRecorder } from '../recorder.js';
import type { RuntimeErrorValue } from '@capix-observer/protocol';
import type { RecordBook } from '../container/book.js';
import type { InvocationRecordIndex } from '../invocation/index.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord, type AttemptDefinition } from './record.js';

/** Attempt-specific operations. Index keys identify the owning operation, not the action name. */
export class AttemptRecordHelper {
  static recording<I, O>(recording: InvocationRecordHelper, attempt: Attempt<I, O>) {
    return recording.recording<AttemptContext<I, O>>(
      (context) => {
        const operation = recording.get(context.operationContext.id);
        if (!(operation instanceof OperationRecord)) throw new Error('Operation record does not exist');
        return this.create(recording.recorder, recording.index, { name: attempt.name, label: attempt.label, source: attempt.source, caller: 'operation', callee: attempt.callee, contextId: context.id, operationId: operation.id }, context.input);
      },
      (context, record, resultOf) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder.book, record.id, state.output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder.book, record.id, RuntimeErrorHelper.format(state.error));
      },
    );
  }

  static create(recorder: RuntimeRecorder, index: InvocationRecordIndex, definition: AttemptDefinition, input: unknown): AttemptRecord {
    const book = recorder.book;
    const operation = this.owner(book, definition.operationId);
    const execution = book.get(operation.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running' || operation.status !== 'running') throw new Error('Record has already ended');
    const record = new AttemptRecord(definition, input);
    return recorder.add(record, [index]);
  }

  static get(book: RecordBook, id: string): AttemptRecord {
    const record = book.get(id);
    if (!(record instanceof AttemptRecord)) throw new Error('Attempt does not exist');
    return record;
  }

  static findByOperation(book: RecordBook, index: InvocationRecordIndex, operationId: string): readonly AttemptRecord[] {
    this.owner(book, operationId);
    return index.attemptsOf(operationId);
  }

  static complete(book: RecordBook, id: string, output: unknown, resultOf?: number): void {
    this.get(book, id).complete(output, resultOf);
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
