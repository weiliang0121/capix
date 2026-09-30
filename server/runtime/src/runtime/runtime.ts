import { ExecutionContextBuilder } from '../context/execution/builder.js';
import { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import { OperationContextBuilder } from '../context/operation/builder.js';
import { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import { AttemptContextBuilder } from '../context/attempt/builder.js';
import { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import { InvocationRecordHelper } from '../records/invocation/helper.js';
import type { RuntimeContext } from '../context/runtime.js';
import { RuntimeRecord } from '../records/runtime/record.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';
import type { Recorder } from '../records/recorder.js';
import { RuntimeError } from '../errors/error.js';

/** Organizes work over an established data scope. Construction does not establish its record. */
export class Runtime {
  readonly record?: RuntimeRecord;
  readonly recorder?: Recorder;
  readonly recording?: InvocationRecordHelper;
  readonly executionInvocations: ExecutionInvocationBuilder;
  readonly operationInvocations: OperationInvocationBuilder;
  readonly attemptInvocations: AttemptInvocationBuilder;
  #running = false;

  constructor(
    readonly context: RuntimeContext,
    recording?: { recorder: Recorder; record: RuntimeRecord },
  ) {
    if (recording) {
      if (!(recording.record instanceof RuntimeRecord) || recording.recorder.book.get(recording.record.id) !== recording.record) throw new Error('Runtime record is not registered with this Recorder');
      this.recorder = recording.recorder;
      this.record = recording.record;
      this.recording = new InvocationRecordHelper(recording.recorder, recording.record);
    }
    const executions = new ExecutionContextBuilder(context.transcript);
    const operations = new OperationContextBuilder(executions);
    const attempts = new AttemptContextBuilder(operations);
    this.executionInvocations = new ExecutionInvocationBuilder(executions, { run: (work) => this.run(work), recording: this.recording });
    this.operationInvocations = new OperationInvocationBuilder(operations, this.recording);
    this.attemptInvocations = new AttemptInvocationBuilder(attempts, this.recording);
  }

  get running(): boolean {
    return this.#running;
  }

  /** Reserve the scope before accepting input. No queue and no nested top-level execution. */
  async run<O>(work: () => O | Promise<O>): Promise<O> {
    if (this.#running) throw new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
    this.#running = true;
    try {
      return await work();
    } finally {
      this.#running = false;
    }
  }

  getExecutionContext(context: ExecutionContext | OperationContext | AttemptContext): ExecutionContext {
    if ('operationContext' in context) return context.operationContext.executionContext;
    if ('executionContext' in context) return context.executionContext;
    return context;
  }

  getOperationContext(context: AttemptContext): OperationContext {
    return context.operationContext;
  }
}
