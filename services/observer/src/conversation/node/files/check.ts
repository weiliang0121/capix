import { checkLeafResult, inspectionCodec, fileTaskCodec } from '../../group/checkpoint.js';
import { Node, checkpointPoint, type NodeWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileTask } from '@capix/protocol';
import { FileAccessException, FileResources, type FileInspector, type FileTaskInspection } from '../../../files/index.js';

/** Named-path facts only. This attempt does not read text, reserve a path, or write a file. */
export class InspectFileTask extends Node<FileTask, FileTaskInspection, { readonly inspector: FileInspector }> {
  private readonly resultPoint;

  constructor() {
    super();

    this.resultPoint = checkpointPoint<'node', FileTask, FileTaskInspection>()({ name: 'result', state: inspectionCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });

    this.setDefinition({
      name: 'inspectFileTask',
      label: '检查文件条件',
      source: 'services/observer/src/conversation/node/files/check.ts · InspectFileTask',
      callee: 'filesystem',
      raises: [FileAccessException],
      observation: [invocationRecording()],
      checkpoint: { key: 'observer.inspect-file', version: 1, input: fileTaskCodec, output: inspectionCodec, points: [this.resultPoint] },
      run: {
        requires: { inspector: FileResources.inspect.request() },
        execute: async (work: NodeWork<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>) => {
          const result = await work.resources.inspector.inspect(work.input, work.signal);
          work.checkpoint?.save(this.resultPoint, result, {});
          return result;
        },
      },
    });
  }
}
