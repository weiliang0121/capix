import { sortBy } from 'es-toolkit/array';
import type { Recorder } from '../recorder.js';
import { isFinite } from 'es-toolkit/compat';
import type { InvocationBoundaryValue } from '@capix-observer/protocol';
import type { RecordBook } from '../container/book.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { InvocationBoundaryRecord } from './record.js';

/** Call-boundary recording; Event order is resolved within the execution record tree. */
export class InvocationBoundaryRecordHelper {
  static create(recorder: Recorder, location: { start: number; executionId: string; callId: string }, type: InvocationBoundaryValue['type']): InvocationBoundaryRecord {
    const { start, executionId, callId } = location;
    const clock = recorder.clock;
    const book = recorder.book;
    this.requireExecution(book, executionId);
    const call = this.requireCall(book, executionId, callId);
    const expectedStatus = type === 'call' ? 'running' : type === 'return' ? 'succeeded' : 'failed';
    if (call.status !== expectedStatus) throw new Error('Event does not match the invocation record state');
    const previous = this.last(recorder, executionId);
    const offsetMs = clock.tick() - start;
    if (!isFinite(offsetMs) || offsetMs < (previous?.offsetMs ?? 0)) throw new Error('Invalid event time');
    const record = new InvocationBoundaryRecord({ executionId, callId, sequence: (previous?.sequence ?? 0) + 1, occurredAt: clock.now(), offsetMs }, { type });
    return recorder.add(record);
  }

  static get(book: RecordBook, id: string): InvocationBoundaryRecord {
    const record = book.get(id);
    if (!(record instanceof InvocationBoundaryRecord)) throw new Error('Event record does not exist');
    return record;
  }

  static findByExecution(recorder: Recorder, executionId: string): readonly InvocationBoundaryRecord[] {
    this.requireExecution(recorder.book, executionId);
    return sortBy(
      recorder.tree.descendants(executionId).filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord),
      [(event) => event.sequence],
    );
  }

  static last(recorder: Recorder, executionId: string): InvocationBoundaryRecord | undefined {
    this.requireExecution(recorder.book, executionId);
    let latest: InvocationBoundaryRecord | undefined;
    for (const record of recorder.tree.descendants(executionId)) {
      if (record instanceof InvocationBoundaryRecord && (!latest || record.sequence > latest.sequence)) latest = record;
    }
    return latest;
  }

  private static requireExecution(book: RecordBook, id: string): void {
    if (!(book.get(id) instanceof ExecutionRecord)) throw new Error('Execution does not exist');
  }

  private static requireCall(book: RecordBook, executionId: string, callId: string): ExecutionRecord | OperationRecord | AttemptRecord {
    const record = book.get(callId);
    if (record instanceof ExecutionRecord && record.id === executionId) return record;
    if (record instanceof OperationRecord && record.executionId === executionId) return record;
    if (record instanceof AttemptRecord) {
      const operation = book.get(record.operationId);
      if (operation instanceof OperationRecord && operation.executionId === executionId) return record;
    }
    throw new Error('Event target is not an invocation in this execution');
  }
}
