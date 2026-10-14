import { OperationDefinition, type OperationContextView, type InvocationWorkView, type ChildBindings, type InvocationCheckpointDefinition, type ChildInvocationView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';
import { CreateTextDefinition, createTextCheckpointInput, fileReceiptCheckpoint, type CreateTextInput } from '../../attempt/files/create.js';
import { checkpointCodec, checkpointChild } from '../../checkpoint.js';
import { isEqual } from 'es-toolkit/predicate';

type SaveContext = OperationContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>;

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
  readonly checkpoint: InvocationCheckpointDefinition<CreateTextInput, FileReceipt, SaveContext> = {
    key: 'observer.save-result',
    version: 1,
    input: createTextCheckpointInput,
    output: fileReceiptCheckpoint,
    points: {
      creationWaiting: {
        state: checkpointCodec(checkpointChild),
        check: (frame, state) => {
          const child = frame.children[0];
          if (frame.round !== 1 || !isEqual(frame.input, frame.currentInput) || frame.children.length !== 1 || !child || child.identity.contextId !== state.childId || child.key !== 'create' || child.contract?.key !== this.createDefinition.checkpoint.key || child.contract.version !== this.createDefinition.checkpoint.version || child.state.kind !== 'waiting' || !isEqual(child.input, frame.currentInput)) throw new Error('File save checkpoint must identify its fixed creation child');
        },
        resume: { requires: SaveResultDefinition.requires, uses: this.children, execute: (_context, invocation, children, state: { childId: string }) => this.receive(children.get(this.createDefinition).resume(invocation, state.childId), children) },
      },
    },
  };

  private async execute(context: SaveContext, invocation: InvocationWorkView<CreateTextInput, FileReceipt, SaveContext>, children: ChildBindings): Promise<FileReceipt> {
    const child = children.get(this.createDefinition).create(invocation, context.currentInput, { key: 'create' });
    invocation.checkpoint?.save('creationWaiting', { childId: child.context.id });
    return this.receive(child, children);
  }

  private async receive(child: ChildInvocationView<CreateTextInput, FileReceipt>, children: ChildBindings): Promise<FileReceipt> {
    const receipt = await child.run();
    return children.accept(child, () => receipt);
  }
}
