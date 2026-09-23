import type { EventValue } from '../../../shared/records.js';
import type { Clock } from '../../runtime/clock.js';
import type { RecordBook } from '../container/book.js';
import type { RecordIndex } from '../container/index.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { EventRecord } from './record.js';

/** Call-boundary recording; Book and the execution index remain generic containers. */
export class EventRecordHelper {
  static create(book: RecordBook, index: RecordIndex<EventRecord>, clock: Clock, start: number, executionId: string, callId: string, type: EventValue['type']): EventRecord {
    this.requireExecution(book, executionId);
    const call = this.requireCall(book, executionId, callId);
    const expectedStatus = type === 'call' ? 'running' : type === 'return' ? 'succeeded' : 'failed';
    if (call.status !== expectedStatus) throw new Error('Event does not match the invocation record state');
    const previous = this.last(book, index, executionId);
    const offsetMs = clock.tick() - start;
    if (!Number.isFinite(offsetMs) || offsetMs < (previous?.offsetMs ?? 0)) throw new Error('Invalid event time');
    const record = new EventRecord({ executionId, callId, sequence: (previous?.sequence ?? 0) + 1, occurredAt: clock.now(), offsetMs }, { type });
    index.add(record);
    try {
      return book.add(record);
    } catch (error) {
      index.remove(record.id);
      throw error;
    }
  }

  static get(book: RecordBook, id: string): EventRecord {
    const record = book.get(id);
    if (!(record instanceof EventRecord)) throw new Error('Event record does not exist');
    return record;
  }

  static findByExecution(book: RecordBook, index: RecordIndex<EventRecord>, executionId: string): readonly EventRecord[] {
    this.requireExecution(book, executionId);
    return index.get(executionId).map((id) => this.indexed(book, id, executionId));
  }

  static last(book: RecordBook, index: RecordIndex<EventRecord>, executionId: string): EventRecord | undefined {
    this.requireExecution(book, executionId);
    const id = index.get(executionId).at(-1);
    return id === undefined ? undefined : this.indexed(book, id, executionId);
  }

  private static indexed(book: RecordBook, id: string, executionId: string): EventRecord {
    const record = this.get(book, id);
    if (record.executionId !== executionId) throw new Error('Event index contains another execution');
    return record;
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
