import { checkLeafResult, inspectionCodec, fileTaskCodec } from '../../operations/checkpoint.js';
import { AttemptDefinition, checkpointPoint, type InvocationCheckpointDefinition, type AttemptWork } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { FileTask } from '@capix/protocol';
import { FileAccessException, FileResources, type FileInspector, type FileTaskInspection } from '../../../files/index.js';

/** Named-path facts only. This attempt does not read text, reserve a path, or write a file. */
export class InspectFileTaskDefinition extends AttemptDefinition<FileTask, FileTaskInspection, { readonly inspector: FileInspector }> {
  readonly name = 'inspectFileTask';
  readonly label = '检查文件条件';
  readonly source = 'services/observer/src/conversation/attempt/files/check.ts · InspectFileTaskDefinition';
  readonly callee = 'filesystem';
  readonly raises = [FileAccessException];
  readonly observation = [invocationRecording()];
  private readonly resultPoint = checkpointPoint<'attempt', FileTask, FileTaskInspection>()({ name: 'result', state: inspectionCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  readonly checkpoint: InvocationCheckpointDefinition<FileTask, FileTaskInspection, 'attempt'> = { key: 'observer.inspect-file', version: 1, input: fileTaskCodec, output: inspectionCodec, points: [this.resultPoint] };
  readonly run = {
    requires: { inspector: FileResources.inspect.request() },
    execute: async (work: AttemptWork<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>) => {
      const result = await work.resources.inspector.inspect(work.input, work.signal);
      work.checkpoint?.save(this.resultPoint, result, {});
      return result;
    },
  };
}
