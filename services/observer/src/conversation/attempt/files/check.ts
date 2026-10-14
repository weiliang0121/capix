import { checkLeafResult, inspectionCodec, fileTaskCodec } from '../../operations/checkpoint.js';
import { AttemptDefinition, type InvocationCheckpointDefinition, type InvocationWorkView, type AttemptContextView } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<FileTask, FileTaskInspection, AttemptContextView<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>> = {
    key: 'observer.inspect-file',
    version: 1,
    input: fileTaskCodec,
    output: inspectionCodec,
    points: { result: { state: inspectionCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: FileTaskInspection) => result } } },
  };
  readonly run = {
    requires: { inspector: FileResources.inspect.request() },
    execute: async (context: AttemptContextView<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>, invocation: InvocationWorkView<FileTask, FileTaskInspection, AttemptContextView<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>>) => {
      const result = await context.resources.values.inspector.inspect(context.currentInput, context.signal);
      invocation.checkpoint?.save('result', result);
      return result;
    },
  };
}
