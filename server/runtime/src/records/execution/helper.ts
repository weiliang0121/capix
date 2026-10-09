import type { InvocationObservation } from '../../invocation/recording.js';
import { failureFact } from '../../invocation/failure.js';
import type { InvocationFailureFact } from '@capix-observer/protocol';
import type { Invocation } from '../../invocation/invocation.js';
import type { ExecutionContext } from '../../context/execution.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import type { Recorder } from '../recorder.js';
import { InvocationBoundaryRecordHelper } from '../invocation-boundary/helper.js';
import type { RuntimeErrorValue, ExecutionValue, RuntimeSnapshot } from '@capix-observer/protocol';

import type { RecordBook } from '../container/book.js';
import { OperationRecordHelper } from '../operation/helper.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from './record.js';
import { ResourceRecord } from '../resource/record.js';

/** Execution-specific recording operations. All managed objects are explicit arguments. */
export class ExecutionRecordHelper {
  static recording<I, O>(recording: InvocationRecordHelper, observation?: InvocationObservation<I, O>) {
    return recording.recording<ExecutionContext<I, O>>(
      (context, input) => this.create(recording.recorder, { contextId: context.id, parentId: recording.root.id }, { input }),
      (context, record, resultOf, output) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder, record.id, output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder, record.id, RuntimeErrorHelper.format(state.error), state.failure ? failureFact(state.failure) : undefined);
      },
      observation,
    );
  }

  static observe(recording: InvocationRecordHelper, invocation: Invocation<unknown, unknown, ExecutionContext>): RuntimeSnapshot {
    const record = invocation.record;
    if (!(record instanceof ExecutionRecord) || recording.recorder.book.get(record.id) !== record || recording.recorder.tree.root(record.id) !== recording.root) throw new Error('Execution record does not exist');
    return this.snapshot(recording.recorder, record.id);
  }

  static create(recorder: Recorder, definition: { contextId: string; parentId: string }, value: Omit<ExecutionValue, 'startedAt' | 'output' | 'error' | 'processes' | 'resultOf'>): ExecutionRecord {
    return recorder.add(new ExecutionRecord(definition.contextId, { ...value, startedAt: recorder.clock.now() }, definition.parentId));
  }

  static get(book: RecordBook, id: string): ExecutionRecord {
    const record = book.get(id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return record;
  }

  static complete(recorder: Recorder, id: string, output: unknown, resultOf?: number): void {
    const record = this.prepareFinish(recorder, id);
    InvocationRecordHelper.finish(recorder, record, (record) => record.complete(output, resultOf));
  }

  static fail(recorder: Recorder, id: string, error: RuntimeErrorValue, failure?: InvocationFailureFact): void {
    const record = this.prepareFinish(recorder, id);
    InvocationRecordHelper.finish(recorder, record, (record) => record.fail(error, failure));
  }

  private static prepareFinish(recorder: Recorder, id: string): ExecutionRecord {
    const record = this.get(recorder.book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (OperationRecordHelper.findByExecution(recorder, id).some((op) => op.status === 'running')) throw new Error('Cannot end a record with active operations');
    return record;
  }

  static snapshot(recorder: Recorder, id: string): RuntimeSnapshot {
    const operations = OperationRecordHelper.findByExecution(recorder, id);
    return {
      execution: this.get(recorder.book, id).toJSON(),
      operations: operations.map((record) => record.toJSON()),
      attempts: operations.flatMap((operation) => AttemptRecordHelper.findByOperation(recorder, operation.id).map((record) => record.toJSON())),
      events: InvocationBoundaryRecordHelper.findByExecution(recorder, id).map((event) => event.toJSON()),
      resources: recorder.tree
        .descendants(id)
        .filter((record): record is ResourceRecord => record instanceof ResourceRecord)
        .map((record) => record.toJSON()),
    };
  }
}
