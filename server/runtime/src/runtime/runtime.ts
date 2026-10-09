import { BindingEnvironment } from '../binding/environment.js';
import type { InvocationEvent } from '@capix-observer/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { ExecutionContextBuilder } from '../context/execution/builder.js';
import { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import { OperationContextBuilder } from '../context/operation/builder.js';
import { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import { AttemptContextBuilder } from '../context/attempt/builder.js';
import { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import { InvocationRecordHelper } from '../records/invocation/helper.js';
import type { RuntimeContext } from '../context/runtime.js';
import { RuntimeRecord } from '../records/runtime/record.js';
import type { Recorder } from '../records/recorder.js';
import type { ExecutionOptions } from '../context/execution.js';
import type { ExecutionCallbacks } from '../execution/execution.js';

export interface RuntimeOptions {
  recording?: { recorder: Recorder; record: RuntimeRecord };
  changes?: ChangeCapture<InvocationEvent>;
}

/** Organizes work over an established data scope. Construction does not establish its record. */
export class Runtime<I = unknown, O = unknown, P extends ExecutionOptions = ExecutionOptions> {
  readonly record?: RuntimeRecord;
  readonly recorder?: Recorder;
  readonly recording?: InvocationRecordHelper;
  readonly executionInvocations: ExecutionInvocationBuilder;
  readonly operationInvocations: OperationInvocationBuilder;
  readonly attemptInvocations: AttemptInvocationBuilder;
  private readonly entry?: RuntimeEntry<I, O, P>;
  readonly environment: BindingEnvironment;

  constructor(
    readonly context: RuntimeContext,
    options: RuntimeOptions = {},
    assemble?: (runtime: Runtime<I, O, P>) => RuntimeEntry<I, O, P>,
  ) {
    const { recording, changes } = options;
    if (recording) {
      if (!(recording.record instanceof RuntimeRecord) || recording.recorder.book.get(recording.record.id) !== recording.record) throw new Error('Runtime record is not registered with this Recorder');
      this.recorder = recording.recorder;
      this.record = recording.record;
      this.recording = new InvocationRecordHelper(recording.recorder, recording.record);
    }
    const executions = new ExecutionContextBuilder();
    const operations = new OperationContextBuilder(executions);
    const attempts = new AttemptContextBuilder(operations);
    this.executionInvocations = new ExecutionInvocationBuilder(executions, { run: (work) => this.reserve(work), recording: this.recording, changes });
    this.operationInvocations = new OperationInvocationBuilder(operations, { recording: this.recording, changes });
    this.attemptInvocations = new AttemptInvocationBuilder(attempts, { recording: this.recording, changes });
    this.environment = new BindingEnvironment(this.operationInvocations, this.attemptInvocations);
    this.entry = assemble?.(this);
  }

  get running(): boolean {
    return this.context.running;
  }

  /** Internal reservation; binding selects the sole business entry at assembly. */
  reserve<T>(work: () => T | Promise<T>): Promise<T> {
    return this.context.reserve(work);
  }

  run(input: I, options: P, callbacks?: ExecutionCallbacks<any, O, any>): Promise<O> {
    if (!this.entry) return Promise.reject(new Error('Runtime has no assembled execution'));
    return this.reserve(() => this.entry!.run(input, options, callbacks));
  }
}

export interface RuntimeEntry<I, O, P extends ExecutionOptions> {
  run(input: I, options: P, callbacks?: ExecutionCallbacks<any, O, any>): Promise<O>;
}
