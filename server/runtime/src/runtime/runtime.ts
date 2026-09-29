import { ExecutionContextBuilder } from '../context/execution/builder.js';
import { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import { OperationContextBuilder } from '../context/operation/builder.js';
import { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import { AttemptContextBuilder } from '../context/attempt/builder.js';
import { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import { InvocationRecordIndex } from '../records/invocation/index.js';
import { InvocationRecordHelper } from '../records/invocation/helper.js';
import type { Message } from '@capix-observer/protocol';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';
import type { RuntimeRecorder } from '../records/recorder.js';
import { SelectionUsage } from '../transcript/usage.js';
import { Transcript } from '../transcript/transcript.js';
import { Memories } from '../memory/memories.js';
import { RuntimeError } from '../errors/error.js';

/** A persistent in-memory running scope. Recording is an environment-owned dependency. */
export class Runtime {
  readonly transcript: Transcript;
  readonly memories: Memories;
  readonly selectionUsage = new SelectionUsage();
  readonly recorder?: RuntimeRecorder;
  readonly invocationRecordIndex?: InvocationRecordIndex;
  readonly recording?: InvocationRecordHelper;
  readonly executionInvocations: ExecutionInvocationBuilder;
  readonly operationInvocations: OperationInvocationBuilder;
  readonly attemptInvocations: AttemptInvocationBuilder;
  #running = false;

  constructor(options: { recorder?: RuntimeRecorder; messages?: readonly Message[] } = {}) {
    this.recorder = options.recorder;
    if (options.recorder) {
      this.invocationRecordIndex = new InvocationRecordIndex(options.recorder.book);
      this.recording = new InvocationRecordHelper(options.recorder, this.invocationRecordIndex);
    }
    this.transcript = new Transcript(options.messages, options.recorder);
    this.memories = new Memories(this.transcript, options.recorder);
    const executions = new ExecutionContextBuilder(this.transcript);
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
