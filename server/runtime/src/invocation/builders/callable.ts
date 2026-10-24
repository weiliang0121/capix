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
import { ResourceSupply } from '../../resource/supply.js';
import type { ResourceRefinement } from '../../resource/offer.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation, type InvocationStarted } from '../invocation.js';
import type { InvocationWork } from '../work.js';
import { CallableContext } from '../../context/callable.js';
import type { InvocationControls } from '../../context/context.js';
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
  readonly supplied?: ResourceSupply;
  readonly requires?: ResourceRequirements<Resources>;
  readonly initial?: ResourceRequirements;
  readonly supply?: ResourceRequirements;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly description?: InvocationDescription;
  readonly work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>;
  readonly started?: CallableInvocationStarted<Input, Output, Resources>;
}

/** One binding installation's construction authority, shared by all its callable positions. */
export class CallableInvocationBuilder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  check(parent: Invocation<unknown, unknown, CallableContext>): void {
    parent.requireActive();
    parent.context.requireActive();
    if (!parent.context.belongsTo(this)) throw new Error('Call belongs to another binding installation');
  }

  restoration<Input, Output, Resources extends object = object>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId?: string): CheckpointRestoration;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId: string | undefined, construct: (restoration: CheckpointRestoration) => Value): Value;
  restoration<Input, Output, Resources extends object, Value>(contextId: string, work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>, kind: CallableKind, parentContextId?: string, construct?: (restoration: CheckpointRestoration) => Value): CheckpointRestoration | Value {
    return prepareCheckpointRestoration(this.capabilities.checkpoints, work.checkpoint, contextId, { kind, ...(parentContextId ? { parentContextId } : {}) }, construct);
  }

  create<Input, Output, Resources extends object = object>(input: Input, request: CallableInvocationRequest<Input, Output, Resources>): Invocation<Input, Output, CallableContext<Input, Output, Resources>> {
    const parent = request.parent;
    if (parent) this.check(parent);
    if (request.supplied && request.resources) throw new Error('Call construction must provide one resource supply');
    const supplied = request.supplied ?? request.resources?.supply ?? parent?.context.resources.supply ?? new ResourceSupply();
    const requires = request.requires ?? ({} as ResourceRequirements<Resources>);
    const selected = supplied.select(request.supply ?? requires).refine(input, request.refinements ?? []);
    const resources = new ResourceBindings(requires, selected.entries, request.initial, request.supply);
    // Resource capture/refinement may run host code; recheck before establishing the child.
    if (parent) this.check(parent);
    const controls = parent ? { signal: parent.context.signal } : request.controls;
    const context = new CallableContext<Input, Output, Resources>(input, request.kind, controls, resources, this);
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
