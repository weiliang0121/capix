import { randomUUID } from 'node:crypto';
import type { ResourceRequirements } from '../resource/bindings.js';
import { definitionResources } from '../definition/invocation.js';
import type { ExecutionInvocationBuilder, ExecutionStarted } from '../invocation/execution/builder.js';
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

export interface ExecutionCallbacks<I, O, R extends object> {
  accepted?(input: I): void;
  started?: ExecutionStarted<I, O, R>;
}
export interface ExecutionAssembly<I, O, U, R extends object, ER extends object> {
  entry(input: U): ResourceBindings<ER>;
  capture(input: I): ResourceBindings<R>;
  readonly callbacks?: ExecutionCallbacks<I, O, R>;
}

/** Bound execution node. Runtime owns reservation; the node owns fixed entry ordering. */
export class Execution<I, O, R extends object = object, U = I, ER extends object = object> {
  readonly id = randomUUID();
  private readonly work: InvocationWork<ExecutionContext<I, O, R>, I, O>;
  constructor(
    private readonly invocations: ExecutionInvocationBuilder,
    readonly definition: ExecutionDefinition<I, O, R, U, ER, any>,
    readonly children: BoundChildren,
    private readonly requires: ResourceRequirements<R> = definitionResources(definition) as ResourceRequirements<R>,
  ) {
    this.work = bindInvocationWork(definition, children);
  }

  create(parent: Invocation<unknown, unknown, RuntimeContext>, input: U, options: InvocationRelationOptions = {}) {
    parent.requireHealthy();
    this.invocations.check(parent);
    const assembly: ExecutionAssembly<I, O, U, R, ER> = parent.context.execution(this.definition);
    const callbacks = assembly.callbacks ?? {};
    const entry = this.definition.entry;
    const stage = <T>(name: 'accept' | 'notification' | 'admit' | 'capture', work: () => T): T => {
      let value: T;
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
    let accepted: I;
    if (entry) {
      let resources: ResourceBindings<ER>;
      let active = true;
      try {
        accepted = stage('accept', () => {
          resources = assembly.entry(input);
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
      accepted = stage('accept', () => input as unknown as I);
      if (callbacks.accepted) stage('notification', () => callbacks.accepted!(accepted));
    }
    parent.requireHealthy();
    const bound = stage('capture', () => assembly.capture(accepted));
    return this.invocations.create(parent, accepted, {
      key: options.key,
      description: { id: this.id },
      requires: this.requires,
      initial: this.definition.run.requires,
      observation: this.definition.observation,
      establish: () => ({ resources: bound }),
      work: this.work,
      started: callbacks.started,
    });
  }
}
