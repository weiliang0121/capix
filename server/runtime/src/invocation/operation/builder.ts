import type { ObservationDeclaration } from '../../observation/definition.js';
import type { CallFact } from '../../observation/facts.js';
import { bindCallObservation } from '../../observation/binding.js';
import { attachInvocationResources } from '../resources.js';
import { type ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { OperationContext } from '../../context/operation.js';
import type { OperationContextBuilder } from '../../context/operation/builder.js';
import type { OperationDescription } from '../description.js';

export interface OperationInvocationRequest<I, O, R extends object = object> {
  input: I;
  requires?: ResourceRequirements<R>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<CallFact>[];
  key?: string;
  description: OperationDescription;
  work: InvocationWork<OperationContext<I, O, R>, I, O>;
}

export class OperationInvocationBuilder {
  constructor(
    private readonly contexts: OperationContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O, R extends object = object>(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, request: OperationInvocationRequest<I, O, R>): Invocation<I, O, OperationContext<I, O, R>> {
    const owner = parent.context;
    this.contexts.check(owner);
    const requires = request.requires ?? ({} as ResourceRequirements<R>);
    const resources = owner.resources.select(requires, request.initial);
    const context = this.contexts.create<I, O, R>(owner, request.input, resources);
    const identity = { contextId: context.id, level: 'operation' as const, parentContextId: parent.context.id };
    const observation = bindCallObservation({ identity, description: request.description, declarations: request.observation, resources: context.resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'operation', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<I, O, OperationContext<I, O, R>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes, validate: () => this.contexts.check(owner) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
