import type { Invocation } from '../invocation/invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { AttemptBinding } from '../binding/contract.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** Reusable bound A leaf; every call creates its own AttemptContext and Invocation. */
export class BoundAttempt<Input, Output, Resources extends object = object> {
  constructor(
    private readonly invocationBuilder: AttemptInvocationBuilder,
    private readonly binding: AttemptBinding<Input, Output, Resources>,
  ) {}

  get definition() {
    return this.binding.definition;
  }

  create(parent: Invocation<unknown, unknown, OperationContext>, input: Input, options: InvocationRelationOptions = {}) {
    return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.binding.requires, initial: this.definition.run.requires, refinements: this.binding.refinements, observation: this.definition.observation, description: this.definition, work: this.binding.work, key: options.key, output: options.output });
  }
  resume(parent: Invocation<unknown, unknown, OperationContext>, contextId: string, options: InvocationRelationOptions = {}) {
    return this.invocationBuilder.restoration(contextId, this.binding.work, parent.context.id, (restore) => {
      const checkpoint = this.definition.checkpoint!;
      const point = checkpoint.points[restore.head.image.point];
      if (!point) throw new Error('Checkpoint point is not declared');
      const input = checkpoint.input.decode(restore.head.image.frame.input);
      const description = this.definition;
      return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.binding.requires, initial: point.resume.requires, refinements: this.binding.refinements, observation: this.definition.observation, description, work: this.binding.work, key: options.key, output: options.output, restore });
    });
  }

  call(parent: Invocation<unknown, unknown, OperationContext>, input: Input): Promise<Output> {
    return this.create(parent, input).run();
  }
}
