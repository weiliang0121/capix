import type { InvocationFailureFact } from '@capix-observer/protocol';
import { InvocationRecordHelper } from '../invocation/helper.js';
import type { Recorder } from '../recorder.js';
import { InvocationBoundaryRecordHelper } from '../invocation-boundary/helper.js';
import type { RuntimeErrorValue, ExecutionValue, RuntimeSnapshot } from '@capix-observer/protocol';

import type { RecordBook } from '../container/book.js';
import { OperationRecordHelper } from '../operation/helper.js';
import { AttemptRecordHelper } from '../attempt/helper.js';
import { ExecutionRecord } from './record.js';
import { RuntimeCallRecord } from '../runtime-call/record.js';
import { ResourceRecord } from '../resource/record.js';

/** Execution-specific recording operations. All managed objects are explicit arguments. */
export class ExecutionRecordHelper {
  static create(recorder: Recorder, definition: { contextId: string; parentId: string }, value: Omit<ExecutionValue, 'startedAt' | 'output' | 'error' | 'processes' | 'relationChanges' | 'resultOf'>): ExecutionRecord {
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
    const execution = this.get(recorder.book, id);
    const parent = execution.parentId ? recorder.book.get(execution.parentId) : undefined;
    if (!(parent instanceof RuntimeCallRecord)) throw new Error('Execution requires its recorded Runtime call');
    return {
      runtimeCall: parent.toJSON(),
      runtimeEvents: InvocationBoundaryRecordHelper.findByScope(recorder, parent.id).map((event) => event.toJSON()),
      execution: execution.toJSON(),
      operations: operations.map((record) => record.toJSON()),
      attempts: operations.flatMap((operation) => AttemptRecordHelper.findByOperation(recorder, operation.id).map((record) => record.toJSON())),
      events: InvocationBoundaryRecordHelper.findByExecution(recorder, id).map((event) => event.toJSON()),
      resources: [...recorder.tree.descendants(id), ...recorder.tree.children(parent.id)].filter((record): record is ResourceRecord => record instanceof ResourceRecord).map((record) => record.toJSON()),
    };
  }
}
