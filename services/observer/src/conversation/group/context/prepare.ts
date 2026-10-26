import { Group, checkpointPoint, childReference, type ChildCall, type GroupWork } from '@capix/structure';
import { isEqual } from 'es-toolkit';
import { ActiveViewResource, type ActiveViewReader } from '@capix/observer-content';
import type { ActiveViewSnapshot } from '@capix/observer-content';
import type { AcceptedConversationInput } from '../../accept.js';
import { acceptedCheckpointInput } from '../../checkpoint.js';
import { emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { preparedConversationContextCodec } from './checkpoint.js';
import type { PreparedConversationContext } from './types.js';
export type { PreparedConversationContext } from './types.js';
import type { MaintainConversationContent } from './maintain.js';

interface PreparationResources {
  readonly activeView: ActiveViewReader;
}

type PreparationWork = GroupWork<AcceptedConversationInput, PreparedConversationContext, PreparationResources>;

/** Capture current material after optional maintenance; creation of E does not fix these values. */
export class PrepareConversationContext extends Group<AcceptedConversationInput, PreparedConversationContext, PreparationResources> {
  static readonly deps = Object.freeze({ activeView: ActiveViewResource.read.request() });

  readonly waiting;
  readonly completed;

  constructor(readonly maintenance?: MaintainConversationContent) {
    super();

    if (maintenance) this.add(maintenance);
    const deps = PrepareConversationContext.deps;
    const point = checkpointPoint<'group', AcceptedConversationInput, PreparedConversationContext>();
    this.waiting = maintenance
      ? point({
          name: 'waiting',
          state: emptyCheckpointState,
          references: { child: childReference(maintenance) },
          check: (_state, facts) => {
            originalCheckpoint(facts);
            const child = waitingChild(facts, facts.references.child, 'maintenance');
            if (facts.children.values().length !== 1 || child.input.phase !== 'before-request') throw new Error('Preparation checkpoint changed maintenance');
          },
          resume: { deps, uses: this.members, run: (work, _state, saved) => this.receive(work, work.children.resume(saved.child)) },
        })
      : undefined;
    this.completed = point({
      name: 'completed',
      state: preparedConversationContextCodec,
      references: {},
      check: (output, facts) => {
        originalCheckpoint(facts);
        if (!isEqual(output, prepareMaterial(facts.input, output.material))) throw new Error('Prepared checkpoint changed its captured material');
        if (maintenance) {
          const child = acceptedChild(facts.children.requireUnique(maintenance, { parentRound: 1 }));
          if (facts.children.values().length !== 1 || child.key !== 'maintenance' || child.input.phase !== 'before-request') throw new Error('Prepared checkpoint has no accepted maintenance');
        } else if (facts.children.values().length) throw new Error('Unconfigured maintenance cannot create calls');
      },
      resume: { run: (_work, output) => output },
    });

    this.name = 'prepareContext';
    this.label = '准备对话材料';
    this.source = 'services/observer/src/conversation/group/context/prepare.ts · PrepareConversationContext';
    this.deps = deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.prepare-context', version: 1, input: acceptedCheckpointInput, output: preparedConversationContextCodec, points: this.waiting ? [this.waiting, this.completed] : [this.completed] };
  }

  private async execute(work: PreparationWork): Promise<PreparedConversationContext> {
    if (!this.maintenance) return this.capture(work);
    const child = work.children.create(this.maintenance, { phase: 'before-request' }, { key: 'maintenance' });
    if (this.waiting) work.checkpoint?.({ point: this.waiting, state: null, refs: { child: child.ref } });
    return this.receive(work, child);
  }

  private async receive(work: PreparationWork, child: ChildCall<MaintainConversationContent>): Promise<PreparedConversationContext> {
    await child.invoke();
    return this.capture(work);
  }

  private capture(work: PreparationWork): PreparedConversationContext {
    const output = prepareMaterial(work.input, work.resources.activeView.capture());
    work.checkpoint?.({ point: this.completed, state: output, refs: {} });
    return output;
  }
}

function prepareMaterial(input: AcceptedConversationInput, material: ActiveViewSnapshot): PreparedConversationContext {
  const selectedMessages = Object.freeze(material.messages.filter((item) => item.index !== input.messageIndex));
  return Object.freeze({ material, context: Object.freeze({ message: input.message, selectedMessages }), selection: Object.freeze({ historyIndexes: Object.freeze(selectedMessages.map((item) => item.index)) }) });
}
