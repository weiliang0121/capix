import type { ExecutionContext } from '../../context/execution.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import type { RuntimeRecorder } from '../recorder.js';
import { EventRecordHelper } from '../event/helper.js';
import type { RuntimeErrorValue, ExecutionValue, RuntimeSnapshot } from '@capix-observer/protocol';

import type { Clock } from '../../runtime/clock.js';
import type { RecordBook } from '../container/book.js';
import type { InvocationRecordIndex } from '../invocation/index.js';
import { OperationRecordHelper } from '../operation/helper.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from './record.js';

/** Execution-specific recording operations. All managed objects are explicit arguments. */
export class ExecutionRecordHelper {
  static recording(recording: InvocationRecordHelper) {
    return recording.recording<ExecutionContext>(
      (context) => this.create(recording.recorder, recording.index, recording.recorder.clock, context.id, { input: context.input, settings: context.settings, ...(context.transcriptRange ? { transcriptRange: context.transcriptRange } : {}) }),
      (context, record, resultOf) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder.book, recording.index, record.id, state.output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder.book, recording.index, record.id, RuntimeErrorHelper.format(state.error));
      },
    );
  }

  static observe(recording: InvocationRecordHelper, context: ExecutionContext): RuntimeSnapshot {
    const record = recording.get(context.id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
    return this.snapshot(recording.recorder.book, recording.index, record.id);
  }

  static create(recorder: RuntimeRecorder, index: InvocationRecordIndex, clock: Clock, contextId: string, value: Omit<ExecutionValue, 'startedAt' | 'output' | 'error' | 'processes' | 'resultOf'>): ExecutionRecord {
    return recorder.add(new ExecutionRecord(contextId, { ...value, startedAt: clock.now() }), [index]);
  }

  static get(book: RecordBook, id: string): ExecutionRecord {
    const record = book.get(id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return record;
  }

  static complete(book: RecordBook, index: InvocationRecordIndex, id: string, output: unknown, resultOf?: number): void {
    const record = this.prepareFinish(book, index, id);
    record.complete(output, resultOf);
  }

  static fail(book: RecordBook, index: InvocationRecordIndex, id: string, error: RuntimeErrorValue): void {
    const record = this.prepareFinish(book, index, id);
    record.fail(error);
  }

  private static prepareFinish(book: RecordBook, index: InvocationRecordIndex, id: string): ExecutionRecord {
    const record = this.get(book, id);
    if (record.status !== 'running') throw new Error('Record has already ended');
    if (OperationRecordHelper.findByExecution(book, index, id).some((op) => op.status === 'running')) throw new Error('Cannot end a record with active operations');
    return record;
  }

  static snapshot(book: RecordBook, index: InvocationRecordIndex, id: string): RuntimeSnapshot {
    const operations = OperationRecordHelper.findByExecution(book, index, id);
    return {
      execution: this.get(book, id).toJSON(),
      operations: operations.map((record) => record.toJSON()),
      attempts: operations.flatMap((operation) => AttemptRecordHelper.findByOperation(book, index, operation.id).map((record) => record.toJSON())),
      events: EventRecordHelper.findByExecution(book, index, id).map((event) => event.toJSON()),
    };
  }
}
