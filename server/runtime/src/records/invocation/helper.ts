import type { RuntimeRecord } from '../runtime/record.js';
import { isUndefined } from 'es-toolkit/predicate';
import type { InvocationBoundaryValue } from '@capix-observer/protocol';
import type { InvocationContext } from '../../context/context.js';
import type { InvocationProcess } from '../../invocation/cycle.js';
import type { InvocationRecording } from '../../invocation/recording.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { InvocationBoundaryRecordHelper } from '../invocation-boundary/helper.js';
import type { ChangeSource } from '../source.js';
import type { CallRecord } from './record.js';
import type { Recorder } from '../recorder.js';

/** Common call-record rules. It neither runs work nor publishes execution snapshots. */
export class InvocationRecordHelper {
  readonly #starts = new Map<string, number>();

  constructor(
    readonly recorder: Recorder,
    readonly root: RuntimeRecord,
  ) {}

  recording<C extends InvocationContext>(create: (context: C) => CallRecord, finish: (context: C, record: CallRecord, resultOf?: number) => void): InvocationRecording<C> {
    return {
      begin: (context, bind) => {
        const record = create(context);
        bind(record);
        if (record instanceof ExecutionRecord) this.#starts.set(record.id, this.recorder.clock.tick());
        this.boundary(record, 'call');
      },
      process: (context, record, process, sequence) => this.process(context, record, process, sequence),
      source: (record) => this.source(record),
      finish: (context, record) => {
        if (context.status === 'running') throw new Error('Context has no terminal outcome to record');
        const last = record.value.processes.at(-1);
        const resultOf = last?.stage === 'receive' && last.type === 'return' ? ('resultOf' in last ? last.resultOf : last.sequence) : undefined;
        finish(context, record, resultOf);
        this.boundary(record, context.status === 'succeeded' ? 'return' : 'throw');
        if (record instanceof ExecutionRecord) this.#starts.delete(record.id);
      },
    };
  }

  static finish(recorder: Recorder, record: CallRecord, apply: (record: CallRecord) => void): void {
    recorder.update(record, apply, (record) => ({ kind: 'finished', id: record.id, status: record.status as 'succeeded' | 'failed', result: { ...(Object.hasOwn(record.value, 'output') ? { output: record.value.output } : {}), ...(Object.hasOwn(record.value, 'resultOf') ? { resultOf: record.value.resultOf } : {}), ...(record.value.error ? { error: record.value.error } : {}) } }));
  }

  source(record: CallRecord): ChangeSource {
    return { contextId: record.contextId, callId: record.id, executionId: this.executionId(record), ...(record instanceof AttemptRecord ? { operationId: record.operationId } : record instanceof OperationRecord ? { operationId: record.id } : {}) };
  }

  executionId(record: CallRecord): string {
    if (record instanceof ExecutionRecord) return record.id;
    if (record instanceof OperationRecord) return record.executionId;
    const operation = this.recorder.book.get(record.operationId);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation record does not exist');
    return operation.executionId;
  }

  private process(context: InvocationContext, record: CallRecord, process: InvocationProcess, sequence: number): void {
    const start = this.start(this.executionId(record));
    let body;
    if ('reuse' in process) {
      const source = record.value.processes.at(-1);
      if (!source || source.stage !== 'execute' || source.type !== 'return' || source.round !== context.progress.round) throw new Error('Default receive must follow its execution result');
      body = { stage: 'receive' as const, type: 'return' as const, resultOf: source.sequence };
    } else body = 'error' in process ? { ...process, error: RuntimeErrorHelper.format(process.error) } : process;
    this.recorder.update(
      record,
      (record) => record.append({ ...body, sequence, round: context.progress.round, occurredAt: this.recorder.clock.now(), offsetMs: this.recorder.clock.tick() - start }),
      (record) => ({ kind: 'process-appended', id: record.id, process: record.value.processes.at(-1)! }),
    );
  }

  private boundary(record: CallRecord, type: InvocationBoundaryValue['type']): void {
    const executionId = this.executionId(record);
    InvocationBoundaryRecordHelper.create(this.recorder, { start: this.start(executionId), executionId: executionId, callId: record.id }, type);
  }

  private start(executionId: string): number {
    const start = this.#starts.get(executionId);
    if (isUndefined(start)) throw new Error('Execution recording clock does not exist');
    return start;
  }
}
