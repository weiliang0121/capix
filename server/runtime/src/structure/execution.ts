import { combineOutputReceivers } from '../output/delivery.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionInvocationBuilder, ExecutionInvocationStarted } from '../invocation/builders/execution.js';
import type { ExecutionBinding } from '../binding/contract.js';
import type { ResourceBindings } from '../resource/bindings.js';
import type { Invocation } from '../invocation/invocation.js';
import type { RuntimeContext } from '../context/runtime.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import { attachInvocationResources } from '../invocation/resources.js';
import type { ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from '../invocation/progress.js';

export interface ExecutionInvocationCallbacks<Input, Output, Resources extends object> {
  accepted?(input: Input): void;
  started?: ExecutionInvocationStarted<Input, Output, Resources>;
}
export interface ExecutionInvocationBindings<Input, Output, Resources extends object, EntryInput, EntryResources extends object> {
  entry(input: EntryInput): ResourceBindings<EntryResources>;
  capture(input: Input): ResourceBindings<Resources>;
  readonly callbacks?: ExecutionInvocationCallbacks<Input, Output, Resources>;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
}

/** Reusable E structure with fixed entry ordering; every accepted call creates its own ExecutionContext and Invocation. */
export class BoundExecution<Input, Output, Resources extends object = object, EntryInput = Input, EntryResources extends object = object> {
  readonly id = randomUUID();
  constructor(
    private readonly invocationBuilder: ExecutionInvocationBuilder,
    private readonly binding: ExecutionBinding<Input, Output, Resources, EntryInput, EntryResources>,
  ) {}

  get definition() {
    return this.binding.definition;
  }

  get children() {
    return this.binding.children;
  }

  create(parent: Invocation<unknown, unknown, RuntimeContext>, input: EntryInput, options: InvocationRelationOptions = {}) {
    parent.requireHealthy();
    this.invocationBuilder.check(parent);
    const bindings: ExecutionInvocationBindings<Input, Output, Resources, EntryInput, EntryResources> = parent.context.executionBinding(this.definition);
    const callbacks = bindings.callbacks ?? {};
    const entry = this.binding.declaration.entry;
    const stage = <Value>(name: 'accept' | 'notification' | 'admit' | 'capture', work: () => Value): Value => {
      let value: Value;
      try {
        value = work();
      } catch (error) {
        try {
          parent.publishEntry({ target: 'execution', instanceId: this.id, key: options.key, stage: name, status: 'failed', error });
        } catch (observed) {
          throw new AggregateError([error, observed], 'Execution entry and its observation both failed', { cause: error });
        }
        throw error;
      }
      // The stage has succeeded. Publication failure never reclassifies that established fact.
      parent.publishEntry({ target: 'execution', instanceId: this.id, key: options.key, stage: name, status: 'accepted' });
      return value;
    };
    let accepted: Input;
    if (entry) {
      let resources: ResourceBindings<EntryResources>;
      let active = true;
      try {
        accepted = stage('accept', () => {
          resources = bindings.entry(input);
          resources.restrict(() => {
            if (!active) throw new Error('Execution entry access has ended');
          });
          // Entry facts belong to the existing R call; E does not yet have a Context.
          attachInvocationResources(parent, resources);
          resources.start();
          return entry.accept(input, resources.values);
        });
        parent.requireHealthy();
        if (callbacks.accepted) stage('notification', () => callbacks.accepted!(accepted));
        parent.requireHealthy();
        if (!parent.context.signal.aborted && entry.admit) stage('admit', () => entry.admit!(accepted, resources.values));
      } finally {
        active = false;
      }
    } else {
      accepted = stage('accept', () => input as unknown as Input);
      if (callbacks.accepted) stage('notification', () => callbacks.accepted!(accepted));
    }
    parent.requireActive();
    const resources = stage('capture', () => bindings.capture(accepted));
    return this.invocationBuilder.create(parent, accepted, {
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
  /** Resume fixed invocation input; entry acceptance and admission are never replayed. */
  resume(parent: Invocation<unknown, unknown, RuntimeContext>, contextId: string, options: InvocationRelationOptions = {}) {
    parent.requireActive();
    this.invocationBuilder.check(parent);
    return this.invocationBuilder.restoration(contextId, this.binding.work, parent.context.id, (restore) => {
      const checkpoint = this.binding.declaration.checkpoint!;
      const point = checkpoint.points.find((point) => point.name === restore.head.image.point);
      if (!point) throw new Error('Checkpoint point is not declared');
      const input = checkpoint.input.decode(restore.head.image.frame.input);
      const bindings: ExecutionInvocationBindings<Input, Output, Resources, EntryInput, EntryResources> = parent.context.executionBinding(this.definition);
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
