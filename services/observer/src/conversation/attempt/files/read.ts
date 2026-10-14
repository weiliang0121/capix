import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult, textDocumentCodec } from '../../operations/checkpoint.js';
import { AttemptDefinition, type InvocationCheckpointDefinition, type InvocationWorkView, type AttemptContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileAccessException, FileResources, documentDescriptor, type FileReader, type TextDocument } from '../../../files/index.js';

export class ReadTextDefinition extends AttemptDefinition<{ readonly path: string }, TextDocument, { readonly reader: FileReader }> {
  readonly name = 'readText';
  readonly label = '读取文本';
  readonly source = 'services/observer/src/conversation/attempt/files/read.ts · ReadTextDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording<{ readonly path: string }, TextDocument>({ output: documentDescriptor })];
  readonly checkpoint: InvocationCheckpointDefinition<{ readonly path: string }, TextDocument, AttemptContextView<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>> = {
    key: 'observer.read-text',
    version: 1,
    input: checkpointCodec(z.strictObject({ path: z.string().min(1) })),
    output: textDocumentCodec,
    points: { result: { state: textDocumentCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: TextDocument) => result } } },
  };
  readonly run = {
    requires: { reader: FileResources.readText.request() },
    execute: async (context: AttemptContextView<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>, invocation: InvocationWorkView<{ readonly path: string }, TextDocument, AttemptContextView<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>>) => {
      const result = await context.resources.values.reader.readText(context.currentInput.path, context.signal);
      invocation.checkpoint?.save('result', result);
      return result;
    },
  };
}
