import type { ObservationDeclaration } from '../../observation/definition.js';
import type { InvocationFact } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../observation/binding.js';
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

export interface OperationInvocationRequest<Input, Output, Resources extends object = object> {
  input: Input;
  requires?: ResourceRequirements<Resources>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<InvocationFact>[];
  key?: string;
  description: OperationDescription;
  work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>;
}

export class OperationInvocationBuilder {
  constructor(
    private readonly contextBuilder: OperationContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<Input, Output, Resources extends object = object>(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, request: OperationInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, OperationContext<Input, Output, Resources>> {
    const owner = parent.context;
    this.contextBuilder.check(owner);
    const requires = request.requires ?? ({} as ResourceRequirements<Resources>);
    const resources = owner.resources.select(requires, request.initial);
    const context = this.contextBuilder.create<Input, Output, Resources>(owner, request.input, resources);
    const identity = { contextId: context.id, level: 'operation' as const, parentContextId: parent.context.id };
    const observation = bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources: context.resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'operation', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, OperationContext<Input, Output, Resources>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes, validate: () => this.contextBuilder.check(owner) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
