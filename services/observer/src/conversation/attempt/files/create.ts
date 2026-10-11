import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileAccessException, FileResources, type FileCreator } from '../../../files/index.js';

export interface CreateTextInput {
  readonly path: string;
  readonly text: string;
}
export class CreateTextDefinition extends AttemptDefinition<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  readonly name = 'createText';
  readonly label = '保存结果文件';
  readonly source = 'services/observer/src/conversation/attempt/files/create.ts · CreateTextDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording<CreateTextInput, FileReceipt>({ input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) })];
  readonly run = {
    requires: { creator: FileResources.createText.request() },
    execute: (context: AttemptContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>) => context.resources.values.creator.createText(context.currentInput.path, context.currentInput.text, context.signal),
  };
}
