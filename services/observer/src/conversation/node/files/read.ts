import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { checkLeafResult, textDocumentCodec } from '../../group/checkpoint.js';
import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import { FileResources, type FileReader, type TextDocument } from '../../../files/index.js';

export class ReadText extends Node<{ readonly path: string }, TextDocument, { readonly reader: FileReader }> {
  private readonly resultPoint;

  constructor() {
    super();

    this.resultPoint = checkpointPoint<'node', { readonly path: string }, TextDocument>()({ name: 'result', state: textDocumentCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, result) => result } });

    this.name = 'readText';
    this.label = '读取文本';
    this.source = 'services/observer/src/conversation/node/files/read.ts · ReadText';
    this.checkpoint = { key: 'observer.read-text', version: 1, input: checkpointCodec(z.strictObject({ path: z.string().min(1) })), output: textDocumentCodec, points: [this.resultPoint] };
    this.deps = { reader: FileResources.readText.request() };
    this.run = async (work: NodeWork<{ readonly path: string }, TextDocument, { readonly reader: FileReader }>) => {
      const result = await work.resources.reader.readText(work.input.path);
      work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
      return result;
    };
  }
}
