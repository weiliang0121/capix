import { Node, checkpointPoint, type NodeWork } from '@weiliang0121/capix-structure';
import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import type { FileReceipt } from '@weiliang0121/capix-protocol';
import { FileResources, type FileCreator } from '../../../files/index.js';

export interface CreateTextInput {
  readonly path: string;
  readonly text: string;
}
export const createTextCheckpointInput = checkpointCodec(z.strictObject({ path: z.string().min(1), text: z.string() }));
export const fileReceiptCheckpoint = checkpointCodec(z.strictObject({ path: z.string().min(1), bytes: z.int().nonnegative(), digest: z.string().min(1) }));
export class CreateText extends Node<CreateTextInput, FileReceipt, { readonly creator: FileCreator }> {
  static readonly deps = Object.freeze({ creator: FileResources.createText.request() });
  private readonly preparedPoint;

  constructor() {
    super();

    this.preparedPoint = checkpointPoint<'node', CreateTextInput, FileReceipt>()({ name: 'prepared', state: checkpointCodec(z.null()), references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { deps: CreateText.deps, run: (work) => this.create(work) } });

    this.name = 'createText';
    this.label = '保存结果文件';
    this.source = 'services/observer/src/conversation/node/files/create.ts · CreateText';
    this.checkpoint = { key: 'observer.create-text', version: 1, input: createTextCheckpointInput, output: fileReceiptCheckpoint, points: [this.preparedPoint] };
    this.deps = CreateText.deps;
    this.run = (work: NodeWork<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>) => {
      work.checkpoint?.({ point: this.preparedPoint, state: null, refs: {} });
      return this.create(work);
    };
  }

  private create(work: NodeWork<CreateTextInput, FileReceipt, { readonly creator: FileCreator }>): Promise<FileReceipt> {
    return work.resources.creator.createFixed('result', work.input.path, work.input.text);
  }
}
