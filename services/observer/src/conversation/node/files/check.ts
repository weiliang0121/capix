import { checkLeafResult, inspectionCodec, fileTaskCodec } from '../../group/checkpoint.js';
import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import type { FileTask } from '@capix/protocol';
import { FileResources, type FileInspector, type FileTaskInspection } from '../../../files/index.js';

/** Named-path facts only. This attempt does not read text, reserve a path, or write a file. */
export class InspectFileTask extends Node<FileTask, FileTaskInspection, { readonly inspector: FileInspector }> {
  private readonly resultPoint;

  constructor() {
    super();

    this.resultPoint = checkpointPoint<'node', FileTask, FileTaskInspection>()({ name: 'result', state: inspectionCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, result) => result } });

    this.name = 'inspectFileTask';
    this.label = '检查文件条件';
    this.source = 'services/observer/src/conversation/node/files/check.ts · InspectFileTask';
    this.checkpoint = { key: 'observer.inspect-file', version: 1, input: fileTaskCodec, output: inspectionCodec, points: [this.resultPoint] };
    this.deps = { inspector: FileResources.inspect.request() };
    this.run = async (work: NodeWork<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>) => {
      const result = await work.resources.inspector.inspect(work.input);
      work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
      return result;
    };
  }
}
