import { combineOutputReceivers } from '../output/delivery.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionInvocationBuilder, ExecutionInvocationStarted } from '../invocation/builders/execution.js';
import type { ExecutionBinding } from '../binding/contract.js';
import type { ResourceBindings } from '../resource/bindings.js';
import type { Invocation } from '../invocation/invocation.js';
import type { RuntimeContext } from '../context/runtime.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from '../invocation/progress.js';

export interface ExecutionInvocationCallbacks<Input, Output, Resources extends object> {
  started?: ExecutionInvocationStarted<Input, Output, Resources>;
}
export interface ExecutionInvocationBindings<Input, Output, Resources extends object> {
  capture(input: Input): ResourceBindings<Resources>;
  readonly callbacks?: ExecutionInvocationCallbacks<Input, Output, Resources>;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
}

/** Reusable E structure; every call captures resources and creates its own ExecutionContext and Invocation. */
export class BoundExecution<Input, Output, Resources extends object = object> {
  readonly id = randomUUID();
  constructor(
    private readonly invocationBuilder: ExecutionInvocationBuilder,
    private readonly binding: ExecutionBinding<Input, Output, Resources>,
  ) {}

  get definition() {
    return this.binding.definition;
  }

  get children() {
    return this.binding.children;
  }

  create(parent: Invocation<unknown, unknown, RuntimeContext>, input: Input, options: InvocationRelationOptions = {}) {
    parent.requireActive();
    this.invocationBuilder.check(parent);
    const bindings: ExecutionInvocationBindings<Input, Output, Resources> = parent.context.executionBinding(this.definition);
    const callbacks = bindings.callbacks ?? {};
    const resources = bindings.capture(input);
    return this.invocationBuilder.create(parent, input, {
      key: options.key,
      declarationPosition: options.declarationPosition,
      description: { id: this.id },
      requires: this.binding.requires,
      initial: this.binding.declaration.run.requires,
      observation: this.binding.declaration.observation,
      establish: () => ({ resources }),
      work: this.binding.work,
      started: callbacks.started,
      progress: bindings.progress,
      output: combineOutputReceivers(options.output, bindings.output),
    });
  }
  /** Resume fixed invocation input without replaying the parent work that produced it. */
  resume(parent: Invocation<unknown, unknown, RuntimeContext>, contextId: string, options: InvocationRelationOptions = {}) {
    parent.requireActive();
    this.invocationBuilder.check(parent);
    return this.invocationBuilder.restoration(contextId, this.binding.work, parent.context.id, (restore) => {
      const checkpoint = this.binding.declaration.checkpoint!;
      const point = checkpoint.points.find((point) => point.name === restore.head.image.point);
      if (!point) throw new Error('Checkpoint point is not declared');
      const input = checkpoint.input.decode(restore.head.image.frame.input);
      const bindings: ExecutionInvocationBindings<Input, Output, Resources> = parent.context.executionBinding(this.definition);
      const resources = bindings.capture(input);
      return this.invocationBuilder.create(parent, input, {
        key: options.key,
        declarationPosition: options.declarationPosition,
        description: { id: this.id },
        requires: this.binding.requires,
        initial: point.resume.requires,
        observation: this.binding.declaration.observation,
        establish: () => ({ resources }),
        work: this.binding.work,
        progress: bindings.progress,
        output: combineOutputReceivers(options.output, bindings.output),
        restore,
      });
    });
  }
}
