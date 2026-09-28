import { isUndefined } from 'es-toolkit/predicate';
import type { EventValue } from '@capix-observer/protocol';
import type { InvocationContext } from '../../context/context.js';
import type { InvocationProcess } from '../../invocation/cycle.js';
import type { InvocationRecording } from '../../invocation/recording.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import { ExecutionRecord } from '../execution/record.js';
import { OperationRecord } from '../operation/record.js';
import { AttemptRecord } from '../attempt/record.js';
import { EventRecordHelper } from '../event/helper.js';
import type { ChangeSource } from '../source.js';
import type { InvocationRecordIndex, CallRecord } from './index.js';
import type { RuntimeRecorder } from '../recorder.js';

/** Common call-record rules. It neither runs work nor publishes execution snapshots. */
export class InvocationRecordHelper {
  readonly #starts = new Map<string, number>();

  constructor(
    readonly recorder: RuntimeRecorder,
    readonly index: InvocationRecordIndex,
  ) {}

  recording<C extends InvocationContext>(create: (context: C) => CallRecord, finish: (context: C, record: CallRecord, resultOf?: number) => void): InvocationRecording<C> {
    return {
      begin: (context) => {
        const record = create(context);
        if (record instanceof ExecutionRecord) this.#starts.set(record.id, this.recorder.clock.tick());
        this.event(record, 'call');
      },
      process: (context, process) => this.process(context, process),
      finish: (context) => {
        if (context.status === 'running') throw new Error('Context has no terminal outcome to record');
        const record = this.get(context.id);
        const last = record.value.processes.at(-1);
        const resultOf = last?.stage === 'receive' && last.type === 'return' ? ('resultOf' in last ? last.resultOf : last.sequence) : undefined;
        this.recorder.update(record, (record) => finish(context, record, resultOf));
        this.event(record, context.status === 'succeeded' ? 'return' : 'throw');
        if (record instanceof ExecutionRecord) this.#starts.delete(record.id);
      },
    };
  }

  get(contextId: string): CallRecord {
    const record = this.index.findByContext(contextId);
    if (!(record instanceof ExecutionRecord || record instanceof OperationRecord || record instanceof AttemptRecord)) throw new Error('Context record does not exist');
    return record;
  }

  source(context: InvocationContext): ChangeSource {
    const record = this.get(context.id);
    return { contextId: context.id, callId: record.id, executionId: this.executionId(record), ...(record instanceof AttemptRecord ? { operationId: record.operationId } : record instanceof OperationRecord ? { operationId: record.id } : {}) };
  }

  executionId(record: CallRecord): string {
    if (record instanceof ExecutionRecord) return record.id;
    if (record instanceof OperationRecord) return record.executionId;
    const operation = this.recorder.book.get(record.operationId);
    if (!(operation instanceof OperationRecord)) throw new Error('Operation record does not exist');
    return operation.executionId;
  }

  private process(context: InvocationContext, process: InvocationProcess): void {
    const record = this.get(context.id);
    const start = this.start(this.executionId(record));
    let body;
    if ('reuse' in process) {
      const source = record.value.processes.at(-1);
      if (!source || source.stage !== 'execute' || source.type !== 'return' || source.round !== context.progress.round) throw new Error('Default receive must follow its execution result');
      body = { stage: 'receive' as const, type: 'return' as const, resultOf: source.sequence };
    } else body = 'error' in process ? { ...process, error: RuntimeErrorHelper.format(process.error) } : process;
    this.recorder.update(record, (record) => record.append({ ...body, sequence: record.value.processes.length + 1, round: context.progress.round, occurredAt: this.recorder.clock.now(), offsetMs: this.recorder.clock.tick() - start }));
  }

  private event(record: CallRecord, type: EventValue['type']): void {
    const executionId = this.executionId(record);
    EventRecordHelper.create(this.recorder, this.index, this.recorder.clock, this.start(executionId), executionId, record.id, type);
  }

  private start(executionId: string): number {
    const start = this.#starts.get(executionId);
    if (isUndefined(start)) throw new Error('Execution recording clock does not exist');
    return start;
  }
}
