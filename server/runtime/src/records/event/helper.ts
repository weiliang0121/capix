import type { RuntimeRecorder } from '../recorder.js';
import { isFinite } from 'es-toolkit/compat';
import type { EventValue } from '@capix-observer/protocol';
import type { Clock } from '../../runtime/clock.js';
import type { RecordBook } from '../container/book.js';
import type { InvocationRecordIndex } from '../invocation/index.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { EventRecord } from './record.js';

/** Call-boundary recording; Book and the execution index remain generic containers. */
export class EventRecordHelper {
  static create(recorder: RuntimeRecorder, index: InvocationRecordIndex, clock: Clock, start: number, executionId: string, callId: string, type: EventValue['type']): EventRecord {
    const book = recorder.book;
    this.requireExecution(book, executionId);
    const call = this.requireCall(book, executionId, callId);
    const expectedStatus = type === 'call' ? 'running' : type === 'return' ? 'succeeded' : 'failed';
    if (call.status !== expectedStatus) throw new Error('Event does not match the invocation record state');
    const previous = this.last(book, index, executionId);
    const offsetMs = clock.tick() - start;
    if (!isFinite(offsetMs) || offsetMs < (previous?.offsetMs ?? 0)) throw new Error('Invalid event time');
    const record = new EventRecord({ executionId, callId, sequence: (previous?.sequence ?? 0) + 1, occurredAt: clock.now(), offsetMs }, { type });
    return recorder.add(record, [index]);
  }

  static get(book: RecordBook, id: string): EventRecord {
    const record = book.get(id);
    if (!(record instanceof EventRecord)) throw new Error('Event record does not exist');
    return record;
  }

  static findByExecution(book: RecordBook, index: InvocationRecordIndex, executionId: string): readonly EventRecord[] {
    this.requireExecution(book, executionId);
    return index.eventsOf(executionId);
  }

  static last(book: RecordBook, index: InvocationRecordIndex, executionId: string): EventRecord | undefined {
    this.requireExecution(book, executionId);
    return index.lastEventOf(executionId);
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
