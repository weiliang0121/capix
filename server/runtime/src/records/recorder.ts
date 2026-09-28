import type { MemoryRecordValue, TranscriptChange } from '@capix-observer/protocol';
import type { ChangeSource } from './source.js';
import { MemoryRecord } from './memory/record.js';
import { TranscriptRecord } from './transcript/record.js';
import { writeRecord } from './error.js';
import { isUndefined } from 'es-toolkit/predicate';
import type { Operation } from '../operations/operation.js';
import type { Attempt } from '../attempt/attempt.js';
import type { RuntimeSnapshot, EventValue } from '@capix-observer/protocol';
import type { InvocationContext } from '../context/context.js';
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

import type { InvocationProcess } from '../invocation/cycle.js';

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

  memoryChanged(memoryId: string, value: MemoryRecordValue, source?: ChangeSource): void {
    writeRecord(() => {
      const origin = this.origin(source);
      this.book.add(new MemoryRecord(memoryId, origin?.executionId, origin?.operationId, value, source?.contextId, origin?.callId));
    });
  }

  transcriptChanged(transcriptId: string, value: TranscriptChange, source?: ChangeSource): void {
    writeRecord(() => {
      const origin = this.origin(source);
      this.book.add(new TranscriptRecord(transcriptId, this.clock.now(), value, source?.contextId, origin?.callId, origin?.executionId));
    });
  }

  private origin(source?: ChangeSource) {
    if (!source) return undefined;
    const record = this.record(source.contextId);
    return { callId: record.id, executionId: this.executionId(record), operationId: record instanceof AttemptRecord ? record.operationId : record instanceof OperationRecord ? record.id : undefined };
  }

  beginExecution(context: ExecutionContext): void {
    this.requireUnrecorded(context);
    const record = ExecutionRecordHelper.create(this.book, this.clock, context.id, {
      input: context.input,
      settings: context.settings,
      ...(context.transcriptRange ? { transcriptRange: context.transcriptRange } : {}),
    });
    this.#contexts.add(record);
    this.#starts.set(record.id, this.clock.tick());
    this.event(record.id, record.id, 'call');
  }

  beginOperation<I, O>(context: OperationContext<I, O>, operation: Operation<I, O>, parentContext?: OperationContext): void {
    this.requireUnrecorded(context);
    const execution = this.record(context.executionContext.id);
    if (!(execution instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
    const parent = parentContext ? this.record(parentContext.id) : undefined;
    if (parent && !(parent instanceof OperationRecord)) throw new Error('Parent operation record does not exist');
    const record = OperationRecordHelper.create(
      this.book,
      this.operationIndex,
      {
        operationInstanceId: operation.id,
        operation: operation.name,
        label: operation.label,
        source: operation.source,
        caller: parentContext ? 'operation' : 'execution',
        callee: 'operation',
        contextId: context.id,
        executionId: execution.id,
        ...(parent ? { parentOperationId: parent.id } : {}),
      },
      context.input,
    );
    this.#contexts.add(record);
    this.event(execution.id, record.id, 'call');
  }

  beginAttempt<I, O>(context: AttemptContext<I, O>, attempt: Attempt<I, O>): void {
    this.requireUnrecorded(context);
    const operation = this.record(context.operationContext.id);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation record does not exist');
    const record = AttemptRecordHelper.create(this.book, this.attemptIndex, { name: attempt.name, label: attempt.label, source: attempt.source, caller: 'operation', callee: attempt.callee, contextId: context.id, operationId: operation.id }, context.input);
    this.#contexts.add(record);
    this.event(operation.executionId, record.id, 'call');
  }

  process(context: InvocationContext, process: InvocationProcess): void {
    const record = this.record(context.id);
    const executionId = this.executionId(record);
    const start = this.#starts.get(executionId);
    if (isUndefined(start)) throw new Error('Execution recording clock does not exist');
    let body;
    if ('reuse' in process) {
      const source = record.value.processes.at(-1);
      if (!source || source.stage !== 'execute' || source.type !== 'return' || source.round !== context.progress.round) throw new Error('Default receive must follow its execution result');
      body = { stage: 'receive' as const, type: 'return' as const, resultOf: source.sequence };
    } else body = 'error' in process ? { ...process, error: RuntimeErrorHelper.format(process.error) } : process;
    record.append({ ...body, sequence: record.value.processes.length + 1, round: context.progress.round, occurredAt: this.clock.now(), offsetMs: this.clock.tick() - start });
    this.publish(executionId);
  }

  finish(context: InvocationContext): void {
    const state = context.state;
    if (state.status === 'running') throw new Error('Context has no terminal outcome to record');
    const record = this.record(context.id);
    if (state.status === 'succeeded') {
      const last = record.value.processes.at(-1);
      const resultOf = last?.stage === 'receive' && last.type === 'return' ? ('resultOf' in last ? last.resultOf : last.sequence) : undefined;
      this.writeOutput(record, state.output, resultOf);
    } else this.writeError(record, state.error);
    this.event(this.executionId(record), record.id, state.status === 'succeeded' ? 'return' : 'throw');
  }

  record(contextId: string): InvocationRecord {
    const ids = this.#contexts.get(contextId);
    const record = ids.length === 1 ? this.book.get(ids[0]!) : undefined;
    if (!(record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord)) throw new Error('Context record does not exist');
    return record;
  }

  snapshot(context: ExecutionContext): RuntimeSnapshot {
    const record = this.record(context.id);
    if (!(record instanceof ExecutionRecord)) throw new Error('Execution record does not exist');
    return this.snapshotRecord(record.id);
  }

  private requireUnrecorded(context: InvocationContext): void {
    if (this.#contexts.get(context.id).length) throw new Error('Context is already recorded');
  }

  private writeOutput(record: InvocationRecord, output: unknown, resultOf?: number): void {
    if (record instanceof ExecutionRecord) ExecutionRecordHelper.complete(this.book, this.operationIndex, record.id, output, resultOf);
    else if (record instanceof OperationRecord) OperationRecordHelper.complete(this.book, this.operationIndex, this.attemptIndex, record.id, output, resultOf);
    else AttemptRecordHelper.complete(this.book, record.id, output, resultOf);
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
    if (isUndefined(start)) throw new Error('Execution recording clock does not exist');
    EventRecordHelper.create(this.book, this.eventIndex, this.clock, start, executionId, callId, type);
    this.publish(executionId);
  }

  private publish(executionId: string): void {
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
