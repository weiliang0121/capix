import type { RuntimeSnapshot, EventValue } from '../../shared/records.js';
import type { RuntimeContext } from '../context/context.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';
import { Clock } from '../runtime/clock.js';
import { EventRecord } from './event/record.js';
import { EventRecordHelper } from './event/helper.js';
import { RuntimeErrorHelper } from '../errors/helper.js';
import { RecordBook } from './container/book.js';
import { RecordIndex } from './container/index.js';
import { ExecutionRecord } from './execution/record.js';
import { ExecutionRecordHelper } from './execution/helper.js';
import { OperationRecord } from './operation/record.js';
import { OperationRecordHelper } from './operation/helper.js';
import { AttemptRecord } from './attempt/record.js';
import { AttemptRecordHelper } from './attempt/helper.js';

type InvocationRecord = ExecutionRecord | OperationRecord | AttemptRecord;

/** Maps live invocation facts to records. Does not execute work or change any Context. */
export class RuntimeRecorder {
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  readonly #contexts = new RecordIndex<InvocationRecord>((record) => record.contextId);
  readonly #starts = new Map<string, number>();

  constructor(
    readonly book: RecordBook,
    readonly operationIndex: RecordIndex<OperationRecord>,
    readonly attemptIndex: RecordIndex<AttemptRecord>,
    readonly eventIndex: RecordIndex<EventRecord>,
    private readonly clock = new Clock(),
    private readonly changed: (snapshot: RuntimeSnapshot) => void = () => {},
  ) {}

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  beginExecution(context: ExecutionContext): void {
    this.requireUnrecorded(context);
    const record = ExecutionRecordHelper.create(this.book, this.clock, context.id, {
      input: context.input,
      settings: context.settings,
      ...(context.transcript ? { transcript: context.transcript } : {}),
    });
    this.#contexts.add(record);
    this.#starts.set(record.id, this.clock.tick());
    this.event(record.id, record.id, 'call');
  }

  beginOperation(context: OperationContext): void {
    this.requireUnrecorded(context);
    const execution = this.record(context.executionId);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
    const parent = context.parentOperationId === undefined ? undefined : this.record(context.parentOperationId);
    if (parent && !(parent instanceof OperationRecord)) throw new Error('Parent operation record does not exist');
    const record = OperationRecordHelper.create(
      this.book,
      this.operationIndex,
      {
        ...context.declaration,
        contextId: context.id,
        executionId: execution.id,
        ...(parent ? { parentOperationId: parent.id } : {}),
      },
      context.input,
    );
    this.#contexts.add(record);
    this.event(execution.id, record.id, 'call');
  }

  beginAttempt(context: AttemptContext): void {
    this.requireUnrecorded(context);
    const operation = this.record(context.operationId);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation record does not exist');
    const record = AttemptRecordHelper.create(this.book, this.attemptIndex, { ...context.declaration, contextId: context.id, operationId: operation.id }, context.input);
    this.#contexts.add(record);
    this.event(operation.executionId, record.id, 'call');
  }

  finish(context: RuntimeContext): void {
    const state = context.state;
    if (state.status === 'running') throw new Error('Context has no terminal outcome to record');
    const record = this.record(context.id);
    if (state.status === 'succeeded') this.writeOutput(record, state.output);
    else this.writeError(record, state.error);
    this.event(this.executionId(record), record.id, state.status === 'succeeded' ? 'return' : 'throw');
  }

  record(contextId: string): InvocationRecord {
    const ids = this.#contexts.get(contextId);
    const record = ids.length === 1 ? this.book.get(ids[0]!) : undefined;
    if (!(record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord)) throw new Error('Context record does not exist');
    return record;
  }

  /** Checks recording completion only; callers must inspect the Context for the work outcome. */
  hasOutcome(context: ExecutionContext): boolean {
    const record = this.record(context.id);
    const last = EventRecordHelper.last(this.book, this.eventIndex, record.id);
    return record.status !== 'running' && last?.callId === record.id && last.value.type === (record.status === 'succeeded' ? 'return' : 'throw');
  }

  snapshot(context: ExecutionContext): RuntimeSnapshot {
    const record = this.record(context.id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
    return this.snapshotRecord(record.id);
  }

  private requireUnrecorded(context: RuntimeContext): void {
    if (this.#contexts.get(context.id).length) throw new Error('Context is already recorded');
  }

  private writeOutput(record: InvocationRecord, output: unknown): void {
    if (record instanceof ExecutionRecord) ExecutionRecordHelper.complete(this.book, this.operationIndex, record.id, output);
    else if (record instanceof OperationRecord) OperationRecordHelper.complete(this.book, this.operationIndex, this.attemptIndex, record.id, output);
    else AttemptRecordHelper.complete(this.book, record.id, output);
  }

  private writeError(record: InvocationRecord, error: unknown): void {
    const value = RuntimeErrorHelper.format(error);
    if (record instanceof ExecutionRecord) ExecutionRecordHelper.fail(this.book, this.operationIndex, record.id, value);
    else if (record instanceof OperationRecord) OperationRecordHelper.fail(this.book, this.operationIndex, this.attemptIndex, record.id, value);
    else AttemptRecordHelper.fail(this.book, record.id, value);
  }

  private executionId(record: InvocationRecord): string {
    if (record instanceof ExecutionRecord) return record.id;
    if (record instanceof OperationRecord) return record.executionId;
    return OperationRecordHelper.get(this.book, record.operationId).executionId;
  }

  private snapshotRecord(id: string): RuntimeSnapshot {
    return ExecutionRecordHelper.snapshot(this.book, this.operationIndex, this.attemptIndex, id, this.eventIndex);
  }

  private event(executionId: string, callId: string, type: EventValue['type']): void {
    const start = this.#starts.get(executionId);
    if (start === undefined) throw new Error('Execution recording clock does not exist');
    EventRecordHelper.create(this.book, this.eventIndex, this.clock, start, executionId, callId, type);
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = this.snapshotRecord(executionId);
    } catch {
      console.error('运行记录发布失败；已有记录仍保存在当前 RecordBook。');
      return;
    }
    for (const listener of [this.changed, ...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        console.error('运行记录发布失败；已有记录仍保存在当前 RecordBook。');
      }
    }
  }
}
