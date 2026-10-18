import { OperationDefinition, checkpointPoint, childReference, type ChildCall, type OperationWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { isEqual } from 'es-toolkit';
import { ActiveContentResource, type ActiveContentReader } from '../../content/resource.js';
import type { ActiveContentSnapshot } from '../../content/active.js';
import { describeActiveContent, describePreparedConversationContext } from '../../content/observation.js';
import type { AcceptedConversationInput } from '../../accept.js';
import { acceptedCheckpointInput } from '../../checkpoint.js';
import { emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { preparedConversationContextCodec } from './checkpoint.js';
import type { PreparedConversationContext } from './types.js';
export type { PreparedConversationContext } from './types.js';
import type { MaintainConversationContentDefinition } from './maintain.js';

interface PreparationResources {
  readonly activeContent: ActiveContentReader;
}

type PreparationWork = OperationWork<AcceptedConversationInput, PreparedConversationContext, PreparationResources>;

/** Capture current material after optional maintenance; creation of E does not fix these values. */
export class PrepareConversationContextDefinition extends OperationDefinition<AcceptedConversationInput, PreparedConversationContext, PreparationResources> {
  readonly name = 'prepareContext';
  readonly label = '准备对话材料';
  readonly source = 'services/observer/src/conversation/operations/context/prepare.ts · PrepareConversationContextDefinition';
  readonly observation = [invocationRecording<AcceptedConversationInput, PreparedConversationContext>({ output: describePreparedConversationContext, relationAccepted: (output, relation) => (relation.key === 'maintenance' ? describeActiveContent(output as ActiveContentSnapshot) : output) })];
  static readonly requires = Object.freeze({ activeContent: ActiveContentResource.read.request() });
  readonly children;
  readonly run;
  readonly checkpoint;
  readonly waiting;
  readonly completed;

  constructor(readonly maintenance?: MaintainConversationContentDefinition) {
    super();
    this.children = Object.freeze(maintenance ? [maintenance] : []);
    const requires = Object.freeze({ ...maintenance?.run.requires, ...PrepareConversationContextDefinition.requires });
    const point = checkpointPoint<'operation', AcceptedConversationInput, PreparedConversationContext>();
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
          resume: { requires, uses: this.children, execute: (work, _state, saved) => this.receive(work, work.children.resume(saved.child)) },
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
      resume: { execute: (_work, output) => output },
    });
    this.checkpoint = { key: 'observer.prepare-context', version: 1, input: acceptedCheckpointInput, output: preparedConversationContextCodec, points: this.waiting ? [this.waiting, this.completed] : [this.completed] };
    this.run = { requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(work: PreparationWork): Promise<PreparedConversationContext> {
    if (!this.maintenance) return this.capture(work);
    const child = work.children.create(this.maintenance, { phase: 'before-request' }, { key: 'maintenance' });
    if (this.waiting) work.checkpoint?.save(this.waiting, null, { child: child.ref });
    return this.receive(work, child);
  }

  private async receive(work: PreparationWork, child: ChildCall<MaintainConversationContentDefinition>): Promise<PreparedConversationContext> {
    await child.run();
    await child.accept();
    return this.capture(work);
  }

  private capture(work: PreparationWork): PreparedConversationContext {
    const output = prepareMaterial(work.input, work.resources.activeContent.capture());
    work.checkpoint?.save(this.completed, output, {});
    return output;
  }
}

function prepareMaterial(input: AcceptedConversationInput, material: ActiveContentSnapshot): PreparedConversationContext {
  const selectedMessages = Object.freeze(material.messages.filter((item) => item.index !== input.messageIndex));
  return Object.freeze({ material, context: Object.freeze({ message: input.message, selectedMessages }), selection: Object.freeze({ historyIndexes: Object.freeze(selectedMessages.map((item) => item.index)) }) });
}
