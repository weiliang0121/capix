import { Group, checkpointPoint, childReference, type ChildCall, type GroupWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { ModelSettings } from '@capix/protocol';
import { isEqual } from 'es-toolkit';
import { ActiveContentResource, type ActiveContentManager } from '../../content/resource.js';
import type { ActiveContentSnapshot } from '../../content/active.js';
import { describeActiveContent } from '../../content/observation.js';
import { ModelSettingsResource } from '../../model/resources.js';
import { originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { activeContentSnapshotCodec, contextMaintenanceRequestCodec, contextMaintenanceInputCodec, maintenanceAcceptedCodec, maintenanceCompletedCodec } from './checkpoint.js';
import { activeContentSelectionSchema } from './schema.js';
import type { ContextMaintenanceDecision, ContextMaintenanceInput, ContextMaintenanceOperation, ContextMaintenancePolicy, ContextMaintenanceRequest } from './types.js';
export type { ContextMaintenanceConfiguration, ContextMaintenanceFunction, ContextMaintenanceDecision, ContextMaintenanceInput, ContextMaintenanceOperation, ContextMaintenancePolicy, ContextMaintenanceRequest } from './types.js';

interface MaintenanceResources {
  readonly activeContentManager: ActiveContentManager;
  readonly settings: Readonly<ModelSettings>;
}

type MaintenanceWork = GroupWork<ContextMaintenanceRequest, ActiveContentSnapshot, MaintenanceResources>;

/** One explicit maintenance boundary. Its own source writes remain facts, but never recursively schedule itself. */
export class MaintainConversationContent extends Group<ContextMaintenanceRequest, ActiveContentSnapshot, MaintenanceResources> {
  static readonly deps = Object.freeze({ activeContentManager: ActiveContentResource.manage.request(), settings: ModelSettingsResource.snapshot.request() });

  readonly waiting;
  readonly accepted;
  readonly completed;

  constructor(private readonly policy: ContextMaintenancePolicy) {
    super();

    if (typeof policy !== 'function') this.add(policy);
    const deps = MaintainConversationContent.deps;
    const point = checkpointPoint<'group', ContextMaintenanceRequest, ActiveContentSnapshot>();
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

    this.setDefinition({ name: 'maintainContext', label: '维护活跃材料', source: 'services/observer/src/conversation/group/context/maintain.ts · MaintainConversationContent', observation: [invocationRecording<ContextMaintenanceRequest, ActiveContentSnapshot>({ output: describeActiveContent })], deps, uses: this.members, run: this.execute.bind(this), checkpoint: { key: 'observer.maintain-context', version: 1, input: contextMaintenanceRequestCodec, output: activeContentSnapshotCodec, points: this.waiting ? [this.waiting, this.accepted, this.completed] : [this.accepted, this.completed] } });
  }

  private async execute(work: MaintenanceWork): Promise<ActiveContentSnapshot> {
    const input = Object.freeze({ phase: work.input.phase, material: work.resources.activeContentManager.capture(), settings: work.resources.settings });
    if (typeof this.policy === 'function') return this.accept(work, input, await this.policy(input));
    const child = work.children.create(this.policy, input, { key: 'policy' });
    if (this.waiting) work.checkpoint?.({ point: this.waiting, state: input, refs: { child: child.ref } });
    return this.receive(work, child, input);
  }

  private async receive(work: MaintenanceWork, child: ChildCall<ContextMaintenanceOperation>, input: ContextMaintenanceInput): Promise<ActiveContentSnapshot> {
    await child.run();
    const decision = await child.accept((output) => activeContentSelectionSchema.parse(output));
    return this.accept(work, input, decision);
  }

  private accept(work: MaintenanceWork, input: ContextMaintenanceInput, value: ContextMaintenanceDecision): ActiveContentSnapshot {
    const decision = activeContentSelectionSchema.parse(value);
    work.checkpoint?.({ point: this.accepted, state: { input, decision }, refs: {} });
    return this.install(work, input, decision);
  }

  private install(work: MaintenanceWork, input: ContextMaintenanceInput, decision: ContextMaintenanceDecision): ActiveContentSnapshot {
    const material = work.resources.activeContentManager.apply(decision);
    work.checkpoint?.({ point: this.completed, state: { input, decision, material }, refs: {} });
    return material;
  }
}

function checkInstalledDecision(decision: ContextMaintenanceDecision, material: ActiveContentSnapshot): void {
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
