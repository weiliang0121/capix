import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileAccessException, FileResources, documentDescriptor, type FileReader, type TextDocument } from '../../../files/index.js';

export class ReadTextDefinition extends AttemptDefinition<{ readonly path: string }, TextDocument, { readonly reader: FileReader }> {
  readonly name = 'readText';
  readonly label = '读取文本';
  readonly source = 'services/observer/src/conversation/attempt/files/read.ts · ReadTextDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording<{ readonly path: string }, TextDocument>({ output: documentDescriptor })];
  readonly run = {
    requires: { reader: FileResources.readText.request() },
    execute: (context: AttemptContextView<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>) => context.resources.values.reader.readText(context.currentInput.path, context.signal),
  };
}
