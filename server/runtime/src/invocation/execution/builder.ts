import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext, ExecutionOptions } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/execution/builder.js';
import { ExecutionRecordHelper } from '../../records/execution/helper.js';
import type { InvocationRecordHelper } from '../../records/invocation/helper.js';

export interface ExecutionInvocationCapabilities {
  run<O>(work: () => O | Promise<O>): Promise<O>;
  recording?: InvocationRecordHelper;
}

/** Owns entry into the top-level reservation, not the Observer's input or segmentation policy. */
export class ExecutionInvocationBuilder {
  constructor(
    private readonly contexts: ExecutionContextBuilder,
    private readonly capabilities: ExecutionInvocationCapabilities,
  ) {}

  create<I, O>(input: I, options: ExecutionOptions, work: InvocationWork<ExecutionContext<I, O>, I, O>, started?: (context: ExecutionContext<I, O>) => void): Invocation<I, O, ExecutionContext<I, O>> {
    const context = this.contexts.create<I, O>(input, options);
    const recording = this.capabilities.recording ? ExecutionRecordHelper.recording(this.capabilities.recording) : undefined;
    return new Invocation({ context, work, signal: context.signal, recording, started });
  }

  submit<I, O>(accept: () => I, options: ExecutionOptions, work: InvocationWork<ExecutionContext<I, O>, I, O>, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return this.capabilities.run(() => {
      this.contexts.check(options);
      const input = accept();
      return this.create(input, options, work, started).run();
    });
  }
}
