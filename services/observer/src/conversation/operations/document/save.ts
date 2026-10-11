import { OperationDefinition, type OperationContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';
import { CreateTextDefinition, type CreateTextInput } from '../../attempt/files/create.js';

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

  private async execute(context: OperationContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>, invocation: InvocationView<CreateTextInput, FileReceipt, OperationContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>>, children: ChildBindings): Promise<FileReceipt> {
    const child = children.get(this.createDefinition).create(invocation, context.currentInput, { key: 'create' });
    const receipt = await child.run();
    return children.accept(child, () => receipt);
  }
}
