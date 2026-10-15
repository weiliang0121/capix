import type { CheckpointRestoration } from '../../checkpoint/contract.js';
import { prepareCheckpointRestoration } from '../../checkpoint/restoration.js';
import type { InvocationOutputReceiver } from '../../output/contract.js';
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
import type { InvocationWork } from '../work.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { ExecutionContextBuilder } from '../../context/builders/execution.js';
import type { RuntimeContext } from '../../context/runtime.js';

export type ExecutionInvocationStarted<Input, Output, Resources extends object = object> = InvocationStarted<Input, Output, ExecutionContext<Input, Output, Resources>>;

/** Construction's input contract; application resource sources stay in binding. */
export interface ExecutionInvocationEnvironment<Resources extends object> {
  readonly resources: ResourceBindings<Resources>;
}

export interface ExecutionInvocationRequest<Input, Output, Resources extends object = object> {
  readonly restore?: CheckpointRestoration;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
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

  restoration<Input, Output, Resources extends object = object>(contextId: string, work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>, parentContextId: string): CheckpointRestoration;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>, parentContextId: string, construct: (restoration: CheckpointRestoration) => Value): Value;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>, parentContextId: string, construct?: (restoration: CheckpointRestoration) => Value): Value | CheckpointRestoration {
    return prepareCheckpointRestoration(this.capabilities.checkpoints, work.checkpoint, contextId, { level: 'execution', parentContextId }, construct);
  }

  create<Input, Output, Resources extends object = object>(parent: Invocation<unknown, unknown, RuntimeContext>, input: Input, request: ExecutionInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, ExecutionContext<Input, Output, Resources>> {
    this.check(parent);
    request.validate?.();
    const environment = request.establish?.(input);
    const resources = (environment?.resources ?? new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)).select(request.requires ?? ({} as ResourceRequirements<Resources>), request.initial);
    const context = this.contextBuilder.create<Input, Output, Resources>(parent.context, input, resources);
    if (request.restore) {
      if (!request.work.checkpoint) throw new Error('Checkpoint declaration is missing');
      const frame = request.restore.head.image.frame;
      context.installCheckpoint({ id: frame.owner.contextId, round: frame.round, currentInput: request.work.checkpoint.input.decode(frame.currentInput) });
    }
    const identity = { contextId: context.id, level: 'execution' as const, parentContextId: parent.context.id };
    const recovering = !!request.restore || parent.recovering;
    const observation = recovering ? undefined : bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources }, this.capabilities.observations, parent.observation);
    const changes = !recovering && this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, ExecutionContext<Input, Output, Resources>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, checkpoints: this.capabilities.checkpoints, restore: request.restore, progress: request.progress, output: request.output, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, started: request.started, changes, validate: () => this.check(parent) });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
