import type { Invocation } from '../../invocation/invocation.js';
import type { ExecutionContext } from '../../context/execution.js';
import { InvocationRecordHelper } from '../invocation/helper.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import type { Recorder } from '../recorder.js';
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
  static recording<I, O>(recording: InvocationRecordHelper) {
    return recording.recording<ExecutionContext<I, O>>(
      (context) => this.create(recording.recorder, recording.index, recording.recorder.clock, context.id, { input: context.input, settings: context.settings, ...(context.transcriptRange ? { transcriptRange: context.transcriptRange } : {}) }, recording.root.id),
      (context, record, resultOf) => {
        const state = context.state;
        if (state.status === 'succeeded') this.complete(recording.recorder, record.id, state.output, resultOf);
        else if (state.status === 'failed') this.fail(recording.recorder, record.id, RuntimeErrorHelper.format(state.error));
      },
    );
  }

  static observe(recording: InvocationRecordHelper, invocation: Invocation<unknown, unknown, ExecutionContext>): RuntimeSnapshot {
    const record = invocation.record;
    if (!(record instanceof ExecutionRecord) || recording.recorder.book.get(record.id) !== record || recording.recorder.tree.root(record.id) !== recording.root) throw new Error('Execution record does not exist');
    return this.snapshot(recording.recorder, record.id);
  }

  static create(recorder: Recorder, index: InvocationRecordIndex, clock: Clock, contextId: string, value: Omit<ExecutionValue, 'startedAt' | 'output' | 'error' | 'processes' | 'resultOf'>, parentId: string): ExecutionRecord {
    return recorder.add(new ExecutionRecord(contextId, { ...value, startedAt: clock.now() }, parentId), [index]);
  }

  static get(book: RecordBook, id: string): ExecutionRecord {
    const record = book.get(id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution does not exist');
    return record;
  }

  static complete(recorder: Recorder, id: string, output: unknown, resultOf?: number): void {
    const record = this.prepareFinish(recorder, id);
    record.complete(output, resultOf);
  }

  static fail(recorder: Recorder, id: string, error: RuntimeErrorValue): void {
    const record = this.prepareFinish(recorder, id);
    record.fail(error);
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
      events: EventRecordHelper.findByExecution(recorder, id).map((event) => event.toJSON()),
    };
  }
}
