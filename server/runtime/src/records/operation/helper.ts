import type { InvocationObservation } from '../../invocation/recording.js';
import { failureFact } from '../../invocation/failure.js';
import type { InvocationFailureFact } from '@capix-observer/protocol';
import type { Invocation } from '../../invocation/invocation.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { OperationContext } from '../../context/operation.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';

import type { Recorder } from '../recorder.js';
import type { RuntimeErrorValue } from '@capix-observer/protocol';
import type { RecordBook } from '../container/book.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord, type OperationRecordDefinition } from './record.js';

export interface OperationDescription {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
}

/** Operation recording; scope queries and completion checks follow the record tree. */
export class OperationRecordHelper {
  static recording<I, O>(recording: InvocationRecordHelper, operation: OperationDescription, parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, observation?: InvocationObservation<I, O>) {
    return recording.recording<OperationContext<I, O>>(
      (context, input) => {
        const owner = parent.record;
        if (!(owner instanceof ExecutionRecord || owner instanceof OperationRecord) || recording.recorder.book.get(owner.id) !== owner) throw new Error('Parent invocation record is not registered here');
        const executionId = owner instanceof ExecutionRecord ? owner.id : owner.executionId;
        return this.create(recording.recorder, { operationInstanceId: operation.id, operation: operation.name, label: operation.label, source: operation.source, caller: owner instanceof OperationRecord ? 'operation' : 'execution', callee: 'operation', contextId: context.id, executionId, ...(owner instanceof OperationRecord ? { parentOperationId: owner.id } : {}) }, input);
      },
      (context, record, resultOf, output) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder, record.id, output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder, record.id, RuntimeErrorHelper.format(state.error), state.failure ? failureFact(state.failure) : undefined);
      },
      observation,
    );
  }

  static create(recorder: Recorder, definition: OperationRecordDefinition, input: unknown): OperationRecord {
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
