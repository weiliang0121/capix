import { isEqual } from 'es-toolkit/predicate';
import { preflightInputCodec, preflightCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { OperationDefinition, checkpointPoint, childReference, type OperationWork, type ChildCall } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileResources, type FileInspector } from '../../../files/index.js';
import { InspectFileTaskDefinition } from '../../attempt/files/check.js';
import type { FilePreflightInput, FilePreflightOutput } from './types.js';

type PreflightWork = OperationWork<FilePreflightInput, FilePreflightOutput, object>;

export class CheckFileTaskDefinition extends OperationDefinition<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }> {
  readonly name = 'checkFileTask';
  readonly label = '预检文件任务';
  readonly source = 'services/observer/src/conversation/operations/preflight/check.ts · CheckFileTaskDefinition';
  readonly observation = [invocationRecording()];
  readonly inspectDefinition = new InspectFileTaskDefinition();
  readonly children = [this.inspectDefinition];
  static readonly requires = Object.freeze({ inspector: FileResources.inspect.request() });
  readonly inspecting = checkpointPoint<'operation', FilePreflightInput, FilePreflightOutput>()({
    name: 'inspecting',
    state: emptyCheckpointState,
    references: { child: childReference(this.inspectDefinition) },
    check: (_state, facts) => {
      originalCheckpoint(facts);
      const child = waitingChild(facts, facts.references.child, 'inspect');
      if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input.task)) throw new Error('Preflight checkpoint changed task');
    },
    resume: { uses: this.children, execute: (work, _state, saved) => this.receive(work, work.children.resume(saved.child)) },
  });
  readonly result = checkpointPoint<'operation', FilePreflightInput, FilePreflightOutput>()({
    name: 'result',
    state: preflightCodec,
    references: {},
    check: (output, facts) => {
      originalCheckpoint(facts);
      const child = acceptedChild(facts.children.requireUnique(this.inspectDefinition, { parentRound: 1 }));
      if (facts.children.values().length !== 1 || child.key !== 'inspect' || !isEqual(child.reception.value, output)) throw new Error('Preflight checkpoint differs from accepted inspection');
    },
    resume: { execute: (_work, output) => output },
  });
  readonly checkpoint = { key: 'observer.file-preflight', version: 2, input: preflightInputCodec, output: preflightCodec, points: [this.inspecting, this.result] };
  readonly run = { requires: CheckFileTaskDefinition.requires, uses: this.children, execute: this.execute.bind(this) };

  private async execute(work: PreflightWork): Promise<FilePreflightOutput> {
    const child = work.children.create(this.inspectDefinition, work.input.task, { key: 'inspect' });
    work.checkpoint?.save(this.inspecting, null, { child: child.ref });
    return this.receive(work, child);
  }
  private async receive(work: PreflightWork, child: ChildCall<InspectFileTaskDefinition>): Promise<FilePreflightOutput> {
    await child.run();
    const output = await child.accept((result) => (result.kind === 'ready' ? Object.freeze({ ...result, instruction: work.input.instruction }) : result));
    work.checkpoint?.save(this.result, output, {});
    return output;
  }
}
