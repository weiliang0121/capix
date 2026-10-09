import type { ObservationDeclaration } from '../../observation/definition.js';
import type { CallFact } from '../../observation/facts.js';
import { bindCallObservation } from '../../observation/binding.js';
import { attachInvocationResources } from '../resources.js';
import type { ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { OperationContext } from '../../context/operation.js';
import type { AttemptContextBuilder } from '../../context/attempt/builder.js';
import type { AttemptDescription } from '../description.js';

export interface AttemptInvocationRequest<I, O, R extends object = object> {
  input: I;
  requires?: ResourceRequirements<R>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<CallFact>[];
  key?: string;
  description: AttemptDescription;
  work: InvocationWork<AttemptContext<I, O, R>, I, O>;
}

export class AttemptInvocationBuilder {
  constructor(
    private readonly contexts: AttemptContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O, R extends object = object>(parent: Invocation<unknown, unknown, OperationContext>, request: AttemptInvocationRequest<I, O, R>): Invocation<I, O, AttemptContext<I, O, R>> {
    this.contexts.check(parent.context);
    const context = this.contexts.create<I, O, R>(parent.context, request.input, parent.context.resources.select(request.requires ?? ({} as ResourceRequirements<R>), request.initial));
    const identity = { contextId: context.id, level: 'attempt' as const, parentContextId: parent.context.id };
    const observation = bindCallObservation({ identity, description: request.description, declarations: request.observation, resources: context.resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'attempt', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<I, O, AttemptContext<I, O, R>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes, validate: () => this.contexts.check(parent.context) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
