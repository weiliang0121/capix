import type { ProgressReceiver } from '../../progress/channel.js';
import type { InvocationProgress } from '../progress.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact, InvocationDescription } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
import { attachInvocationResources } from '../resources.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/execution/builder.js';
import type { RuntimeContext } from '../../context/runtime.js';

export type ExecutionInvocationStarted<Input, Output, Resources extends object = object> = InvocationStarted<Input, Output, ExecutionContext<Input, Output, Resources>>;

/** Construction's input contract; application resource sources stay in binding. */
export interface ExecutionInvocationEnvironment<Resources extends object> {
  readonly resources: ResourceBindings<Resources>;
}

export interface ExecutionInvocationRequest<Input, Output, Resources extends object = object> {
  readonly progress?: ProgressReceiver<InvocationProgress>;
  key?: string;
  description?: InvocationDescription;
  requires?: ResourceRequirements<Resources>;
  initial?: ResourceRequirements;
  observation?: readonly ObservationDeclaration<InvocationFact>[];
  establish?: (input: Input) => ExecutionInvocationEnvironment<Resources>;
  validate?: () => void;
  work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>;
  started?: ExecutionInvocationStarted<Input, Output, Resources>;
}

/** Constructs E as a direct child of this Runtime's active R call. */
export class ExecutionInvocationBuilder {
  constructor(
    private readonly contextBuilder: ExecutionContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  check(parent: Invocation<unknown, unknown, RuntimeContext>): void {
    parent.requireHealthy();
    this.contextBuilder.check(parent.context);
  }

  create<Input, Output, Resources extends object = object>(parent: Invocation<unknown, unknown, RuntimeContext>, input: Input, request: ExecutionInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, ExecutionContext<Input, Output, Resources>> {
    this.check(parent);
    request.validate?.();
    const environment = request.establish?.(input);
    const resources = (environment?.resources ?? new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)).select(request.requires ?? ({} as ResourceRequirements<Resources>), request.initial);
    const context = this.contextBuilder.create<Input, Output, Resources>(parent.context, input, resources);
    const identity = { contextId: context.id, level: 'execution' as const, parentContextId: parent.context.id };
    const observation = bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources }, this.capabilities.observations, parent.observation);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, ExecutionContext<Input, Output, Resources>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, progress: request.progress, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, started: request.started, changes, validate: () => this.check(parent) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
