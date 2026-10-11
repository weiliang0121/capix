import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';
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
  readonly run = {
    requires: { inspector: FileResources.inspect.request() },
    execute: (context: AttemptContextView<FileTask, FileTaskInspection, { readonly inspector: FileInspector }>) => context.resources.values.inspector.inspect(context.currentInput, context.signal),
  };
}
