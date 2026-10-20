import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';
import { CreateText, createTextCheckpointInput, fileReceiptCheckpoint, type CreateTextInput } from '../../node/files/create.js';
import { emptyCheckpointState, originalCheckpoint, waitingChild } from '../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';

/** Persist an already accepted answer. Saving never regenerates or appends the answer. */
export class SaveResult extends Group<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  readonly createText;

  static readonly requires = Object.freeze({ creator: FileResources.createText.request() });

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
      resume: { uses: this.members, execute: (work, _state, saved) => this.receive(work.children.resume(saved.child)) },
    });

    this.setDefinition({ name: 'saveResult', label: '保存结果', source: 'services/observer/src/conversation/group/document/save.ts · SaveResult', observation: [invocationRecording<CreateTextInput, FileReceipt>({ input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) })], run: { requires: SaveResult.requires, uses: this.members, execute: this.execute.bind(this) }, checkpoint: { key: 'observer.save-result', version: 2, input: createTextCheckpointInput, output: fileReceiptCheckpoint, points: [this.creationWaiting] } });
  }

  private async execute(work: GroupWork<CreateTextInput, FileReceipt, object>): Promise<FileReceipt> {
    const child = work.children.create(this.createText, work.input, { key: 'create' });
    work.checkpoint?.save(this.creationWaiting, null, { child: child.ref });
    return this.receive(child);
  }
  private async receive(child: ChildCall<CreateText>): Promise<FileReceipt> {
    await child.run();
    return child.accept();
  }
}
