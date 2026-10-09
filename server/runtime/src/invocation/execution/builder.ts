import type { ObservationDeclaration } from '../../observation/definition.js';
import type { CallFact, CallDescription } from '../../observation/facts.js';
import { bindCallObservation } from '../../observation/binding.js';
import { attachInvocationResources } from '../resources.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/execution/builder.js';
import type { RuntimeContext } from '../../context/runtime.js';

export type ExecutionStarted<I, O, R extends object = object> = InvocationStarted<I, O, ExecutionContext<I, O, R>>;

/** Construction's input contract; application resource sources stay in binding. */
export interface ExecutionEnvironment<R extends object> {
  readonly resources: ResourceBindings<R>;
}

export interface ExecutionInvocationRequest<I, O, R extends object = object> {
  key?: string;
  description?: CallDescription;
  requires?: ResourceRequirements<R>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<CallFact>[];
  establish?: (input: I) => ExecutionEnvironment<R>;
  validate?: () => void;
  work: InvocationWork<ExecutionContext<I, O, R>, I, O>;
  started?: ExecutionStarted<I, O, R>;
}

/** Constructs E as a direct child of this Runtime's active R call. */
export class ExecutionInvocationBuilder {
  constructor(
    private readonly contexts: ExecutionContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  check(parent: Invocation<unknown, unknown, RuntimeContext>): void {
    parent.requireHealthy();
    this.contexts.check(parent.context);
  }

  create<I, O, R extends object = object>(parent: Invocation<unknown, unknown, RuntimeContext>, input: I, request: ExecutionInvocationRequest<I, O, R>): Invocation<I, O, ExecutionContext<I, O, R>> {
    this.check(parent);
    request.validate?.();
    const environment = request.establish?.(input);
    const resources = (environment?.resources ?? new ResourceBindings<R>({} as ResourceRequirements<R>)).select(request.requires ?? ({} as ResourceRequirements<R>), request.initial);
    const context = this.contexts.create<I, O, R>(parent.context, input, resources);
    const identity = { contextId: context.id, level: 'execution' as const, parentContextId: parent.context.id };
    const observation = bindCallObservation({ identity, description: request.description, declarations: request.observation, resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<I, O, ExecutionContext<I, O, R>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, started: request.started, changes, validate: () => this.check(parent) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
