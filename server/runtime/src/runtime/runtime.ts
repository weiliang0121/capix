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
  #running = false;

  constructor(options: { recorder?: RuntimeRecorder; messages?: readonly Message[] } = {}) {
    this.recorder = options.recorder;
    if (options.recorder) {
      this.invocationRecordIndex = new InvocationRecordIndex(options.recorder.book);
      this.recording = new InvocationRecordHelper(options.recorder, this.invocationRecordIndex);
    }
    this.transcript = new Transcript(options.messages, options.recorder);
    this.memories = new Memories(this.transcript, options.recorder);
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
