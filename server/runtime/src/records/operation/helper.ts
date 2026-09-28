import type { OperationContext } from '../../context/operation.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import type { Operation } from '../../operations/operation.js';
import type { RuntimeRecorder } from '../recorder.js';
import type { RuntimeErrorValue } from '@capix-observer/protocol';
import type { RecordBook } from '../container/book.js';
import type { InvocationRecordIndex } from '../invocation/index.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord, type OperationRecordDefinition } from './record.js';

/** Operation-specific recording operations. Index keys here represent execution IDs. */
export class OperationRecordHelper {
  static recording<I, O>(recording: InvocationRecordHelper, operation: Operation<I, O>, parentContext?: OperationContext) {
    return recording.recording<OperationContext<I, O>>(
      (context) => {
        const execution = recording.get(context.executionContext.id);
        if (!(execution instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
        const parent = parentContext ? recording.get(parentContext.id) : undefined;
        if (parent && !(parent instanceof OperationRecord)) throw new Error('Parent operation record does not exist');
        return this.create(recording.recorder, recording.index, { operationInstanceId: operation.id, operation: operation.name, label: operation.label, source: operation.source, caller: parentContext ? 'operation' : 'execution', callee: 'operation', contextId: context.id, executionId: execution.id, ...(parent ? { parentOperationId: parent.id } : {}) }, context.input);
      },
      (context, record, resultOf) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder.book, recording.index, record.id, state.output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder.book, recording.index, record.id, RuntimeErrorHelper.format(state.error));
      },
    );
  }

  static create(recorder: RuntimeRecorder, index: InvocationRecordIndex, definition: OperationRecordDefinition, input: unknown): OperationRecord {
    const book = recorder.book;
    const execution = book.get(definition.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    if (execution.status !== 'running') throw new Error('Record has already ended');
    if (definition.parentOperationId) {
      const parent = book.get(definition.parentOperationId);
      if (!(parent instanceof OperationRecord) || parent.executionId !== definition.executionId) throw new Error('Parent operation belongs to another execution or does not exist');
      if (parent.status !== 'running') throw new Error('Record has already ended');
    }
    const record = new OperationRecord(definition, input);
    return recorder.add(record, [index]);
  }

  static get(book: RecordBook, id: string): OperationRecord {
    const record = book.get(id);
    if (!(record instanceof OperationRecord)) throw new Error('Operation does not exist');
    return record;
  }

  static findByExecution(book: RecordBook, index: InvocationRecordIndex, executionId: string): readonly OperationRecord[] {
    if (!(book.get(executionId) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return index.operationsOf(executionId);
  }

  static complete(book: RecordBook, index: InvocationRecordIndex, id: string, output: unknown, resultOf?: number): void {
    const record = this.prepareFinish(book, index, id);
    record.complete(output, resultOf);
  }

  static fail(book: RecordBook, index: InvocationRecordIndex, id: string, error: RuntimeErrorValue): void {
    const record = this.prepareFinish(book, index, id);
    record.fail(error);
  }

  private static prepareFinish(book: RecordBook, index: InvocationRecordIndex, id: string): OperationRecord {
    const record = this.get(book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (this.findByExecution(book, index, record.executionId).some((op) => op.parentOperationId === id && op.status === 'running')) throw new Error('Cannot end a record with active operations');
    if (AttemptRecordHelper.findByOperation(book, index, id).some((attempt) => attempt.status === 'running')) throw new Error('Cannot end a record with active attempts');
    return record;
  }
}
