import type { ProgressReceiver } from '../../progress/channel.js';
import type { InvocationProgress } from '../progress.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
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

export interface AttemptInvocationRequest<Input, Output, Resources extends object = object> {
  readonly progress?: ProgressReceiver<InvocationProgress>;
  input: Input;
  requires?: ResourceRequirements<Resources>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<InvocationFact>[];
  key?: string;
  description: AttemptDescription;
  work: InvocationWork<Input, Output, AttemptContext<Input, Output, Resources>>;
}

export class AttemptInvocationBuilder {
  constructor(
    private readonly contextBuilder: AttemptContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<Input, Output, Resources extends object = object>(parent: Invocation<unknown, unknown, OperationContext>, request: AttemptInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, AttemptContext<Input, Output, Resources>> {
    parent.requireActive();
    this.contextBuilder.check(parent.context);
    const context = this.contextBuilder.create<Input, Output, Resources>(parent.context, request.input, parent.context.resources.select(request.requires ?? ({} as ResourceRequirements<Resources>), request.initial));
    const identity = { contextId: context.id, level: 'attempt' as const, parentContextId: parent.context.id };
    const observation = bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources: context.resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'attempt', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, AttemptContext<Input, Output, Resources>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, progress: request.progress, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes, validate: () => this.contextBuilder.check(parent.context) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
