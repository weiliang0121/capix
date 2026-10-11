import { OperationDefinition, type OperationContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileResources, type FileInspector } from '../../../files/index.js';
import { InspectFileTaskDefinition } from '../../attempt/files/check.js';
import type { FilePreflightInput, FilePreflightOutput } from './types.js';

export class CheckFileTaskDefinition extends OperationDefinition<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }> {
  readonly name = 'checkFileTask';
  readonly label = '预检文件任务';
  readonly source = 'services/observer/src/conversation/operations/preflight/check.ts · CheckFileTaskDefinition';
  readonly observation = [invocationRecording()];
  readonly inspectDefinition = new InspectFileTaskDefinition();
  readonly children = [this.inspectDefinition];
  static readonly requires = Object.freeze({ inspector: FileResources.inspect.request() });
  readonly run = { requires: CheckFileTaskDefinition.requires, uses: this.children, execute: this.execute.bind(this) };

  private async execute(context: OperationContextView<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }>, invocation: InvocationView<FilePreflightInput, FilePreflightOutput, OperationContextView<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }>>, children: ChildBindings): Promise<FilePreflightOutput> {
    const child = children.get(this.inspectDefinition).create(invocation, context.currentInput.task, { key: 'inspect' });
    await child.run();
    return children.accept(child, (result) => (result.kind === 'ready' ? Object.freeze({ ...result, instruction: context.currentInput.instruction }) : result));
  }
}
