import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { InvocationCapabilities } from '../capabilities.js';
import type { RuntimeContext, RuntimeCallOptions, RuntimeExecutionBindings } from '../../context/runtime.js';
import type { RuntimeContextBuilder } from '../../context/runtime/builder.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { ObservationDeclaration } from '../../observation/definition.js';
import type { CallFact } from '../../observation/facts.js';
import { bindCallObservation } from '../../observation/binding.js';
import { InvocationChangeEmitter } from '../changes.js';
import { attachInvocationResources } from '../resources.js';

export interface RuntimeInvocationRequest<I, O, R extends object = object> {
  readonly context: RuntimeCallOptions;
  readonly resources?: ResourceBindings<R>;
  readonly executions?: RuntimeExecutionBindings;
  readonly requires?: ResourceRequirements<R>;
  readonly initial?: ResourceRequirements;
  readonly observation?: readonly ObservationDeclaration<CallFact>[];
  readonly work: InvocationWork<RuntimeContext<I, O, R>, I, O>;
  readonly started?: InvocationStarted<I, O, RuntimeContext<I, O, R>>;
}

export class RuntimeInvocationBuilder {
  constructor(
    private readonly runtimeId: string,
    private readonly contexts: RuntimeContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O, R extends object = object>(input: I, request: RuntimeInvocationRequest<I, O, R>): Invocation<I, O, RuntimeContext<I, O, R>> {
    const resources = (request.resources ?? new ResourceBindings<R>({} as ResourceRequirements<R>)).select(request.requires ?? ({} as ResourceRequirements<R>), request.initial);
    const context = this.contexts.create<I, O, R>(input, request.context, resources, request.executions);
    const identity = { contextId: context.id, level: 'runtime' as const };
    const observation = bindCallObservation({ identity, description: { id: this.runtimeId }, declarations: request.observation, resources }, this.capabilities.observations);
    const changes = this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<I, O, RuntimeContext<I, O, R>>({ context, work: request.work, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: { id: this.runtimeId }, changes, started: request.started });
    attachInvocationResources(invocation, resources);
    return invocation;
  }
}
