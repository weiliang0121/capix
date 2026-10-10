import type { ProgressReceiver } from '../../progress/channel.js';
import type { InvocationProgress } from '../progress.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { InvocationCapabilities } from '../capabilities.js';
import type { RuntimeContext, ExecutionBindingResolver } from '../../context/runtime.js';
import type { InvocationControls } from '../../context/context.js';
import type { RuntimeContextBuilder } from '../../context/runtime/builder.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
import { InvocationChangeEmitter } from '../changes.js';
import { attachInvocationResources } from '../resources.js';

export interface RuntimeInvocationRequest<Input, Output, Resources extends object = object> {
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly controls: InvocationControls;
  readonly resources?: ResourceBindings<Resources>;
  readonly executionBindings?: ExecutionBindingResolver;
  readonly requires?: ResourceRequirements<Resources>;
  readonly initial?: ResourceRequirements;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly work: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>;
  readonly started?: InvocationStarted<Input, Output, RuntimeContext<Input, Output, Resources>>;
}

export class RuntimeInvocationBuilder {
  constructor(
    private readonly runtimeId: string,
    private readonly contextBuilder: RuntimeContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<Input, Output, Resources extends object = object>(input: Input, request: RuntimeInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, RuntimeContext<Input, Output, Resources>> {
    const resources = (request.resources ?? new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)).select(request.requires ?? ({} as ResourceRequirements<Resources>), request.initial);
    const context = this.contextBuilder.create<Input, Output, Resources>(input, request.controls, resources, request.executionBindings);
    const identity = { contextId: context.id, level: 'runtime' as const };
    const observation = bindInvocationObservation({ identity, description: { id: this.runtimeId }, declarations: request.observation, resources }, this.capabilities.observations);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, RuntimeContext<Input, Output, Resources>>({ context, work: request.work, progress: request.progress, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: { id: this.runtimeId }, changes, started: request.started });
    attachInvocationResources(invocation, resources);
    return invocation;
  }
}
