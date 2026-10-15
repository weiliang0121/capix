import type { CheckpointRestoration } from '../../checkpoint/contract.js';
import { prepareCheckpointRestoration } from '../../checkpoint/restoration.js';
import type { InvocationOutputReceiver } from '../../output/contract.js';
import type { ProgressReceiver } from '../../progress.js';
import type { InvocationProgress } from '../progress.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../work.js';
import type { InvocationCapabilities } from '../capabilities.js';
import type { RuntimeContext, ExecutionBindingResolver } from '../../context/runtime.js';
import type { InvocationControls } from '../../context/context.js';
import type { RuntimeContextBuilder } from '../../context/builders/runtime.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
import { InvocationChangeEmitter } from '../changes.js';
import { attachInvocationResources } from '../resources.js';
import type { RuntimeDescription } from '../description.js';

export interface RuntimeInvocationRequest<Input, Output, Resources extends object = object> {
  readonly description: RuntimeDescription;
  readonly restore?: CheckpointRestoration;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
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
    private readonly contextBuilder: RuntimeContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  restoration<Input, Output, Resources extends object = object>(contextId: string, work: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>): CheckpointRestoration;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>, construct: (restoration: CheckpointRestoration) => Value): Value;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>, construct?: (restoration: CheckpointRestoration) => Value): Value | CheckpointRestoration {
    return prepareCheckpointRestoration(this.capabilities.checkpoints, work.checkpoint, contextId, { level: 'runtime' }, construct);
  }

  create<Input, Output, Resources extends object = object>(input: Input, request: RuntimeInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, RuntimeContext<Input, Output, Resources>> {
    const resources = (request.resources ?? new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)).select(request.requires ?? ({} as ResourceRequirements<Resources>), request.initial);
    const context = this.contextBuilder.create<Input, Output, Resources>(input, request.controls, resources, request.executionBindings);
    if (request.restore) {
      if (!request.work.checkpoint) throw new Error('Checkpoint declaration is missing');
      const frame = request.restore.head.image.frame;
      context.installCheckpoint({ id: frame.owner.contextId, round: frame.round, currentInput: request.work.checkpoint.input.decode(frame.currentInput) });
    }
    const identity = { contextId: context.id, level: 'runtime' as const };
    const recovering = !!request.restore;
    const observation = recovering ? undefined : bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources }, this.capabilities.observations);
    const changes = !recovering && this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, RuntimeContext<Input, Output, Resources>>({ context, work: request.work, checkpoints: this.capabilities.checkpoints, restore: request.restore, progress: request.progress, output: request.output, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes, started: request.started });
    attachInvocationResources(invocation, resources);
    return invocation;
  }
}
