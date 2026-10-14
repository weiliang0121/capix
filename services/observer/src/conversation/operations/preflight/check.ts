import { isEqual } from 'es-toolkit/predicate';
import { preflightInputCodec, preflightCodec, childWaitingCodec, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { OperationDefinition, type OperationContextView, type InvocationWorkView, type InvocationCheckpointDefinition, type ChildBindings } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<FilePreflightInput, FilePreflightOutput, OperationContextView<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }>> = {
    key: 'observer.file-preflight',
    version: 1,
    input: preflightInputCodec,
    output: preflightCodec,
    points: {
      inspecting: {
        state: childWaitingCodec,
        check: (frame, state) => {
          originalCheckpoint(frame);
          const child = waitingChild(frame, state, 'inspect', this.inspectDefinition.checkpoint);
          if (frame.children.length !== 1 || !isEqual(child.input, (frame.currentInput as { task: unknown }).task)) throw new Error('Preflight checkpoint changed task');
        },
        resume: {
          requires: {},
          uses: this.children,
          execute: async (context, invocation, children, state: { childId: string }) => {
            const child = children.get(this.inspectDefinition).resume(invocation, state.childId);
            await child.run();
            const output = await children.accept(child, (result) => (result.kind === 'ready' ? { ...result, instruction: context.currentInput.instruction } : result));
            invocation.checkpoint?.save('result', output);
            return output;
          },
        },
      },
      result: {
        state: preflightCodec,
        check: (frame, output) => {
          originalCheckpoint(frame);
          const child = acceptedChild(frame.children[0]);
          if (frame.children.length !== 1 || child.key !== 'inspect' || !isEqual(child.state.reception.output, output)) throw new Error('Preflight checkpoint differs from accepted inspection');
        },
        resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: FilePreflightOutput) => output },
      },
    },
  };
  readonly run = { requires: CheckFileTaskDefinition.requires, uses: this.children, execute: this.execute.bind(this) };

  private async execute(context: OperationContextView<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }>, invocation: InvocationWorkView<FilePreflightInput, FilePreflightOutput, OperationContextView<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }>>, children: ChildBindings): Promise<FilePreflightOutput> {
    const child = children.get(this.inspectDefinition).create(invocation, context.currentInput.task, { key: 'inspect' });
    invocation.checkpoint?.save('inspecting', { childId: child.context.id });
    await child.run();
    const output = await children.accept(child, (result) => (result.kind === 'ready' ? Object.freeze({ ...result, instruction: context.currentInput.instruction }) : result));
    invocation.checkpoint?.save('result', output);
    return output;
  }
}
