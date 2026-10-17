import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult, textDocumentCodec } from '../../operations/checkpoint.js';
import { AttemptDefinition, checkpointPoint, type InvocationCheckpointDefinition, type AttemptWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileAccessException, FileResources, documentDescriptor, type FileReader, type TextDocument } from '../../../files/index.js';

export class ReadTextDefinition extends AttemptDefinition<{ readonly path: string }, TextDocument, { readonly reader: FileReader }> {
  readonly name = 'readText';
  readonly label = '读取文本';
  readonly source = 'services/observer/src/conversation/attempt/files/read.ts · ReadTextDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording<{ readonly path: string }, TextDocument>({ output: documentDescriptor })];
  private readonly resultPoint = checkpointPoint<'attempt', { readonly path: string }, TextDocument>()({ name: 'result', state: textDocumentCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  readonly checkpoint: InvocationCheckpointDefinition<{ readonly path: string }, TextDocument, 'attempt'> = { key: 'observer.read-text', version: 1, input: checkpointCodec(z.strictObject({ path: z.string().min(1) })), output: textDocumentCodec, points: [this.resultPoint] };
  readonly run = {
    requires: { reader: FileResources.readText.request() },
    execute: async (work: AttemptWork<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>) => {
      const result = await work.resources.reader.readText(work.input.path, work.signal);
      work.checkpoint?.save(this.resultPoint, result, {});
      return result;
    },
  };
}
