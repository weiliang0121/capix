import { Group, checkpointPoint, childReference, type ChildCall, type GroupWork } from '@weiliang0121/capix-structure';
import type { ModelSettings } from '@weiliang0121/capix-protocol';
import { isEqual } from 'es-toolkit';
import { ActiveViewResource, type ActiveViewManager } from '@capix/observer-content';
import type { ActiveViewSnapshot } from '@capix/observer-content';
import { ModelSettingsResource } from '../../model/resources.js';
import { originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { activeViewSnapshotCodec, contextMaintenanceRequestCodec, contextMaintenanceInputCodec, maintenanceAcceptedCodec, maintenanceCompletedCodec } from './checkpoint.js';
import { activeViewSelectionSchema } from './schema.js';
import type { ContextMaintenanceDecision, ContextMaintenanceInput, ContextMaintenanceOperation, ContextMaintenancePolicy, ContextMaintenanceRequest } from './types.js';
export type { ContextMaintenanceConfiguration, ContextMaintenanceFunction, ContextMaintenanceDecision, ContextMaintenanceInput, ContextMaintenanceOperation, ContextMaintenancePolicy, ContextMaintenanceRequest } from './types.js';

interface MaintenanceResources {
  readonly activeViewManager: ActiveViewManager;
  readonly settings: Readonly<ModelSettings>;
}

type MaintenanceWork = GroupWork<ContextMaintenanceRequest, ActiveViewSnapshot, MaintenanceResources>;

/** One explicit maintenance boundary. Its own source writes remain facts, but never recursively schedule itself. */
export class MaintainConversationContent extends Group<ContextMaintenanceRequest, ActiveViewSnapshot, MaintenanceResources> {
  static readonly deps = Object.freeze({ activeViewManager: ActiveViewResource.manage.request(), settings: ModelSettingsResource.snapshot.request() });

  readonly waiting;
  readonly accepted;
  readonly completed;

  constructor(private readonly policy: ContextMaintenancePolicy) {
    super();

    if (typeof policy !== 'function') this.add(policy);
    const deps = MaintainConversationContent.deps;
    const point = checkpointPoint<'group', ContextMaintenanceRequest, ActiveViewSnapshot>();
    this.waiting =
      typeof policy === 'function' || !policy.checkpoint
        ? undefined
        : point({
            name: 'waiting',
            state: contextMaintenanceInputCodec,
            references: { child: childReference(policy) },
            check: (input, facts) => {
              originalCheckpoint(facts);
              const child = waitingChild(facts, facts.references.child, 'policy');
              if (facts.children.values().length !== 1 || input.phase !== facts.input.phase || !isEqual(child.input, input)) throw new Error('Maintenance checkpoint changed its policy input');
            },
            resume: { deps, uses: [policy], run: (work, input, saved) => this.receive(work, work.children.resume(saved.child), input) },
          });
    this.accepted = point({
      name: 'accepted',
      state: maintenanceAcceptedCodec,
      references: {},
      check: (state, facts) => {
        originalCheckpoint(facts);
        if (state.input.phase !== facts.input.phase) throw new Error('Maintenance checkpoint changed its phase');
        if (typeof policy === 'function') {
          if (facts.children.values().length) throw new Error('Function maintenance cannot contain child calls');
        } else {
          const child = acceptedChild(facts.children.requireUnique(policy, { parentRound: 1 }));
          if (facts.children.values().length !== 1 || child.key !== 'policy' || !isEqual(child.input, state.input) || !isEqual(child.reception.value, state.decision)) throw new Error('Maintenance checkpoint changed the accepted policy decision');
        }
      },
      // No fixed-effect receipt exists for this index yet. A changed basis is refused, even if the target happens to match.
      resume: { deps: MaintainConversationContent.deps, run: (work, state) => this.install(work, state.input, state.decision) },
    });
    this.completed = point({
      name: 'completed',
      state: maintenanceCompletedCodec,
      references: {},
      check: (state, facts) => {
        originalCheckpoint(facts);
        if (state.input.phase !== facts.input.phase) throw new Error('Maintenance checkpoint changed its phase');
        checkInstalledDecision(state.decision, state.material);
        if (typeof policy === 'function') {
          if (facts.children.values().length) throw new Error('Function maintenance cannot contain child calls');
        } else {
          const child = acceptedChild(facts.children.requireUnique(policy, { parentRound: 1 }));
          if (facts.children.values().length !== 1 || child.key !== 'policy' || !isEqual(child.input, state.input) || !isEqual(child.reception.value, state.decision)) throw new Error('Maintenance result differs from the accepted policy decision');
        }
      },
      resume: { run: (_work, state) => state.material },
    });

    this.name = 'maintainContext';
    this.label = '维护活跃材料';
    this.source = 'services/observer/src/conversation/group/context/maintain.ts · MaintainConversationContent';
    this.deps = deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.maintain-context', version: 1, input: contextMaintenanceRequestCodec, output: activeViewSnapshotCodec, points: this.waiting ? [this.waiting, this.accepted, this.completed] : [this.accepted, this.completed] };
  }

  private async execute(work: MaintenanceWork): Promise<ActiveViewSnapshot> {
    const input = Object.freeze({ phase: work.input.phase, material: work.resources.activeViewManager.capture(), settings: work.resources.settings });
    if (typeof this.policy === 'function') return this.acceptDecision(work, input, await this.policy(input));
    const child = work.children.create(this.policy, input, { key: 'policy' });
    if (this.waiting) work.checkpoint?.({ point: this.waiting, state: input, refs: { child: child.ref } });
    return this.receive(work, child, input);
  }

  private async receive(work: MaintenanceWork, child: ChildCall<ContextMaintenanceOperation>, input: ContextMaintenanceInput): Promise<ActiveViewSnapshot> {
    const decision = await child.invoke({ result: { succeeded: (output) => activeViewSelectionSchema.parse(output) } });
    return this.acceptDecision(work, input, decision);
  }

  private acceptDecision(work: MaintenanceWork, input: ContextMaintenanceInput, value: ContextMaintenanceDecision): ActiveViewSnapshot {
    const decision = activeViewSelectionSchema.parse(value);
    work.checkpoint?.({ point: this.accepted, state: { input, decision }, refs: {} });
    return this.install(work, input, decision);
  }

  private install(work: MaintenanceWork, input: ContextMaintenanceInput, decision: ContextMaintenanceDecision): ActiveViewSnapshot {
    const material = work.resources.activeViewManager.apply(decision);
    work.checkpoint?.({ point: this.completed, state: { input, decision, material }, refs: {} });
    return material;
  }
}

function checkInstalledDecision(decision: ContextMaintenanceDecision, material: ActiveViewSnapshot): void {
  const before = decision.basis;
  const after = material.basis;
  if (
    after.transcriptId !== before.transcriptId ||
    after.memoriesId !== before.memoriesId ||
    after.transcriptRevision !== before.transcriptRevision ||
    after.memorySequence !== before.memorySequence ||
    (after.indexRevision !== before.indexRevision && after.indexRevision !== before.indexRevision + 1) ||
    !isEqual(
      material.messages.map((item) => item.index),
      decision.messageIndexes,
    ) ||
    !isEqual(
      material.memories.map((memory) => memory.id),
      decision.memoryIds,
    )
  )
    throw new Error('Maintenance checkpoint differs from its installed index');
}
