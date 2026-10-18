import { restoreCheckpointContinuation } from '../../checkpoint/continuation.js';
import type { CheckpointRestoration } from '../../checkpoint/contract.js';
import { prepareCheckpointRestoration } from '../../checkpoint/restoration.js';
import type { InvocationOutputReceiver } from '../../output/contract.js';
import type { ProgressReceiver } from '../../progress.js';
import type { InvocationProgress } from '../progress.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
import { attachInvocationResources } from '../resources.js';
import type { ResourceRequirements } from '../../resource/bindings.js';
import type { ResourceRefinement } from '../../resource/offer.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../work.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { OperationContext } from '../../context/operation.js';
import type { OperationContextBuilder } from '../../context/builders/operation.js';
import type { OperationDescription } from '../description.js';

export interface OperationInvocationRequest<Input, Output, Resources extends object = object> {
  readonly restore?: CheckpointRestoration;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
  input: Input;
  requires?: ResourceRequirements<Resources>;
  initial?: ResourceRequirements;
  readonly supply?: ResourceRequirements;
  refinements?: readonly ResourceRefinement<Input>[];
  observation?: readonly ObservationDeclaration<InvocationFact>[];
  key?: string;
  readonly declarationPosition?: number;
  description: OperationDescription;
  work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>;
}

export class OperationInvocationBuilder {
  constructor(
    private readonly contextBuilder: OperationContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  restoration<Input, Output, Resources extends object = object>(contextId: string, work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>, parentContextId: string): CheckpointRestoration;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>, parentContextId: string, construct: (restoration: CheckpointRestoration) => Value): Value;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>, parentContextId: string, construct?: (restoration: CheckpointRestoration) => Value): Value | CheckpointRestoration {
    return prepareCheckpointRestoration(this.capabilities.checkpoints, work.checkpoint, contextId, { level: 'operation', parentContextId }, construct);
  }

  create<Input, Output, Resources extends object = object>(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, request: OperationInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, OperationContext<Input, Output, Resources>> {
    const owner = parent.context;
    parent.requireActive();
    this.contextBuilder.check(owner);
    const requires = request.requires ?? ({} as ResourceRequirements<Resources>);
    const resources = owner.resources.select(requires, request.initial, { input: request.input, refinements: request.refinements ?? [], supply: request.supply });
    const context = this.contextBuilder.create<Input, Output, Resources>(owner, request.input, resources);
    if (request.restore) {
      if (!request.work.checkpoint) throw new Error('Checkpoint declaration is missing');
      const frame = request.restore.head.image.frame;
      context.installCheckpoint({ id: frame.owner.contextId, round: frame.round, currentInput: request.work.checkpoint.input.decode(frame.currentInput), continuation: restoreCheckpointContinuation(frame) });
    }
    const identity = { contextId: context.id, level: 'operation' as const, parentContextId: parent.context.id };
    const recovering = !!request.restore || parent.recovering;
    const observation = recovering ? undefined : bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources: context.resources }, this.capabilities.observations, parent.observation);
    const changes = !recovering && this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'operation', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, OperationContext<Input, Output, Resources>>({ parent: { invocation: parent, key: request.key, declarationPosition: request.declarationPosition }, context, work: request.work, checkpoints: this.capabilities.checkpoints, restore: request.restore, progress: request.progress, output: request.output, clock: this.capabilities.clock, signal: context.signal, observation, identity, description: request.description, changes });
    attachInvocationResources(invocation, context.resources);
    return invocation;
  }
}
