import type { CallableKind } from '@capix/protocol';
import { restoreCheckpointContinuation } from '../../checkpoint/continuation.js';
import type { CheckpointRestoration } from '../../checkpoint/contract.js';
import { prepareCheckpointRestoration } from '../../checkpoint/restoration.js';
import type { InvocationOutputReceiver } from '../../output/contract.js';
import type { ProgressReceiver } from '../../progress.js';
import type { InvocationProgress } from '../progress.js';
import type { ObservationDeclaration } from '../../definition/observation.js';
import type { InvocationFact, InvocationDescription } from '../../observation/facts.js';
import { bindInvocationObservation } from '../../binding/observation.js';
import { attachInvocationResources } from '../resources.js';
import { ResourceBindings, type ResourceRequirements } from '../../resource/bindings.js';
import type { ResourceRefinement } from '../../resource/offer.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../work.js';
import type { CallableContext } from '../../context/callable.js';
import type { InvocationControls } from '../../context/context.js';
import { CallableContextBuilder } from '../../context/builders/callable.js';
import type { InvocationRelationOptions } from '../relation.js';

export type CallableInvocationStarted<Input, Output, Resources extends object = object> = InvocationStarted<Input, Output, CallableContext<Input, Output, Resources>>;

export interface CallableInvocationRequest<Input, Output, Resources extends object = object> extends InvocationRelationOptions {
  readonly kind: CallableKind;
  readonly controls?: InvocationControls;
  readonly parent?: Invocation<unknown, unknown, CallableContext>;
  readonly construction?: object;
  readonly restore?: CheckpointRestoration;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<Output>;
  readonly resources?: ResourceBindings;
  readonly requires?: ResourceRequirements<Resources>;
  readonly initial?: ResourceRequirements;
  readonly supply?: ResourceRequirements;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly description?: InvocationDescription;
  readonly work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>;
  readonly started?: CallableInvocationStarted<Input, Output, Resources>;
}

/** Builds every callable through the same resource, control, observation and restoration path. */
export class CallableInvocationBuilder {
  constructor(
    private readonly contextBuilder = new CallableContextBuilder(),
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  check(parent: Invocation<unknown, unknown, CallableContext>): void {
    parent.requireActive();
    this.contextBuilder.check(parent.context);
  }

  restoration<Input, Output, Resources extends object = object>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId?: string): CheckpointRestoration;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId: string | undefined, construct: (restoration: CheckpointRestoration) => Value): Value;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId?: string, construct?: (restoration: CheckpointRestoration) => Value): CheckpointRestoration | Value {
    return prepareCheckpointRestoration(this.capabilities.checkpoints, work.checkpoint, contextId, { kind, ...(parentContextId ? { parentContextId } : {}) }, construct);
  }

  create<Input, Output, Resources extends object = object>(input: Input, request: CallableInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    const parent = request.parent;
    if (parent) this.check(parent);
    const supplied = request.resources ?? parent?.context.resources ?? new ResourceBindings({});
    const requires = request.requires ?? ({} as ResourceRequirements<Resources>);
    const resources = supplied.select(requires, request.initial, { input, refinements: request.refinements ?? [], supply: request.supply });
    const context = this.contextBuilder.create<Input, Output, Resources>(input, request.kind, request.controls ?? {}, resources, parent?.context);
    if (request.restore) {
      if (!request.work.checkpoint) throw new Error('Checkpoint declaration is missing');
      const frame = request.restore.head.image.frame;
      context.installCheckpoint({ id: frame.owner.contextId, round: frame.round, currentInput: request.work.checkpoint.input.decode(frame.currentInput), continuation: restoreCheckpointContinuation(frame) });
    }
    const identity = { contextId: context.id, kind: request.kind, ...(parent ? { parentContextId: parent.context.id } : {}) };
    const recovering = !!request.restore || !!parent?.recovering;
    const observation = recovering ? undefined : bindInvocationObservation({ identity, description: request.description, declarations: request.observation, resources }, this.capabilities.observations, parent?.observation);
    const changes = !recovering && this.capabilities.changes ? new InvocationChangeEmitter(identity, this.capabilities.changes) : undefined;
    const invocation = new Invocation<Input, Output, CallableContext<Input, Output, Resources>>({
      ...(parent ? { parent: { invocation: parent, key: request.key, declarationPosition: request.declarationPosition } } : {}),
      context,
      construction: request.construction ?? parent?.construction,
      work: request.work,
      checkpoints: this.capabilities.checkpoints,
      restore: request.restore,
      progress: request.progress,
      output: request.output,
      clock: this.capabilities.clock,
      signal: context.signal,
      observation,
      identity,
      description: request.description,
      started: request.started,
      changes,
    });
    attachInvocationResources(invocation, resources);
    return invocation;
  }
}
