import { OperationDefinition, checkpointPoint, childReference, type OperationWork, type ChildCall } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';
import { CreateTextDefinition, createTextCheckpointInput, fileReceiptCheckpoint, type CreateTextInput } from '../../attempt/files/create.js';
import { emptyCheckpointState, originalCheckpoint, waitingChild } from '../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';

/** Persist an already accepted answer. Saving never regenerates or appends the answer. */
export class SaveResultDefinition extends OperationDefinition<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  readonly name = 'saveResult';
  readonly label = '保存结果';
  readonly source = 'services/observer/src/conversation/operations/document/save.ts · SaveResultDefinition';
  readonly observation = [invocationRecording<CreateTextInput, FileReceipt>({ input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) })];
  readonly createDefinition = new CreateTextDefinition();
  readonly children = [this.createDefinition];
  static readonly requires = Object.freeze({ creator: FileResources.createText.request() });
  readonly run = { requires: SaveResultDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  readonly creationWaiting = checkpointPoint<'operation', CreateTextInput, FileReceipt>()({
    name: 'creationWaiting',
    state: emptyCheckpointState,
    references: { child: childReference(this.createDefinition) },
    check: (_state, facts) => {
      originalCheckpoint(facts);
      const child = waitingChild(facts, facts.references.child, 'create');
      if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input)) throw new Error('File save checkpoint must identify its fixed creation child');
    },
    resume: { uses: this.children, execute: (work, _state, saved) => this.receive(work.children.resume(saved.child)) },
  });
  readonly checkpoint = { key: 'observer.save-result', version: 2, input: createTextCheckpointInput, output: fileReceiptCheckpoint, points: [this.creationWaiting] };

  private async execute(work: OperationWork<CreateTextInput, FileReceipt, object>): Promise<FileReceipt> {
    const child = work.children.create(this.createDefinition, work.input, { key: 'create' });
    work.checkpoint?.save(this.creationWaiting, null, { child: child.ref });
    return this.receive(child);
  }
  private async receive(child: ChildCall<CreateTextDefinition>): Promise<FileReceipt> {
    await child.run();
    return child.accept();
  }
}
