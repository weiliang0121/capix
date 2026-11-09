import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall } from '@weiliang0121/capix-structure';
import type { FileReceipt } from '@weiliang0121/capix-protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';
import { CreateText, createTextCheckpointInput, fileReceiptCheckpoint, type CreateTextInput } from '../../node/files/create.js';
import { emptyCheckpointState, originalCheckpoint, waitingChild } from '../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';

/** Persist an already accepted answer. Saving never regenerates or appends the answer. */
export class SaveResult extends Group<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  readonly createText;

  static readonly deps = Object.freeze({ creator: FileResources.createText.request() });

  readonly creationWaiting;

  constructor() {
    super();

    this.createText = new CreateText();
    this.add(this.createText);

    this.creationWaiting = checkpointPoint<'group', CreateTextInput, FileReceipt>()({
      name: 'creationWaiting',
      state: emptyCheckpointState,
      references: { child: childReference(this.createText) },
      check: (_state, facts) => {
        originalCheckpoint(facts);
        const child = waitingChild(facts, facts.references.child, 'create');
        if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input)) throw new Error('File save checkpoint must identify its fixed creation child');
      },
      resume: { uses: this.members, run: (work, _state, saved) => this.receive(work.children.resume(saved.child)) },
    });

    this.name = 'saveResult';
    this.label = '保存结果';
    this.source = 'services/observer/src/conversation/group/document/save.ts · SaveResult';
    this.deps = SaveResult.deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.save-result', version: 2, input: createTextCheckpointInput, output: fileReceiptCheckpoint, points: [this.creationWaiting] };
  }

  private async execute(work: GroupWork<CreateTextInput, FileReceipt, object>): Promise<FileReceipt> {
    const child = work.children.create(this.createText, work.input, { key: 'create' });
    work.checkpoint?.({ point: this.creationWaiting, state: null, refs: { child: child.ref } });
    return this.receive(child);
  }
  private async receive(child: ChildCall<CreateText>): Promise<FileReceipt> {
    return child.invoke();
  }
}
