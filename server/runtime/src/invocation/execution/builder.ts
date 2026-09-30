import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext, ExecutionOptions } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/execution/builder.js';
import { ExecutionRecordHelper } from '../../records/execution/helper.js';

export type ExecutionStarted<I, O> = InvocationStarted<I, O, ExecutionContext<I, O>>;

export interface ExecutionInvocationCapabilities extends InvocationCapabilities {
  run<O>(work: () => O | Promise<O>): Promise<O>;
}

export interface ExecutionInvocationRequest<I, O> {
  context: ExecutionOptions;
  work: InvocationWork<ExecutionContext<I, O>, I, O>;
  started?: ExecutionStarted<I, O>;
}

/** Owns entry into the top-level reservation, not the Observer's input or segmentation policy. */
export class ExecutionInvocationBuilder {
  constructor(
    private readonly contexts: ExecutionContextBuilder,
    private readonly capabilities: ExecutionInvocationCapabilities,
  ) {}

  create<I, O>(input: I, request: ExecutionInvocationRequest<I, O>): Invocation<I, O, ExecutionContext<I, O>> {
    const context = this.contexts.create<I, O>(input, request.context);
    const recording = this.capabilities.recording ? ExecutionRecordHelper.recording<I, O>(this.capabilities.recording) : undefined;
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'execution' }, this.capabilities.changes) : undefined;
    return new Invocation({ context, work: request.work, signal: context.signal, recording, started: request.started, changes });
  }

  submit<I, O>(accept: () => I, request: ExecutionInvocationRequest<I, O>): Promise<O> {
    return this.capabilities.run(() => {
      this.contexts.check(request.context);
      const input = accept();
      return this.create(input, request).run();
    });
  }
}
