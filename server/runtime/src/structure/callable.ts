import { randomUUID } from 'node:crypto';
import { combineOutputReceivers } from '../output/delivery.js';
import type { CallableBinding } from '../binding/contract.js';
import { CallableSources, type CallableCallBindings } from '../binding/sources.js';
import type { CallableInvocationBuilder, CallableInvocationStarted } from '../invocation/builders/callable.js';
import type { Invocation } from '../invocation/invocation.js';
import type { CallableContext } from '../context/callable.js';
import type { InvocationControls } from '../context/context.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { CheckpointRestoration } from '../checkpoint/contract.js';

export interface CallableInvocationCallbacks<Input, Output, Resources extends object> {
  readonly started?: CallableInvocationStarted<Input, Output, Resources>;
}

declare const callableOptions: unique symbol;

/** A reusable callable consumes fixed wiring; every call owns independent state and endpoints. */
export class BoundCallable<Input, Output, Resources extends object = object, Options = unknown> {
  readonly id = randomUUID();
  // Host requirements must not disappear through a widened BoundCallable annotation.
  declare readonly [callableOptions]: (options: Options) => Options;

  constructor(
    private readonly invocationBuilder: CallableInvocationBuilder,
    private readonly binding: CallableBinding<Input, Output, Resources>,
    private readonly sources: CallableSources<Options>,
  ) {}

  get definition() {
    return this.binding.definition;
  }

  get children() {
    return this.binding.children;
  }

  begin(options: Options): CallableCallBindings<Options> {
    return this.sources.begin(options);
  }

  create(parent: Invocation<unknown, unknown, CallableContext>, input: Input, options: InvocationRelationOptions = {}): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    this.invocationBuilder.check(parent);
    const scope = this.sources.require(parent.construction);
    return this.construct(input, scope, {}, parent, options);
  }

  createRoot(input: Input, scope: CallableCallBindings<Options>, controls: InvocationControls): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    this.sources.require(scope);
    return this.construct(input, scope, controls);
  }

  resume(parent: Invocation<unknown, unknown, CallableContext>, contextId: string, options: InvocationRelationOptions = {}): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    this.invocationBuilder.check(parent);
    const scope = this.sources.require(parent.construction);
    return this.restore(contextId, scope, {}, parent, options);
  }

  resumeRoot(contextId: string, scope: CallableCallBindings<Options>, controls: InvocationControls): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    this.sources.require(scope);
    return this.restore(contextId, scope, controls);
  }

  call(parent: Invocation<unknown, unknown, CallableContext>, input: Input): Promise<Output> {
    return this.create(parent, input).run();
  }

  private restore(contextId: string, scope: CallableCallBindings<Options>, controls: InvocationControls, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}) {
    return this.invocationBuilder.restoration(contextId, this.binding.work, this.binding.declaration.kind, parent?.context.id, (restore) => {
      const checkpoint = this.binding.declaration.checkpoint!;
      const input = checkpoint.input.decode(restore.head.image.frame.input) as Input;
      return this.construct(input, scope, controls, parent, options, restore);
    });
  }

  private construct(input: Input, scope: CallableCallBindings<Options>, controls: InvocationControls, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}, restore?: CheckpointRestoration) {
    const declaration = this.binding.declaration;
    const initial = restore ? declaration.checkpoint?.points.find((point) => point.name === restore.head.image.point)?.resume.requires : declaration.run.requires;
    if (!initial) throw new Error('Checkpoint point is not declared');
    const access = scope.open(this.binding.definition, input, !!restore);
    const { name, label, source, callee } = declaration;
    return this.invocationBuilder.create<Input, Output, Resources>(input, {
      kind: declaration.kind,
      controls,
      parent,
      construction: scope,
      key: options.key,
      declarationPosition: options.declarationPosition,
      requires: this.binding.requires,
      supply: this.binding.supply,
      initial,
      refinements: this.binding.refinements,
      resources: access.resources,
      observation: declaration.observation,
      description: { id: this.id, name, label, source, callee },
      work: this.binding.work,
      started: access.started,
      progress: access.progress,
      output: combineOutputReceivers(options.output, access.output),
      restore,
    });
  }
}
