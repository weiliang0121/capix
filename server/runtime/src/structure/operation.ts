import { randomUUID } from 'node:crypto';
import type { Invocation } from '../invocation/invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { OperationInvocationBuilder } from '../invocation/builders/operation.js';
import type { OperationBinding } from '../binding/contract.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** A reusable bound O node; individual calls remain separate Invocation objects. */
export class BoundOperation<Input, Output, Resources extends object = object> {
  readonly id = randomUUID();
  constructor(
    private readonly invocationBuilder: OperationInvocationBuilder,
    private readonly binding: OperationBinding<Input, Output, Resources>,
  ) {}

  get definition() {
    return this.binding.definition;
  }

  get children() {
    return this.binding.children;
  }

  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: Input, options: InvocationRelationOptions = {}) {
    const { name, label, source } = this.binding.declaration;
    return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.binding.requires, initial: this.binding.declaration.run.requires, refinements: this.binding.refinements, observation: this.binding.declaration.observation, description: { id: this.id, name, label, source }, work: this.binding.work, key: options.key, output: options.output });
  }
  resume(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, contextId: string, options: InvocationRelationOptions = {}) {
    return this.invocationBuilder.restoration(contextId, this.binding.work, parent.context.id, (restore) => {
      const checkpoint = this.binding.declaration.checkpoint!;
      const point = checkpoint.points[restore.head.image.point];
      if (!point) throw new Error('Checkpoint point is not declared');
      const input = checkpoint.input.decode(restore.head.image.frame.input);
      const { name, label, source } = this.binding.declaration;
      const description = { id: this.id, name, label, source };
      return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.binding.requires, initial: point.resume.requires, refinements: this.binding.refinements, observation: this.binding.declaration.observation, description, work: this.binding.work, key: options.key, output: options.output, restore });
    });
  }

  call(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: Input): Promise<Output> {
    return this.create(parent, input).run();
  }
}
