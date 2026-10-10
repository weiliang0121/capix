import { randomUUID } from 'node:crypto';
import type { ResourceRequirements } from '../resource/bindings.js';
import { definitionResources } from '../binding/resources.js';
import type { ExecutionInvocationBuilder, ExecutionInvocationStarted } from '../invocation/execution/builder.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { ExecutionContext } from '../context/execution.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from '../binding/children.js';
import type { ResourceBindings } from '../resource/bindings.js';
import { bindInvocationWork } from '../binding/work.js';
import type { Invocation } from '../invocation/invocation.js';
import type { RuntimeContext } from '../context/runtime.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import { attachInvocationResources } from '../invocation/resources.js';
import type { ProgressReceiver } from '../progress/channel.js';
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
}

/** Reusable E structure with fixed entry ordering; every accepted call creates its own ExecutionContext and Invocation. */
export class BoundExecution<Input, Output, Resources extends object = object, EntryInput = Input, EntryResources extends object = object> {
  readonly id = randomUUID();
  private readonly work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>;
  constructor(
    private readonly invocationBuilder: ExecutionInvocationBuilder,
    readonly definition: ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, any>,
    readonly children: BoundChildren,
    private readonly requires: ResourceRequirements<Resources> = definitionResources(definition) as ResourceRequirements<Resources>,
  ) {
    this.work = bindInvocationWork(definition, children);
  }

  create(parent: Invocation<unknown, unknown, RuntimeContext>, input: EntryInput, options: InvocationRelationOptions = {}) {
    parent.requireHealthy();
    this.invocationBuilder.check(parent);
    const bindings: ExecutionInvocationBindings<Input, Output, Resources, EntryInput, EntryResources> = parent.context.executionBinding(this.definition);
    const callbacks = bindings.callbacks ?? {};
    const entry = this.definition.entry;
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
    parent.requireHealthy();
    const resources = stage('capture', () => bindings.capture(accepted));
    return this.invocationBuilder.create(parent, accepted, {
      key: options.key,
      description: { id: this.id },
      requires: this.requires,
      initial: this.definition.run.requires,
      observation: this.definition.observation,
      establish: () => ({ resources }),
      work: this.work,
      started: callbacks.started,
      progress: bindings.progress,
    });
  }
}
