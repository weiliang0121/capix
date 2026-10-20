import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileReceipt } from '@capix/protocol';
import { FileAccessException, FileResources, type FileCreator } from '../../../files/index.js';

export interface CreateTextInput {
  readonly path: string;
  readonly text: string;
}
export const createTextCheckpointInput = checkpointCodec(z.strictObject({ path: z.string().min(1), text: z.string() }));
export const fileReceiptCheckpoint = checkpointCodec(z.strictObject({ path: z.string().min(1), bytes: z.int().nonnegative(), digest: z.string().min(1) }));
export class CreateText extends Node<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  static readonly requires = Object.freeze({ creator: FileResources.createText.request() });
  private readonly preparedPoint;

  constructor() {
    super();

    this.preparedPoint = checkpointPoint<'node', CreateTextInput, FileReceipt>()({ name: 'prepared', state: checkpointCodec(z.null()), references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { requires: CreateText.requires, execute: (work) => this.create(work) } });

    this.setDefinition({
      name: 'createText',
      label: '保存结果文件',
      source: 'services/observer/src/conversation/node/files/create.ts · CreateText',
      callee: 'filesystem',
      raises: [FileAccessException],
      observation: [invocationRecording<CreateTextInput, FileReceipt>({ input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) })],
      checkpoint: { key: 'observer.create-text', version: 1, input: createTextCheckpointInput, output: fileReceiptCheckpoint, points: [this.preparedPoint] },
      run: {
        requires: CreateText.requires,
        execute: (work: NodeWork<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>) => {
          work.checkpoint?.save(this.preparedPoint, null, {});
          return this.create(work);
        },
      },
    });
  }

  private create(work: NodeWork<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>): Promise<FileReceipt> {
    return work.resources.creator.createFixed('result', work.input.path, work.input.text, work.signal);
  }
}
