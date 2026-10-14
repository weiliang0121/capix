import { AttemptDefinition, type AttemptContextView, type InvocationWorkView, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult } from '../../operations/checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileAccessException, FileResources, type FileCreator } from '../../../files/index.js';

export interface CreateTextInput {
  readonly path: string;
  readonly text: string;
}
export const createTextCheckpointInput = checkpointCodec(z.strictObject({ path: z.string().min(1), text: z.string() }));
export const fileReceiptCheckpoint = checkpointCodec(z.strictObject({ path: z.string().min(1), bytes: z.int().nonnegative(), digest: z.string().min(1) }));
export class CreateTextDefinition extends AttemptDefinition<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  readonly name = 'createText';
  readonly label = '保存结果文件';
  readonly source = 'services/observer/src/conversation/attempt/files/create.ts · CreateTextDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording<CreateTextInput, FileReceipt>({ input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) })];
  static readonly requires = Object.freeze({ creator: FileResources.createText.request() });
  readonly checkpoint: InvocationCheckpointDefinition<CreateTextInput, FileReceipt, AttemptContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>> = {
    key: 'observer.create-text',
    version: 1,
    input: createTextCheckpointInput,
    output: fileReceiptCheckpoint,
    points: { prepared: { state: checkpointCodec(z.null()), check: checkLeafResult, resume: { requires: CreateTextDefinition.requires, uses: [], execute: (context) => this.create(context) } } },
  };
  readonly run = {
    requires: CreateTextDefinition.requires,
    execute: (context: AttemptContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>, invocation: InvocationWorkView<CreateTextInput, FileReceipt, AttemptContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>>) => {
      invocation.checkpoint?.save('prepared', null);
      return this.create(context);
    },
  };
  private create(context: AttemptContextView<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>): Promise<FileReceipt> {
    return context.resources.values.creator.createFixed('result', context.currentInput.path, context.currentInput.text, context.signal);
  }
}
