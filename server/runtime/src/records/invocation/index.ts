import { RecordIndex } from '../container/index.js';
import type { RecordBook } from '../container/book.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { EventRecord } from '../event/record.js';

import type { CallRecord } from './record.js';

/** Derived call associations. Records belong to Book; lifecycle and timing belong to recording. */
export class InvocationRecordIndex {
  readonly #contexts = new RecordIndex<CallRecord>((record) => record.contextId);
  readonly #operations = new RecordIndex<OperationRecord>((record) => record.executionId);
  readonly #attempts = new RecordIndex<AttemptRecord>((record) => record.operationId);
  readonly #events = new RecordIndex<EventRecord>((record) => record.executionId);

  constructor(private readonly book: RecordBook) {}

  add(record: CallRecord | EventRecord): void {
    if (record instanceof EventRecord) {
      this.#events.add(record);
      return;
    }
    const existing = this.#contexts.get(record.contextId);
    if (existing.some((id) => id !== record.id)) throw new Error('Context is already recorded');
    this.#contexts.add(record);
    if (record instanceof OperationRecord) this.#operations.add(record);
    else if (record instanceof AttemptRecord) this.#attempts.add(record);
  }

  remove(recordId: string): void {
    this.#contexts.remove(recordId);
    this.#operations.remove(recordId);
    this.#attempts.remove(recordId);
    this.#events.remove(recordId);
  }

  findByContext(contextId: string): CallRecord | undefined {
    const id = this.#contexts.get(contextId).at(0);
    if (!id) return undefined;
    const record = this.book.get(id);
    if (!(record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord) || record.contextId !== contextId) throw new Error('Invalid context record index');
    return record;
  }

  operationsOf(executionId: string): readonly OperationRecord[] {
    return this.#operations.get(executionId).map((id) => {
      const record = this.book.get(id);
      if (!(record instanceof OperationRecord) || record.executionId !== executionId) throw new Error('Invalid operation record index');
      return record;
    });
  }

  attemptsOf(operationId: string): readonly AttemptRecord[] {
    return this.#attempts.get(operationId).map((id) => {
      const record = this.book.get(id);
      if (!(record instanceof AttemptRecord) || record.operationId !== operationId) throw new Error('Invalid attempt record index');
      return record;
    });
  }

  eventsOf(executionId: string): readonly EventRecord[] {
    return this.#events.get(executionId).map((id) => this.event(id, executionId));
  }

  lastEventOf(executionId: string): EventRecord | undefined {
    const id = this.#events.get(executionId).at(-1);
    return id ? this.event(id, executionId) : undefined;
  }

  private event(id: string, executionId: string): EventRecord {
    const record = this.book.get(id);
    if (!(record instanceof EventRecord) || record.executionId !== executionId) throw new Error('Invalid event record index');
    return record;
  }
}
