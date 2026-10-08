import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext, ExecutionOptions, ExecutionResourceSource } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/execution/builder.js';
import { ExecutionRecordHelper } from '../../records/execution/helper.js';

export type ExecutionStarted<I, O, R extends object = object> = InvocationStarted<I, O, ExecutionContext<I, O, R>>;

export interface ExecutionInvocationCapabilities extends InvocationCapabilities {
  run<O>(work: () => O | Promise<O>): Promise<O>;
}

export interface ExecutionInvocationRequest<I, O, R extends object = object> {
  context: ExecutionOptions;
  requires?: ResourceRequirements<R>;
  resourceBinding?: (source: ExecutionResourceSource) => ResourceBindings<R>;
  work: InvocationWork<ExecutionContext<I, O, R>, I, O>;
  started?: ExecutionStarted<I, O, R>;
}

/** Owns entry into the top-level reservation, not the Observer's input or segmentation policy. */
export class ExecutionInvocationBuilder {
  constructor(
    private readonly contexts: ExecutionContextBuilder,
    private readonly capabilities: ExecutionInvocationCapabilities,
  ) {}

  create<I, O, R extends object = object>(input: I, request: ExecutionInvocationRequest<I, O, R>): Invocation<I, O, ExecutionContext<I, O, R>> {
    const binding = request.resourceBinding;
    const context = this.contexts.create<I, O, R>(input, request.context, (source) => (binding ? binding(source) : new ResourceBindings({})).select(request.requires ?? ({} as ResourceRequirements<R>)));
    const recording = this.capabilities.recording ? ExecutionRecordHelper.recording<I, O>(this.capabilities.recording) : undefined;
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'execution' }, this.capabilities.changes) : undefined;
    return new Invocation<I, O, ExecutionContext<I, O, R>>({ context, work: request.work, signal: context.signal, recording, started: request.started, changes });
  }

  submit<I, O, R extends object = object>(accept: () => I, request: ExecutionInvocationRequest<I, O, R>): Promise<O> {
    return this.capabilities.run(() => {
      this.contexts.check(request.context);
      const input = accept();
      return this.create(input, request).run();
    });
  }
}
